import express, { Request, Response, Router, NextFunction } from 'express'
import { IncomingMessage } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { EnterpriseHotelRoomMappingService } from './EnterpriseHotelRoomMappingService'

export class EnterpriseMappingAPI {
  public router: Router
  private service: EnterpriseHotelRoomMappingService

  // Rate Limiting State
  private rateLimitWindowMs = 15 * 60 * 1000 // 15 minutes
  private rateLimitMax = 100 // Limit each IP to 100 requests per window
  private requestCounts: Map<string, { count: number; startTime: number }> = new Map()

  constructor(service: EnterpriseHotelRoomMappingService) {
    this.service = service
    this.router = express.Router()
    this.initializeRoutes()
  }

  /**
   * Simple in-memory rate limiter middleware.
   */
  private rateLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()

    let record = this.requestCounts.get(ip)
    if (!record) {
      record = { count: 0, startTime: now }
      this.requestCounts.set(ip, record)
    }

    // Reset window if expired
    if (now - record.startTime > this.rateLimitWindowMs) {
      record.count = 0
      record.startTime = now
    }

    if (record.count >= this.rateLimitMax) {
      res.status(429).json({ error: 'Too many requests, please try again later.' })
      return
    }

    record.count++
    next()
  }

  public attachWebSocketServer(wss: WebSocketServer) {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // Verify API Key from Query Params
      const url = new URL(req.url || '', 'http://localhost')
      const apiKey = url.searchParams.get('apiKey')
      const validKey = process.env.ENTERPRISE_API_KEY || 'dev_secret_key'

      if (apiKey !== validKey) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Invalid API Key' }))
        ws.close()
        return
      }

      ws.send(JSON.stringify({ type: 'info', message: 'Connected to Conflict Resolution Stream' }))
    })

    this.service.on('conflict:resolved', (conflict) => {
      const message = JSON.stringify({ type: 'conflict:resolved', data: conflict })
      wss.clients.forEach((client: { readyState: any; send: (arg0: string) => void }) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message)
        }
      })
    })
  }

  private initializeRoutes() {
    // Apply Rate Limiter
    this.router.use(this.rateLimiter)

    // Authentication Middleware
    this.router.use((req: Request, res: Response, next: NextFunction) => {
      const apiKey = req.headers['x-api-key']
      const validKey = process.env.ENTERPRISE_API_KEY || 'dev_secret_key'

      if (apiKey && apiKey === validKey) {
        next()
      } else {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' })
      }
    })

    /**
     * GET /conflicts
     * Retrieve open or resolved conflicts for the dashboard.
     * Query Params: ?status=open|resolved
     */
    this.router.get('/conflicts', async (req: Request, res: Response) => {
      try {
        // Handle potential string[] from query params and validate status value
        const statusParam = req.query.status
        const status = Array.isArray(statusParam)
          ? (statusParam[0] as 'open' | 'resolved' || 'open')
          : (statusParam as 'open' | 'resolved' || 'open')

        // Validate that status is one of the allowed values
        const validStatus = ['open', 'resolved'].includes(status) ? status : 'open'

        const conflicts = await this.service.getConflicts(validStatus)
        res.json({ data: conflicts })
      } catch (error: any) {
        res.status(500).json({ error: error.message })
      }
    })

    /**
     * POST /conflicts/:id/resolve
     * Apply a resolution strategy to a specific conflict.
     * Body: { strategy: 'keep_internal' | 'apply_source', source?: string }
     */
    this.router.post('/conflicts/:id/resolve', async (req: Request, res: Response) => {
      try {
        const { id } = req.params
        const { strategy, source } = req.body

        if (!['keep_internal', 'apply_source'].includes(strategy)) {
          return res.status(400).json({ error: 'Invalid resolution strategy' })
        }

        // Ensure id is a string (req.params can return string | string[])
        const conflictId = Array.isArray(id) ? id[0] : id
        // Ensure source is a string if provided (handle potential string[] from query params)
        const sourceString = Array.isArray(source) ? source[0] : source

        await this.service.resolveConflict(conflictId, strategy, sourceString)
        res.json({ success: true, message: 'Conflict resolved' })
      } catch (error: any) {
        res.status(500).json({ error: error.message })
      }
    })

    /**
     * GET /rooms/:id/unified
     * Get the final, merged view of a room (Internal data + Approved enrichment).
     */
    this.router.get('/rooms/:id/unified', async (req: Request, res: Response) => {
      try {
        const { id } = req.params
        // Ensure id is a string (req.params can return string | string[])
        const roomId = Array.isArray(id) ? id[0] : id
        const data = await this.service.getUnifiedRoomData(roomId)

        if (!data) {
          return res.status(404).json({ error: 'Room not found' })
        }
        res.json({ data })
      } catch (error: any) {
        res.status(500).json({ error: error.message })
      }
    })

    /**
     * POST /recalculate-scores
     * Manually trigger bulk quality score recalculation.
     */
    this.router.post('/recalculate-scores', async (req: Request, res: Response) => {
      try {
        // Trigger in background to avoid blocking the response
        this.service.bulkRecalculateQualityScores()
          .then((count) => console.log(`Manual recalculation finished. Updated ${count} records.`))
          .catch((err) => console.error('Manual recalculation failed', err))
        
        res.json({ message: 'Quality score recalculation started.' })
      } catch (error: any) {
        res.status(500).json({ error: error.message })
      }
    })
  }
}
