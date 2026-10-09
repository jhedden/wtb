# What The Box? clone — game server + both clients (top-down and 3D) in one image.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# dependencies first so they're cached between code changes (three.js is served to browsers from node_modules)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js game.js shared.js ./
COPY public ./public

# game settings (see README): PORT, BOT_FILL, ROUND_SECONDS, DECOYS_MOVE
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

CMD ["node", "server.js"]
