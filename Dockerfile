# syntax=docker/dockerfile:1
# HANNAH, self-hosted: the API server and the web app in one container.
#   docker compose up -d        (see docker-compose.yml and docs/DEPLOYMENT.md)

# ---- the web app (client/dist) ----
FROM node:24-bookworm-slim AS client
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client ./
# The site's public address (canonical links, sitemap); empty keeps links relative.
ARG VITE_SITE_URL=""
ENV VITE_SITE_URL=${VITE_SITE_URL} \
    VITE_AVATAR_MODEL_URL=/models/avatar.draco.glb
RUN npm run build

# ---- the server ----
FROM node:24-bookworm-slim AS base

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    HANNAH_SERVE_CLIENT=/app/client/dist

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend Node dependencies first for better layer caching.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Optional Python fallback dependencies. Debian 12's pip refuses system-wide
# installs without --break-system-packages; this container has no other Python users.
COPY backend/requirements*.txt ./backend/
RUN if [ -f backend/requirements.txt ]; then pip3 install --no-cache-dir --break-system-packages -r backend/requirements.txt; fi

COPY server ./server
COPY backend ./backend
COPY shared ./shared
# The web app, served by the server (server/static-client.js).
COPY --from=client /build/client/dist ./client/dist

# Run as the image's unprivileged user; /app/data holds a SQLite database if you use one.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "--prefix", "server", "start"]
