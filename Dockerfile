# +1 Money Per Click - Colyseus game server, built for Boxity Legion hosting.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Local fallback for the leaderboard when MONGODB_URI is not set (Legion always
# sets it); owned by the non-root user so the server can write it.
RUN mkdir -p /app/data && chown node:node /app/data

# Legion injects PORT (2567). HTTP and WebSockets share this one port.
ENV PORT=2567
EXPOSE 2567

# Legion requires a non-root user; the node image ships one.
USER node

# Exec form: node is PID 1 and receives SIGTERM directly, so the server can drain.
CMD ["node", "src/server.js"]
