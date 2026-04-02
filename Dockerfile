# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Native build tools required by better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy only the production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# Data directory for the SQLite database volume
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATA_DIR=/data

# Health-check: confirm the process is still running
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD pgrep -f "node index.js" || exit 1

CMD ["node", "index.js"]
