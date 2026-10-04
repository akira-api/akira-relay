# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install curl for healthcheck
RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/internal/health || exit 1

CMD ["node", "--max-old-space-size=192", "dist/server.js"]
