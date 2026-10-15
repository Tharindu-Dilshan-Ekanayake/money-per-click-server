# +1 Money Per Click — game server

Colyseus server for the web game in `money-per-click-client`, hosted on **Boxity Legion**.

- **Multiplayer lobbies:** room `lobby`, up to **8 players** each. Players see each other
  walk, click (a click counter rides along with movement), emote, chat, hold their cash and
  show off pets and trails. AFK is never shared. The server never sends text for the client
  to show; connection problems are retried silently.
- **One copy per player:** a new session from the same Boxity account (or the same save +
  browser for guests) replaces the older one (close code `4009`, the client doesn't rejoin).
  A dropped connection is hidden from everyone at once and restored if the client
  reconnects within 20 s, so closed or reloaded tabs never leave a frozen copy behind.
- **Weekly leaderboard API:** `GET /api/leaderboard?limit=10` returns this week's boards
  plus `week` and `endsAt`; `POST /api/leaderboard` takes the player's weekly totals and the
  `week` number (Boxity token in `Authorization: Bearer …`; in production only signed-in
  players are ranked). Weeks run Monday 00:00 UTC to Monday; other weeks are rejected, so
  the boards start empty every Monday. Finished weeks expire from Mongo after 21 days.
- **Health:** `GET /health` → `200 ok` (Legion's probes), `GET /api/health` → room count.
- **Deploys drain:** on `SIGTERM` the server locks its rooms, waits a moment, then closes
  them with a server-shutdown code so clients rejoin a fresh pod through the matchmaker.

## Run locally

```bash
npm install
npm run dev          # http://localhost:2567  (ws://localhost:2567 for Colyseus)
```

The client's `.env.development` already points `npm run dev` at this server
(`VITE_API_URL=http://localhost:2567`, `VITE_COLYSEUS_URL=ws://localhost:2567`).
Without `MONGODB_URI` the leaderboard is stored in `data/leaderboard.json`.

## Environment

Legion injects these at deploy time. Locally they are all optional.

| Variable | Use |
| --- | --- |
| `PORT` | Port for HTTP + WebSockets (Legion: 2567). |
| `NODE_ENV` | `production` on Legion: guests are not ranked. |
| `CLIENT_ORIGIN` | Your game site, allowed by CORS (`*.bloxity.io` and `localhost:5173` always are). |
| `MONGODB_URI` | Managed Mongo for this game + channel (leaderboard). |
| `BLOXITY_GAME_ID` | `1-money-per-click`, used to verify Boxity tokens. |
| `BLOXITY_CHANNEL`, `POD_NAME` | Shown in the startup log. |
| `ALLOWED_ORIGINS` | Extra CORS origins, comma-separated (optional). |
| `LEADERBOARD_FILE` | File store path when there is no Mongo (optional). |

## Deploy to Boxity Legion

`.github/workflows/deploy.yml` runs on every push:

| Branch | Channel | Backend URL (HTTP only) |
| --- | --- | --- |
| `dev` | dev | https://1-money-per-click.dev.host.bloxity.io |
| `main` | prod | https://1-money-per-click.host.bloxity.io |

It builds the `Dockerfile`, pushes `ghcr.io/<owner>/1-money-per-click-server:<channel>-<sha>`
and calls the Legion deploy API with `seatCap: 8` (= `maxClients` of the lobby room).

One-time setup:

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   `LEGION_DEPLOY_TOKEN` = your deploy token from My Games (never commit it).
2. Push to `dev` (or `main`). After the first run, open the repo's **Packages →
   1-money-per-click-server → Package settings → Change visibility → Public** so Legion
   can pull the image. Re-run the workflow if the first rollout failed because of this.

Players never connect to the `host.bloxity.io` URLs for multiplayer: the client asks the
Boxity matchmaker (`Legion.SDK.net.resolveEndpoint`) for a seat, so a full pod (8 players)
makes Legion start another one.

## Files

```
src/server.js          Colyseus + Express (CORS, health, leaderboard API), SIGTERM drain
src/rooms/LobbyRoom.js 8-player lobby: move / profile / emote messages, rate limits, reconnection
src/rooms/state.js     Synced state (players map) - @colyseus/schema v5
src/rooms/sanitize.js  Validation of everything clients send
src/auth.js            Boxity game-token verification (cached)
src/leaderboard.js     Mongo or file store, top-N with a short cache
Dockerfile             node:22-alpine, non-root, PORT 2567
```
