const { Room } = require('@colyseus/core')

const { verifyBoxityToken } = require('../auth')
const { cleanEmote, cleanMove, cleanName, cleanProfile } = require('./sanitize')
const { PlayerState, createLobbyState } = require('./state')

/** Players per lobby. Keep equal to the Legion deploy's seatCap. */
const MAX_PLAYERS = 8
/** Minimum ms between messages of each kind per client (extra ones are dropped). */
const RATE_MS = { move: 40, profile: 400, emote: 300, auth: 2000 }
const RECONNECT_SECONDS = 20
/**
 * Close code sent to an older session when the same player joins again (a
 * second tab, a reload, another device). The client must not rejoin on it.
 */
const CLOSE_DUPLICATE = 4009

/** Live lobby instances on this pod, so a SIGTERM can drain them. */
const activeRooms = new Set()
/** client -> { kind: last message ms } */
const lastMessage = new WeakMap()

function applyFields(player, fields) {
  for (const [key, value] of Object.entries(fields)) player[key] = value
}

/** Plain copy of a player's fields, to rebuild them after a reconnection. */
function snapshot(player) {
  const out = {}
  for (const key of Object.keys(player.toJSON())) out[key] = player[key]
  return out
}

/**
 * Who this player is, for spotting duplicates: the verified Boxity user, or
 * else the client's own key (a hash of its save slot + browser).
 */
function playerKey(user, options) {
  if (user?.id) return `u:${user.id}`
  const key = String(options?.clientKey ?? '')
  return /^[a-f0-9]{8,64}$/.test(key) ? `g:${key}` : ''
}

/**
 * A lobby of up to 8 players sharing the world. Each client owns its own
 * progress; the room relays presence so everyone sees everyone. It never sends
 * chat/system messages to clients - only state.
 */
class LobbyRoom extends Room {
  onCreate() {
    this.maxClients = MAX_PLAYERS
    // ~15 updates/s is smooth with client-side interpolation.
    this.patchRate = 66
    this.setState(createLobbyState())
    activeRooms.add(this)
    /** sessionId -> { fields, key, reconnection } for players whose connection dropped. */
    this.dropped = new Map()

    this.onMessage('move', (client, message) => {
      if (!this.allow(client, 'move')) return
      const player = this.state.players.get(client.sessionId)
      const move = cleanMove(message)
      if (player && move) applyFields(player, move)
    })

    this.onMessage('profile', (client, message) => {
      if (!this.allow(client, 'profile')) return
      const player = this.state.players.get(client.sessionId)
      const profile = cleanProfile(message)
      if (!player || !profile) return
      // Verified players keep their Boxity name.
      if (player.userId) delete profile.name
      else if (!profile.name) delete profile.name
      applyFields(player, profile)
    })

    this.onMessage('emote', (client, message) => {
      if (!this.allow(client, 'emote')) return
      const player = this.state.players.get(client.sessionId)
      const id = cleanEmote(message?.id)
      if (!player || !id) return
      player.emote = id
      player.emoteSeq = (player.emoteSeq + 1) % 65536
    })

    this.onMessage('emoteStop', (client) => {
      const player = this.state.players.get(client.sessionId)
      if (player) player.emote = ''
    })

    // Signing in mid-game: re-verify without leaving the room.
    this.onMessage('auth', async (client, message) => {
      if (!this.allow(client, 'auth')) return
      const user = await verifyBoxityToken(message?.token)
      const player = this.state.players.get(client.sessionId)
      if (!player || !user) return
      player.userId = user.id
      player.name = cleanName(user.name) || player.name
    })

    // Unknown message types are ignored silently.
    this.onMessage('*', () => {})
  }

  /** Per-client rate limit by message kind. */
  allow(client, kind) {
    const now = Date.now()
    let times = lastMessage.get(client)
    if (!times) {
      times = {}
      lastMessage.set(client, times)
    }
    if (now - (times[kind] || 0) < RATE_MS[kind]) return false
    times[kind] = now
    return true
  }

  async onAuth(client, options) {
    // Guests are welcome: a missing or invalid token just means "not verified".
    const user = await verifyBoxityToken(options?.token)
    return { user }
  }

  onJoin(client, options) {
    const user = client.auth?.user || null
    // One copy of each player: a newer session replaces any older one on this pod.
    const key = playerKey(user, options)
    client.userData = { key, replaced: false }
    if (key) for (const room of activeRooms) room.removeDuplicates(key, client.sessionId)

    const player = new PlayerState()
    applyFields(player, {
      userId: user?.id || '',
      name: cleanName(user?.name) || cleanName(options?.name) || 'Guest',
      x: 0,
      y: 1.4,
      z: 4,
      yaw: Math.PI,
      speed: 0,
      grounded: true,
      level: 0,
      lifetime: 0,
      rebirths: 0,
      cashTier: 0,
      trail: 'none',
      pets: '',
      avatar: '',
      proportions: '',
      emote: '',
      emoteSeq: 0,
      clicks: 0,
    })
    const move = cleanMove(options?.spawn)
    if (move) applyFields(player, move)
    const profile = cleanProfile(options?.profile)
    if (profile) {
      if (user) delete profile.name
      else if (!profile.name) delete profile.name
      applyFields(player, profile)
    }
    this.state.players.set(client.sessionId, player)
  }

  /** Kicks every other session of the same player (connected or reconnecting). */
  removeDuplicates(key, keepSessionId) {
    for (const other of this.clients) {
      if (other.sessionId === keepSessionId || other.userData?.key !== key) continue
      other.userData.replaced = true
      this.state.players.delete(other.sessionId)
      other.leave(CLOSE_DUPLICATE)
    }
    for (const [sessionId, entry] of this.dropped) {
      if (sessionId === keepSessionId || entry.key !== key) continue
      this.dropped.delete(sessionId)
      entry.reconnection?.reject?.(false)
    }
  }

  async onDrop(client) {
    const player = this.state.players.get(client.sessionId)
    // Hide the player at once: a closed or reloaded tab must never leave a
    // frozen copy standing in the lobby. A real network blip (the client SDK
    // reconnects by itself) brings them back in onReconnect.
    this.state.players.delete(client.sessionId)
    if (!player || client.userData?.replaced) return
    const reconnection = this.allowReconnection(client, RECONNECT_SECONDS)
    this.dropped.set(client.sessionId, { fields: snapshot(player), key: client.userData?.key || '', reconnection })
    try {
      await reconnection
    } catch {
      // Didn't come back in time (or joined again elsewhere): onLeave cleans up.
    }
  }

  onReconnect(client) {
    const entry = this.dropped.get(client.sessionId)
    this.dropped.delete(client.sessionId)
    if (!entry) return
    const player = new PlayerState()
    applyFields(player, entry.fields)
    this.state.players.set(client.sessionId, player)
  }

  onLeave(client) {
    this.dropped.delete(client.sessionId)
    this.state.players.delete(client.sessionId)
  }

  onDispose() {
    activeRooms.delete(this)
  }
}

module.exports = { LobbyRoom, activeRooms, MAX_PLAYERS, CLOSE_DUPLICATE }
