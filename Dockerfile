# ================================================
# SILO DISCORD BOT - PRODUCTION DOCKERFILE
# ================================================
# Multi-stage build for minimal image size

# Stage 1: Install dependencies
FROM oven/bun:1 AS dependencies
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/bot/package.json ./packages/bot/

# Install dependencies
RUN bun install --frozen-lockfile

# Stage 2: Production image
FROM oven/bun:1-slim AS production
WORKDIR /app

# Install runtime dependencies for voice (opus)
RUN apt-get update && apt-get install -y \
    libopus0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=dependencies /app/packages/bot/node_modules ./packages/bot/node_modules

# Copy source code
COPY packages ./packages
COPY tsconfig.json ./

# Set environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --eval "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))" || exit 1

# Run with sharding for production
CMD ["bun", "packages/bot/src/shard.ts"]
