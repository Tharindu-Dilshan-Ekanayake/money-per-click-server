const { CloseCode, Server } = require('@colyseus/core')
const { WebSocketTransport } = require('@colyseus/ws-transport')
const cors = require('cors')
const express = require('express')

const { verifyBoxityToken } = require('./auth')
const leaderboard = require('./leaderboard')
const { LobbyRoom, activeRooms } = require('./rooms/LobbyRoom')

/**
 * +1 Money Per Click game server (Colyseus).
 *
 * Built for Boxity Legion hosting: listens on PORT (Legion injects 2567),
 * answers GET /health fast, and on SIGTERM drains instead of dropping players.
 * HTTP and WebSockets share the one port. Players never connect to this host
 * directly for multiplayer - they come in through the Boxity matchmaker.
 */

const PORT = Number(process.env.PORT) || 2567
const IS_PROD = process.env.NODE_ENV === 'production'

// Your game site (Legion injects CLIENT_ORIGIN), Boxity-hosted frontends, and
// the Vite dev server. Extra origins: ALLOWED_ORIGINS="https://a.io,https://b.io".
const ALLOWED_ORIGINS = new Set(
  [
    process.env.CLIENT_ORIGIN,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(process.env.ALLOWED_ORIGINS || '').split(','),
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean),
)
const BOXITY_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(play\.)?bloxity\.io$/

function corsOrigin(origin, callback) {
  // Same-origin / server-to-server requests have no Origin header.
  if (!origin || ALLOWED_ORIGINS.has(origin) || BOXITY_ORIGIN.test(origin)) callback(null, true)
  else callback(null, false)
}

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function routes(app) {
  app.use(cors({ origin: corsOrigin, credentials: true }))
  app.use(express.json({ limit: '10kb' }))

  // Legion's readiness/liveness probes. Must stay fast.
  app.get('/health', (_req, res) => res.status(200).send('ok'))
  app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: activeRooms.size }))

  /**
   * Leaderboard for the in-world boards. The player is identified by their
   * verified Boxity token; in production guests aren't ranked.
   * (Stats themselves are still reported by the client.)
   */
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10))
      res.json(await leaderboard.top(limit))
    } catch (err) {
      console.error('[leaderboard] read failed', err.message)
      res.status(503).json({ error: 'Leaderboard unavailable' })
    }
  })

  app.post('/api/leaderboard', async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown'
      if (!leaderboard.allow(ip)) return res.status(429).json({ error: 'Too many submissions' })
      const user = await verifyBoxityToken(bearer(req))
      if (!user && IS_PROD) return res.status(401).json({ error: 'Sign in to be ranked' })
      const result = await leaderboard.submit(req.body, user)
      if (!result.ok) return res.status(400).json({ error: result.error })
      return res.json({ ok: true })
    } catch (err) {
      console.error('[leaderboard] write failed', err.message)
      return res.status(503).json({ error: 'Leaderboard unavailable' })
    }
  })

  /** Server-side identity check for the client (Legion.SDK.auth.authenticateWithServer). */
  app.post('/api/legion-auth', async (req, res) => {
    const user = await verifyBoxityToken(req.body?.token || bearer(req))
    if (!user) return res.status(401).json({ error: 'Invalid Boxity token' })
    return res.json({ user: { legionId: user.id, name: user.name } })
  })

  /**
   * Gems purchase webhook (not used yet - no SKUs). Answer 2xx or Boxity refunds.
   * TODO before selling anything: verify x-legion-webhook-secret, record the grant
   * in Mongo keyed by transactionId (any pod may receive it), then apply it.
   */
  app.post('/api/legion-webhook', (req, res) => {
    console.log('[legion-webhook] received', req.body?.transactionId, req.body?.sku)
    res.sendStatus(200)
  })
}

const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: routes,
  // We handle SIGTERM ourselves (drain) - see below.
  gracefullyShutdown: false,
  greet: false,
})

gameServer.define('lobby', LobbyRoom)

/**
 * Zero-downtime deploys: Legion sends SIGTERM and waits up to 10 minutes.
 * Lock every lobby (no new joins here), give the new pod a moment, then close
 * the lobbies with SERVER_SHUTDOWN. Clients treat that as "go back to the
 * matchmaker" and land on the fresh pod. Progress lives on each player's
 * device, so nothing is lost. No message is ever shown to players.
 */
let draining = false
async function drain(signal) {
  if (draining) return
  draining = true
  console.log(`[server] ${signal}: draining ${activeRooms.size} room(s)`)
  await Promise.allSettled([...activeRooms].map((room) => room.lock()))
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await Promise.allSettled([...activeRooms].map((room) => room.disconnect(CloseCode.SERVER_SHUTDOWN)))
  try {
    await leaderboard.store.close?.()
  } catch {
    // Closing on the way out - nothing else to do.
  }
  await gameServer.gracefullyShutdown(true)
}
process.once('SIGTERM', () => drain('SIGTERM'))
process.once('SIGINT', () => drain('SIGINT'))

gameServer.listen(PORT).then(() => {
  console.log(`[server] listening on :${PORT} (${process.env.BLOXITY_CHANNEL || 'local'}${process.env.POD_NAME ? ` / ${process.env.POD_NAME}` : ''})`)
})
