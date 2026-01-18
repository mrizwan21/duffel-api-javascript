import express from 'express'
import http from 'http'
import path from 'path'
import swaggerUi from 'swagger-ui-express'
import YAML from 'yamljs'
import { WebSocketServer } from 'ws'
import { EnterpriseMappingAPI } from '../Stays/EnterpriseMappingAPI'
import { EnterpriseHotelRoomMappingService } from '../Stays/EnterpriseHotelRoomMappingService'

// In production, import { PrismaClient } from '@prisma/client'
// const prisma = new PrismaClient()

// Mock Prisma for demonstration purposes
const mockPrisma = {
  roomMapping: { findMany: async () => [], update: async () => {} },
  mappingConflict: { findMany: async () => [], findUnique: async () => null, update: async () => {} },
  room: { findUnique: async () => null, update: async () => {} },
  $transaction: async (cb: any) => cb(mockPrisma),
} as any

async function startServer() {
  const app = express()
  const server = http.createServer(app)
  const port = process.env.PORT || 3000

  // Middleware to parse JSON bodies
  app.use(express.json())

  // Initialize Service
  const mappingService = new EnterpriseHotelRoomMappingService(mockPrisma)
  
  // Initialize API Router
  const enterpriseApi = new EnterpriseMappingAPI(mappingService)

  // Mount the router
  app.use('/api/enterprise', enterpriseApi.router)

  // Initialize WebSocket Server
  const wss = new WebSocketServer({ server, path: '/ws/conflicts' })
  enterpriseApi.attachWebSocketServer(wss)

  // Serve Swagger UI
  const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml'))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument))

  // Health check endpoint
  app.get('/health', (res: { json: (arg0: { status: string; timestamp: Date }) => void }) => {
    res.json({ status: 'ok', timestamp: new Date() })
  })

  server.listen(port, () => {
    console.log(`Enterprise Mapping API server running on port ${port}`)
  })
}

startServer()
