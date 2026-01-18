import { EnterpriseHotelRoomMappingService } from './EnterpriseHotelRoomMappingService'

describe('EnterpriseHotelRoomMappingService', () => {
  let service: EnterpriseHotelRoomMappingService
  let mockPrisma: any

  beforeEach(() => {
    // Reset mock for each test
    mockPrisma = {
      $transaction: jest.fn((cb) => cb(mockPrisma)),
      hotelMapping: { findFirst: jest.fn() },
      roomMapping: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
      room: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
      roomContentEnrichment: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
      mappingConflict: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    }
    service = new EnterpriseHotelRoomMappingService(mockPrisma)
  })

  describe('mapRoom', () => {
    it('should create a new room and mapping if none exist', async () => {
      // Setup mocks
      mockPrisma.hotelMapping.findFirst.mockResolvedValue({ id: 'hm_1', hotelId: 'h_1' })
      mockPrisma.roomMapping.findFirst.mockResolvedValue(null) // No existing mapping
      mockPrisma.room.findFirst.mockResolvedValue(null) // No existing room by name
      mockPrisma.room.create.mockResolvedValue({ id: 'r_new' })

      const roomData: any = { name: 'Deluxe Suite', photos: [], amenities: [] }
      
      await service.mapRoom('h_src_1', 'r_src_1', 'provider_a', roomData)

      // Verify Room creation
      expect(mockPrisma.room.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          hotelId: 'h_1',
          name: 'Deluxe Suite',
        }),
      })

      // Verify Mapping creation
      expect(mockPrisma.roomMapping.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          roomId: 'r_new',
          hotelMappingId: 'hm_1',
          sourceId: 'r_src_1',
          qualityScore: 20, // 10 for name + 10 for empty arrays/missing fields logic (actually 10 for name only here based on input)
        }),
      })
    })

    it('should skip if parent hotel mapping is missing', async () => {
      mockPrisma.hotelMapping.findFirst.mockResolvedValue(null)
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()

      await service.mapRoom('h_missing', 'r_1', 'provider_a', {} as any)

      expect(mockPrisma.roomMapping.create).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('should detect conflicts when max occupancy differs', async () => {
      // Setup mocks for existing mapping
      mockPrisma.hotelMapping.findFirst.mockResolvedValue({ id: 'hm_1', hotelId: 'h_1' })
      mockPrisma.roomMapping.findFirst.mockResolvedValue({
        id: 'rm_1',
        roomId: 'r_1',
        room: { id: 'r_1', maxOccupancy: 2 }, // Internal room has occupancy 2
      })
      mockPrisma.mappingConflict.findFirst.mockResolvedValue(null) // No existing conflict

      const roomData: any = {
        name: 'Standard Room',
        max_occupancy: 4, // Incoming has 4
        photos: [],
        amenities: []
      }

      await service.mapRoom('h_src_1', 'r_src_1', 'provider_b', roomData)

      expect(mockPrisma.mappingConflict.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityType: 'room',
          entityId: 'r_1',
          fieldName: 'maxOccupancy',
          status: 'open',
          conflictingSources: expect.arrayContaining([
            expect.objectContaining({ source: 'internal', value: 2 }),
            expect.objectContaining({ source: 'provider_b', value: 4 }),
          ])
        })
      })
    })
  })

  describe('getUnifiedRoomData', () => {
    it('should prioritize approved images over original room images', async () => {
      const roomId = 'r_123'
      const originalPhotos = [{ url: 'http://original.com/1.jpg' }]
      const approvedPhotos = [{ url: 'http://approved.com/best.jpg' }]

      mockPrisma.room.findUnique.mockResolvedValue({
        id: roomId,
        name: 'Standard Room',
        photos: originalPhotos,
        mappings: [],
        contentEnrichment: [
          {
            fieldName: 'images',
            quality: 'approved',
            content: approvedPhotos,
          },
          {
            fieldName: 'images',
            quality: 'pending',
            content: [{ url: 'http://pending.com/2.jpg' }],
          },
        ],
      })

      const result = await service.getUnifiedRoomData(roomId)

      expect(result.photos).toEqual(approvedPhotos)
      expect(result.photos[0].url).toBe('http://approved.com/best.jpg')
    })

    it('should fall back to original data if no approved enrichment exists', async () => {
      const roomId = 'r_123'
      mockPrisma.room.findUnique.mockResolvedValue({
        id: roomId,
        photos: [{ url: 'original.jpg' }],
        contentEnrichment: [], // No enrichment
      })

      const result = await service.getUnifiedRoomData(roomId)

      expect(result.photos).toEqual([{ url: 'original.jpg' }])
    })
  })

  describe('resolveConflict', () => {
    it('should update the internal room when applying source resolution', async () => {
      const conflictId = 'conf_1'
      const roomId = 'r_1'
      
      mockPrisma.mappingConflict.findUnique.mockResolvedValue({
        id: conflictId,
        entityType: 'room',
        entityId: roomId,
        fieldName: 'maxOccupancy',
        conflictingSources: [
          { source: 'internal', value: 2 },
          { source: 'provider_b', value: 4 },
        ],
      })

      await service.resolveConflict(conflictId, 'apply_source', 'provider_b')

      // Should update the room
      expect(mockPrisma.room.update).toHaveBeenCalledWith({
        where: { id: roomId },
        data: { maxOccupancy: 4 },
      })

      // Should close the conflict
      expect(mockPrisma.mappingConflict.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: conflictId }, data: { status: 'resolved' } })
      )
    })
  })
})