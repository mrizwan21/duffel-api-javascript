import * as cron from 'node-cron'
import { EnterpriseHotelRoomMappingService } from '../Stays/EnterpriseHotelRoomMappingService'

// In a real app, import your actual PrismaClient instance
// import { prisma } from '../db'
const mockPrisma = {
  roomMapping: { findMany: async () => [], update: async () => {} },
  $transaction: async (cb: any) => cb(mockPrisma),
} as any

async function startCron() {
  // Initialize service
  const service = new EnterpriseHotelRoomMappingService(mockPrisma)

  console.log('Initializing Quality Score Recalculation Cron Job...')

  // Schedule task to run at 02:00 AM every day
  // Cron format: Minute Hour Day-of-Month Month Day-of-Week
  cron.schedule('0 2 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Starting scheduled quality score recalculation...`)
    try {
      const count = await service.bulkRecalculateQualityScores()
      console.log(`[${new Date().toISOString()}] Completed. Updated ${count} rooms.`)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to recalculate scores:`, error)
    }
  })

  console.log('Cron job scheduled: 0 2 * * * (Daily at 02:00 AM)')
}

// Start the cron if this script is run directly
startCron()