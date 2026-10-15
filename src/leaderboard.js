const fs = require('fs')
const path = require('path')

/**
 * WEEKLY leaderboards: what each player earned this week (money earned, levels
 * gained, rebirths, stage Wins). A week runs Monday 00:00 UTC to the next
 * Monday; when it rolls over the boards start empty again. Within a week each
 * stat keeps the player's highest report (weekly totals only grow).
 *
 * - On Boxity Legion, MONGODB_URI is injected (an isolated db for this game):
 *   every pod shares it, so the boards agree across pods. Old weeks expire
 *   automatically (TTL index).
 * - Locally (no MONGODB_URI) a JSON file is used instead.
 */

const STATS = ['money', 'level', 'rebirths', 'wins']
const SUBMIT_INTERVAL_MS = 5_000
const TOP_CACHE_MS = 10_000
const WEEK_MS = 7 * 24 * 3600 * 1000
/** Monday 1 Jan 2024 00:00 UTC - must match the client (formulas.weekIndex). */
const WEEK_EPOCH = Date.UTC(2024, 0, 1)
/** Mongo keeps finished weeks this long, then deletes them. */
const KEEP_SECONDS = 21 * 24 * 3600

const currentWeek = (now = Date.now()) => Math.floor((now - WEEK_EPOCH) / WEEK_MS)
const weekEndsAt = (week) => WEEK_EPOCH + (week + 1) * WEEK_MS

const lastSubmitByIp = new Map()

/** Simple per-IP rate limit for submissions. */
function allow(ip) {
  const now = Date.now()
  const last = lastSubmitByIp.get(ip) || 0
  if (now - last < SUBMIT_INTERVAL_MS) return false
  lastSubmitByIp.set(ip, now)
  if (lastSubmitByIp.size > 10_000) {
    for (const [key, t] of lastSubmitByIp) if (now - t > 60_000) lastSubmitByIp.delete(key)
  }
  return true
}

function cleanName(name) {
  return (
    String(name || 'Player')
      .replace(/[^\p{L}\p{N} _.\-]/gu, '')
      .trim()
      .slice(0, 24) || 'Player'
  )
}

/** Validates a submission into { id, name, week, values } or { error }. */
function parse(body, identity, now = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'Expected a JSON object.' }
  const id = identity?.id || (typeof body.id === 'string' ? body.id.trim().slice(0, 64) : '')
  if (!id) return { error: 'Missing player id.' }
  const week = Number(body.week)
  // Only this week counts; a client whose clock says otherwise is just ignored.
  if (!Number.isInteger(week) || week !== currentWeek(now)) return { error: 'Not the current week.' }
  const values = {}
  for (const stat of STATS) {
    const v = Number(body[stat])
    if (!Number.isFinite(v) || v < 0) return { error: `Invalid ${stat}.` }
    values[stat] = v
  }
  return { id, name: cleanName(identity?.name || body.name), week, values }
}

/* ------------------------------------------------------------- file store */

function fileStore() {
  const file = process.env.LEADERBOARD_FILE || path.join(__dirname, '..', 'data', 'leaderboard.json')
  /** `${week}:${id}` -> { week, name, updatedAt, ...stats } */
  let records = new Map()
  let saveTimer = null
  try {
    records = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).weekly || {}))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[leaderboard] could not read data file, starting empty', err.message)
  }
  const scheduleSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ weekly: Object.fromEntries(records) }))
        fs.renameSync(`${file}.tmp`, file)
      } catch (err) {
        console.error('[leaderboard] save failed', err)
      }
    }, 2_000)
  }
  return {
    kind: 'file',
    async submit({ id, name, week, values }) {
      // Drop finished weeks (keep last week around for a moment).
      for (const [key, r] of records) if (r.week < week - 1) records.delete(key)
      const key = `${week}:${id}`
      const existing = records.get(key)
      const record = { week, name, updatedAt: Date.now() }
      for (const stat of STATS) record[stat] = Math.max(existing?.[stat] || 0, values[stat])
      records.set(key, record)
      scheduleSave()
    },
    async top(limit, week) {
      const all = [...records.values()].filter((r) => r.week === week)
      const out = {}
      for (const stat of STATS) {
        out[stat] = all
          .filter((p) => p[stat] > 0)
          .sort((a, b) => b[stat] - a[stat])
          .slice(0, limit)
          .map((p) => ({ name: p.name, value: p[stat] }))
      }
      return out
    },
  }
}

/* ------------------------------------------------------------ mongo store */

function mongoStore(uri) {
  const { MongoClient } = require('mongodb')
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000 })
  const ready = client.connect().then(async () => {
    const col = client.db().collection('leaderboard_weekly')
    await Promise.all([
      ...STATS.map((stat) => col.createIndex({ week: 1, [stat]: -1 })),
      col.createIndex({ updatedAt: 1 }, { expireAfterSeconds: KEEP_SECONDS }),
    ])
    console.log('[leaderboard] using managed Mongo (weekly)')
    return col
  })
  ready.catch((err) => console.error('[leaderboard] Mongo connection failed', err.message))
  return {
    kind: 'mongo',
    async submit({ id, name, week, values }) {
      const col = await ready
      await col.updateOne(
        { _id: `${week}:${id}` },
        { $set: { name, week, updatedAt: new Date() }, $max: values },
        { upsert: true },
      )
    },
    async top(limit, week) {
      const col = await ready
      const out = {}
      await Promise.all(
        STATS.map(async (stat) => {
          const docs = await col
            .find({ week, [stat]: { $gt: 0 } }, { projection: { name: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(limit)
            .toArray()
          out[stat] = docs.map((d) => ({ name: d.name, value: d[stat] }))
        }),
      )
      return out
    },
    close: () => client.close(),
  }
}

const store = process.env.MONGODB_URI ? mongoStore(process.env.MONGODB_URI) : fileStore()

let topCache = { at: 0, key: '', value: null }

async function submit(body, identity) {
  const parsed = parse(body, identity)
  if (parsed.error) return { ok: false, error: parsed.error }
  await store.submit(parsed)
  return { ok: true }
}

/** This week's boards: { week, endsAt, money: [{ name, value }], level, rebirths, wins }. */
async function top(limit = 10) {
  const week = currentWeek()
  const key = `${week}:${limit}`
  if (topCache.value && topCache.key === key && Date.now() - topCache.at < TOP_CACHE_MS) return topCache.value
  const boards = await store.top(limit, week)
  const value = { week, endsAt: weekEndsAt(week), ...boards }
  topCache = { at: Date.now(), key, value }
  return value
}

module.exports = { allow, submit, top, store, currentWeek, weekEndsAt, parse }
