/**
 * Input clean-up for everything a client sends. Never trust the payload shape:
 * every field is type-checked, clamped and length-limited, and anything odd is
 * dropped rather than rejected loudly.
 */

const num = (v, min, max, fallback = min) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const int = (v, min, max, fallback = min) => Math.floor(num(v, min, max, fallback))

/** Letters, numbers, spaces and a few symbols; max 24 chars. */
function cleanName(name) {
  return String(name ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 24)
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/** Position update: returns null when nothing usable was sent. */
function cleanMove(m) {
  if (!m || typeof m !== 'object') return null
  const x = Number(m.x)
  const y = Number(m.y)
  const z = Number(m.z)
  if (![x, y, z].every(Number.isFinite)) return null
  const yaw = Number(m.yaw)
  const out = {
    x: num(x, -2000, 2000),
    y: num(y, -100, 500),
    z: num(z, -2000, 2000),
    yaw: Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw)) : 0,
    speed: num(m.speed, 0, 60, 0),
    grounded: m.grounded !== false,
  }
  // Click counter rides along with movement (one message, not one per click).
  if (m.clicks !== undefined) out.clicks = int(m.clicks, 0, 65535, 0)
  return out
}

const PROPORTION_RANGES = {
  height: [0.5, 1.6],
  shoulderWidth: [0.5, 1.5],
  armLength: [0.05, 3],
  legOffsetX: [-0.7, 5],
  torsoScaleX: [0.3, 2],
  neckHeight: [0.94, 1.2],
  headScale: [0.3, 2.6],
}

function cleanProportions(p) {
  if (!p || typeof p !== 'object') return ''
  const out = {}
  for (const [key, [min, max]] of Object.entries(PROPORTION_RANGES)) {
    if (key in p) out[key] = Math.round(num(p[key], min, max, 1) * 1000) / 1000
  }
  return JSON.stringify(out)
}

/** Equipped cosmetics: only `xxxId` keys with short id-like string values. */
function cleanAvatar(a) {
  if (!a || typeof a !== 'object') return ''
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(a)) {
    if (count >= 30) break
    if (!/^[a-zA-Z]{2,12}Id$/.test(key) || value == null) continue
    const v = String(value)
    if (!ID_RE.test(v)) continue
    out[key] = v
    count += 1
  }
  return JSON.stringify(out)
}

function cleanPets(pets) {
  if (!Array.isArray(pets)) return ''
  return pets
    .slice(0, 8)
    .map((p) => {
      const id = String(p?.id ?? '')
      if (!/^[A-Za-z]{1,24}$/.test(id)) return null
      return `${id}:${int(p?.variant, 0, 2, 0)}`
    })
    .filter(Boolean)
    .join(',')
}

/** Profile fields other players need to draw you. Unknown keys are ignored. */
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null
  const out = {}
  if ('level' in p) out.level = int(p.level, 0, 65535)
  if ('lifetime' in p) out.lifetime = int(p.lifetime, 0, 4294967295)
  if ('rebirths' in p) out.rebirths = int(p.rebirths, 0, 65535)
  if ('cashTier' in p) out.cashTier = int(p.cashTier, 0, 255)
  if ('trail' in p) out.trail = /^[a-z]{1,16}$/.test(String(p.trail)) ? String(p.trail) : 'none'
  if ('pets' in p) out.pets = cleanPets(p.pets)
  if ('avatar' in p) out.avatar = cleanAvatar(p.avatar)
  if ('proportions' in p) out.proportions = cleanProportions(p.proportions)
  if ('name' in p) out.name = cleanName(p.name)
  return out
}

function cleanEmote(id) {
  const v = String(id ?? '')
  return /^[A-Za-z0-9]{1,32}$/.test(v) ? v : null
}

module.exports = { cleanName, cleanMove, cleanProfile, cleanEmote }
