import { EnterpriseHotelRoomMappingService } from '../Stays/EnterpriseHotelRoomMappingService'

/**
 * Mock Prisma Client for demonstration.
 * In production: import { PrismaClient } from '@prisma/client'
 */
const mockPrisma = {
  roomMapping: {
    findMany: async () => [
      {
        id: 'rm_1',
        qualityScore: 0, // Old score
        sourceData: { name: 'Deluxe Room', photos: [{ url: 'http://example.com/1.jpg' }] },
      },
      {
        id: 'rm_2',
        qualityScore: 30, // Already correct (10 name + 20 photos)
        sourceData: { name: 'Standard Room', photos: [{ url: 'http://example.com/2.jpg' }] },
      },
    ],
    update: async (args: any) => {
      console.log(`  [DB] Updated Mapping ${args.where.id} -> New Score: ${args.data.qualityScore}`)
    },
  },
  $transaction: async (cb: any) => cb(mockPrisma),
}

async function main() {
  console.log('Starting bulk quality score recalculation...')

  // Instantiate service
  const service = new EnterpriseHotelRoomMappingService(mockPrisma)

  try {
    const count = await service.bulkRecalculateQualityScores()
    console.log(`\nRecalculation complete. Updated ${count} records.`)
  } catch (error) {
    console.error('Recalculation failed:', error)
  }
}

main()