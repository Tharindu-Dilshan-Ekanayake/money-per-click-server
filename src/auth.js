/**
 * Boxity identity verification. A client sends its Boxity token
 * (Legion.SDK.auth.getToken()); we ask Boxity whether it's valid for this game
 * and trust only the user it returns. Guests (no/invalid token) still play,
 * they just aren't treated as a verified account.
 */

const VERIFY_URL = `${process.env.BLOXITY_API_URL || 'https://api.bloxity.io'}/v1/auth/game-token/verify`
const GAME_SLUG = process.env.BLOXITY_GAME_SLUG || process.env.BLOXITY_GAME_ID || '1-money-per-click'
const CACHE_MS = 10 * 60 * 1000
const MAX_CACHE = 5000

/** token -> { user|null, expires } */
const cache = new Map()

async function verifyBoxityToken(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return null
  const hit = cache.get(token)
  if (hit && hit.expires > Date.now()) return hit.user

  let user = null
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const body = await res.json()
      const u = body?.valid ? body.user : null
      if (u && (u._id || u.id)) {
        user = { id: String(u._id || u.id), name: String(u.displayName || u.username || 'Player') }
      }
    }
  } catch (err) {
    console.warn('[auth] Boxity verify failed:', err.message)
    // Don't cache network failures - retry next time.
    return null
  }

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  cache.set(token, { user, expires: Date.now() + CACHE_MS })
  return user
}

module.exports = { verifyBoxityToken }
