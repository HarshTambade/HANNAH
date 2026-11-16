# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend Node dependencies first for better layer caching.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts

# Optional Python fallback dependencies.
COPY backend/requirements*.txt ./backend/
RUN if [ -f backend/requirements.txt ]; then pip3 install --no-cache-dir -r backend/requirements.txt; fi

COPY server ./server
COPY backend ./backend
COPY shared ./shared

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "--prefix", "server", "start"]
```<|end|><|start|>asset<|channel|>analysis<|message|>Create docker-compose.yml for backend self-hosting.<|end|><|start|>Assistant to=write<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
/Users/harshtambade/Development/Shanaya - AI companion /docker-compose.yml