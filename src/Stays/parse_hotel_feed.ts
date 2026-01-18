import fs from 'fs'
import path from 'path'
import { HotelRoomFeedParser } from '../Stays/RoomFeedParser'
import { StaysRoom } from '../Stays/StaysTypes'
import { EnterpriseHotelRoomMappingService } from '../Stays/EnterpriseHotelRoomMappingService'

/**
 * Mock Prisma Client to simulate database operations for this script.
 * In a real environment, you would import the generated PrismaClient.
 */
const mockPrisma = {
  $transaction: async (callback: (tx: any) => Promise<any>) => {
    // Simply execute the callback with this mock client
    return callback(mockPrisma)
  },
  hotelMapping: {
    findFirst: async ({ where }: any) => {
      // Simulate finding a parent hotel mapping for any sourceId provided
      if (where.sourceId) {
        return { id: 'hm_mock_123', hotelId: 'htl_mock_parent_id' }
      }
      return null
    },
  },
  roomMapping: {
    findFirst: async () => null, // Simulate that the room is new (not mapped yet)
    create: async (args: any) => {
      console.log(`  [DB] Created RoomMapping for SourceID: ${args.data.sourceId}`)
      return { id: 'rm_new_123' }
    },
    update: async () => ({}),
  },
  room: {
    findFirst: async () => null, // Simulate that the internal room doesn't exist
    create: async (args: any) => {
      console.log(`  [DB] Created Internal Room: "${args.data.name}"`)
      return { id: 'rm_int_123' }
    },
  },
  roomContentEnrichment: {
    findFirst: async () => null,
    create: async () => {},
    update: async () => {},
  },
}

/**
 * Usage: ts-node src/scripts/parse_hotel_feed.ts <path-to-xml-file>
 */

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Error: Please provide a path to an XML file.')
    console.log('Usage: ts-node src/scripts/parse_hotel_feed.ts <path-to-xml-file>')
    process.exit(1)
  }

  const absolutePath = path.resolve(filePath)
  if (!fs.existsSync(absolutePath)) {
    console.error(`Error: File not found at ${absolutePath}`)
    process.exit(1)
  }

  console.log(`Starting parse of ${absolutePath}...`)
  const stream = fs.createReadStream(absolutePath)
  const parser = new HotelRoomFeedParser(stream)
  
  // Instantiate the service with the mock client
  const mappingService = new EnterpriseHotelRoomMappingService(mockPrisma)

  let roomCount = 0
  const rooms: Array<{ id?: string; room: StaysRoom }> = []

  try {
    await parser.parse(async (room, sourceId, hotelId) => {
      roomCount++
      
      if (sourceId && hotelId) {
        await mappingService.mapRoom(
          hotelId,
          sourceId,
          'xml_feed_provider', // Example source name
          room,
          { confidence: 0.9, isPrimary: true }
        )
      }
      
      rooms.push({
        id: sourceId || 'UNKNOWN_ID',
        room: {
          name: room.name,
          max_occupancy: room.max_occupancy,
          rates_count: room.rates.length,
          // We map a subset for display to avoid console clutter
          amenities_count: room.amenities?.length,
        } as any
      })

      if (roomCount % 100 === 0) {
        console.log(`Processed ${roomCount} rooms...`)
      }
    })

    console.log('\n--- Parsing Complete ---')
    console.log(`Total Rooms Found: ${roomCount}`)
    console.log('Sample Output (First 3 rooms):')
    console.log(JSON.stringify(rooms.slice(0, 3), null, 2))

  } catch (error) {
    console.error('Parsing failed:', error)
  }
}

main()