# Multi-stage Dockerfile for Acta Personal Calendar (Server + Web Static Assets)
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Native build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.base.json pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm install

COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN npm run build --workspace=@acta/core && \
    npm run build --workspace=@acta/web && \
    npm run build --workspace=@acta/server

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV PORT=3080
ENV DB_PATH=/app/data/calendar.db
ENV BACKUP_DIR=/app/data/backups
ENV STATIC_DIR=/app/apps/web/dist

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data/backups

EXPOSE 3080

CMD ["node", "apps/server/dist/index.js"]
