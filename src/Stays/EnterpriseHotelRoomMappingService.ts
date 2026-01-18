import { EventEmitter } from 'events'
import { StaysRoom } from './StaysTypes'

// Placeholder for the Prisma Client type to avoid dependency issues if @prisma/client is not installed in this package.
// In your actual integration, import { PrismaClient } from '@prisma/client'
type PrismaClient = any
type PrismaTransaction = any

export interface RoomMappingOptions {
  /**
   * Confidence score of the mapping (0.0 - 1.0)
   */
  confidence?: number
  /**
   * Type of mapping
   */
  mappingType?: 'automatic' | 'manual' | 'verified'
  /**
   * Whether this is the primary source for this room
   */
  isPrimary?: boolean
}

export class EnterpriseHotelRoomMappingService extends EventEmitter {
  private prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    super()
    this.prisma = prisma
  }

  /**
   * Maps a parsed room from a supplier feed to the internal database.
   *
   * Operations:
   * 1. Finds the parent HotelMapping using `hotelSourceId`.
   * 2. Checks for an existing RoomMapping.
   * 3. If new, attempts to match an existing Room by name or creates a new Room entity.
   * 4. Upserts the RoomMapping with full `sourceData`.
   * 5. Enriches content (images, amenities).
   */
  async mapRoom(
    hotelSourceId: string,
    roomSourceId: string,
    source: string,
    roomData: StaysRoom,
    options: RoomMappingOptions = {}
  ): Promise<void> {
    const { confidence = 0.8, mappingType = 'automatic', isPrimary = false } = options
    const qualityScore = this.calculateQualityScore(roomData)

    // Use a transaction to ensure data consistency
    await this.prisma.$transaction(async (tx: PrismaTransaction) => {
      // 1. Find Parent Hotel Mapping
      // We need to know which internal Hotel this room belongs to.
      const hotelMapping = await tx.hotelMapping.findFirst({
        where: {
          source,
          sourceId: hotelSourceId,
        },
        select: { hotelId: true, id: true },
      })

      if (!hotelMapping) {
        console.warn(
          `[RoomMapping] Parent hotel mapping not found for source=${source} hotelId=${hotelSourceId}. Skipping room ${roomSourceId}.`
        )
        return
      }

      // 2. Check for existing Room Mapping
      const existingMapping = await tx.roomMapping.findFirst({
        where: {
          source,
          sourceId: roomSourceId,
          hotelMappingId: hotelMapping.id,
        },
        include: { room: true },
      })

      let roomId: string
      let currentRoom: any = null

      if (existingMapping) {
        // Update existing mapping
        roomId = existingMapping.roomId
        currentRoom = existingMapping.room
        await tx.roomMapping.update({
          where: { id: existingMapping.id },
          data: {
            sourceData: roomData as any,
            lastSyncedAt: new Date(),
            qualityScore,
            // Only update confidence/type if the existing one is not 'verified'
            // This prevents automatic updates from overwriting manual work
            ...(existingMapping.mappingType !== 'verified'
              ? { confidence, mappingType }
              : {}),
          },
        })
      } else {
        // 3. New Mapping - Need to find or create an internal Room
        // Heuristic: Try to find a room in this hotel with the exact same name
        const existingRoom = await tx.room.findFirst({
          where: {
            hotelId: hotelMapping.hotelId,
            name: roomData.name,
          },
        })

        if (existingRoom) {
          roomId = existingRoom.id
          currentRoom = existingRoom
        } else {
          // Create new internal Room
          const newRoom = await tx.room.create({
            data: {
              hotelId: hotelMapping.hotelId,
              name: roomData.name,
              // Use class or view as description fallback
              description: [roomData.attributes?.class, roomData.attributes?.view]
                .filter(Boolean)
                .join(', ') || null,
              maxOccupancy: roomData.max_occupancy || 2,
            },
          })
          roomId = newRoom.id
          currentRoom = newRoom
        }

        // Create Room Mapping
        await tx.roomMapping.create({
          data: {
            roomId,
            hotelMappingId: hotelMapping.id,
            source,
            sourceId: roomSourceId,
            sourceData: roomData as any,
            confidence,
            mappingType,
            isPrimary,
            lastSyncedAt: new Date(),
            qualityScore,
          },
        })
      }

      // 3.5 Conflict Detection
      if (currentRoom) {
        await this.detectAndRecordConflicts(tx, currentRoom, source, roomData)
      }

      // 4. Content Enrichment (Images & Amenities)
      // We store these separately to allow for merging logic later
      if (roomData.photos && roomData.photos.length > 0) {
        await this.upsertRoomEnrichment(tx, roomId, source, 'images', roomData.photos)
      }

      if (roomData.amenities && roomData.amenities.length > 0) {
        await this.upsertRoomEnrichment(tx, roomId, source, 'amenities', roomData.amenities)
      }
    })
  }

  /**
   * Public method to enrich room content manually or from other sources.
   */
  async enrichRoomContent(
    roomId: string,
    items: Array<{
      fieldName: string
      content: any
      source: string
      quality?: string
    }>
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: PrismaTransaction) => {
      for (const item of items) {
        await this.upsertRoomEnrichment(
          tx,
          roomId,
          item.source,
          item.fieldName,
          item.content,
          item.quality
        )
      }
    })
  }

  /**
   * Retrieves unified room data, merging content from multiple sources based on quality/confidence.
   */
  async getUnifiedRoomData(roomId: string): Promise<any> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        mappings: true,
        contentEnrichment: true,
      },
    })

    if (!room) return null

    // Basic merge logic
    const unified = { ...room }

    // Merge images: prefer 'approved' quality
    const imageEnrichment = room.contentEnrichment.find(
      (e: any) => e.fieldName === 'images' && e.quality === 'approved'
    )
    if (imageEnrichment) {
      unified.photos = imageEnrichment.content
    }

    return unified
  }

  /**
   * Retrieves conflicts filtered by status.
   * Useful for a dashboard API.
   */
  async getConflicts(status: 'open' | 'resolved' = 'open'): Promise<any[]> {
    return this.prisma.mappingConflict.findMany({
      where: { status },
      orderBy: { detectedAt: 'desc' },
    })
  }

  /**
   * Resolves a conflict by applying a specific value or dismissing it.
   */
  async resolveConflict(
    conflictId: string,
    resolutionStrategy: 'keep_internal' | 'apply_source',
    sourceToApply?: string
  ): Promise<void> {
    let resolvedConflict

    await this.prisma.$transaction(async (tx: PrismaTransaction) => {
      const conflict = await tx.mappingConflict.findUnique({
        where: { id: conflictId },
      })

      if (!conflict) throw new Error('Conflict not found')

      if (resolutionStrategy === 'apply_source' && sourceToApply) {
        // Find the value from the conflicting sources
        const sourceEntry = (conflict.conflictingSources as any[]).find(
          (s: any) => s.source === sourceToApply
        )

        if (!sourceEntry) throw new Error(`Source ${sourceToApply} not found in conflict`)

        // Update the internal entity
        if (conflict.entityType === 'room') {
          await tx.room.update({
            where: { id: conflict.entityId },
            data: { [conflict.fieldName]: sourceEntry.value },
          })
        }
      }

      // Mark conflict as resolved
      resolvedConflict = await tx.mappingConflict.update({
        where: { id: conflictId },
        data: {
          status: 'resolved',
          resolution: resolutionStrategy,
          resolvedAt: new Date(),
        },
      })
    })

    if (resolvedConflict) {
      this.emit('conflict:resolved', resolvedConflict)
    }
  }

  /**
   * Iterates through all room mappings and updates their quality score.
   * Useful for backfilling after logic changes.
   */
  async bulkRecalculateQualityScores(): Promise<number> {
    let updatedCount = 0
    // Note: In production, use cursor-based pagination for large datasets
    const mappings = await this.prisma.roomMapping.findMany({
      select: { id: true, sourceData: true, qualityScore: true },
    })

    for (const mapping of mappings) {
      if (mapping.sourceData) {
        const newScore = this.calculateQualityScore(mapping.sourceData as StaysRoom)
        if (newScore !== mapping.qualityScore) {
          await this.prisma.roomMapping.update({
            where: { id: mapping.id },
            data: { qualityScore: newScore },
          })
          updatedCount++
        }
      }
    }
    return updatedCount
  }

  private async upsertRoomEnrichment(
    tx: PrismaTransaction,
    roomId: string,
    source: string,
    fieldName: string,
    content: any,
    quality: string = 'pending'
  ) {
    const existing = await tx.roomContentEnrichment.findFirst({
      where: { roomId, source, fieldName },
    })

    if (existing) {
      await tx.roomContentEnrichment.update({
        where: { id: existing.id },
        data: { content, enrichedAt: new Date(), quality },
      })
    } else {
      await tx.roomContentEnrichment.create({
        data: {
          roomId,
          source,
          fieldName,
          content,
          quality,
        },
      })
    }
  }

  private calculateQualityScore(room: StaysRoom): number {
    let score = 0
    if (room.name) score += 10
    if (room.max_occupancy) score += 10
    if (room.beds && room.beds.length > 0) score += 20
    if (room.photos && room.photos.length > 0) score += 20
    if (room.amenities && room.amenities.length > 0) score += 20
    if (room.attributes && (room.attributes.class || room.attributes.view)) score += 10
    if (room.rates && room.rates.length > 0) score += 10
    return Math.min(score, 100)
  }

  private async detectAndRecordConflicts(
    tx: PrismaTransaction,
    internalRoom: any,
    source: string,
    incomingData: StaysRoom
  ) {
    // Check Max Occupancy Conflict
    if (
      internalRoom.maxOccupancy &&
      incomingData.max_occupancy &&
      internalRoom.maxOccupancy !== incomingData.max_occupancy
    ) {
      await this.upsertConflict(
        tx,
        'room',
        internalRoom.id,
        'maxOccupancy',
        source,
        incomingData.max_occupancy,
        internalRoom.maxOccupancy
      )
    }
  }

  private async upsertConflict(
    tx: PrismaTransaction,
    entityType: string,
    entityId: string,
    fieldName: string,
    source: string,
    newValue: any,
    currentValue: any
  ) {
    // Check if an open conflict already exists for this entity/field
    const existing = await tx.mappingConflict.findFirst({
      where: { entityType, entityId, fieldName, status: 'open' },
    })

    const conflictEntry = { source, value: newValue, detectedAt: new Date() }

    if (existing) {
      const sources = (existing.conflictingSources as any[]) || []
      // Update or append the source entry
      const sourceIndex = sources.findIndex((s: any) => s.source === source)
      if (sourceIndex >= 0) {
        sources[sourceIndex] = conflictEntry
      } else {
        sources.push(conflictEntry)
      }

      await tx.mappingConflict.update({
        where: { id: existing.id },
        data: { conflictingSources: sources },
      })
    } else {
      await tx.mappingConflict.create({
        data: {
          entityType,
          entityId,
          fieldName,
          conflictingSources: [
            { source: 'internal', value: currentValue, detectedAt: new Date() },
            conflictEntry,
          ],
          status: 'open',
        },
      })
    }
  }
}