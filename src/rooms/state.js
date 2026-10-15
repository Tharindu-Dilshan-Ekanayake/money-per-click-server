const { MapSchema, schema, t } = require('@colyseus/schema')

/**
 * One player in a lobby, as every other player in the room sees them.
 * Position is the physics capsule centre in world units.
 *
 * Progress itself (money, upgrades, ...) stays on the player's own device; the
 * server only shares what others need to draw you: where you are, how big your
 * body is, your title/level, held cash, trail, pets, avatar and emotes.
 */
const PlayerState = schema(
  {
    userId: t.string().default(''),
    name: t.string().default('Guest'),
    x: t.float32().default(0),
    y: t.float32().default(1.4),
    z: t.float32().default(4),
    yaw: t.float32().default(Math.PI),
    speed: t.float32().default(0),
    grounded: t.boolean().default(true),
    level: t.uint16().default(0),
    lifetime: t.uint32().default(0),
    rebirths: t.uint16().default(0),
    cashTier: t.uint8().default(0),
    trail: t.string().default('none'),
    /** "petId:variant,petId:variant" for the equipped pets. */
    pets: t.string().default(''),
    /** JSON of the Boxity equipped-cosmetics ids. */
    avatar: t.string().default(''),
    /** JSON of the Boxity body proportions. */
    proportions: t.string().default(''),
    /** Emote catalogue id being played ('' = none); seq bumps on every play. */
    emote: t.string().default(''),
    emoteSeq: t.uint16().default(0),
    /** Counts this player's clicks (wraps at 65536): others play their click action. */
    clicks: t.uint16().default(0),
  },
  'PlayerState',
)

const LobbyState = schema(
  {
    players: t.map(PlayerState),
  },
  'LobbyState',
)

function createLobbyState() {
  const state = new LobbyState()
  if (!state.players) state.players = new MapSchema()
  return state
}

module.exports = { PlayerState, LobbyState, createLobbyState }
