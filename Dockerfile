# ================================================
# SILO DISCORD BOT - PRODUCTION DOCKERFILE
# ================================================
# Multi-stage build for minimal image size

# Stage 1: Install dependencies
FROM oven/bun:1.3.5 AS dependencies
WORKDIR /app

ENV YOUTUBE_DL_HOST=https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp

# Copy package files
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/bot/package.json ./packages/bot/

# Install dependencies
# @discordjs/opus 0.10.0's bundled ARM Opus source omits one forward
# declaration that GCC 14 otherwise promotes to an install-stopping error.
# The symbol is compiled in the same library; retain the warning while
# allowing the pinned native module to finish linking on Linux ARM64.
RUN CFLAGS="-Wno-error=implicit-function-declaration" bun install --frozen-lockfile
RUN echo "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  packages/bot/node_modules/youtube-dl-exec/bin/yt-dlp" \
    | sha256sum -c - \
    && packages/bot/node_modules/youtube-dl-exec/bin/yt-dlp --version | grep -Fx "2026.08.19"

# Stage 2: Production image
FROM oven/bun:1.3.5-slim AS production
WORKDIR /app

# Install runtime dependencies for voice (opus)
RUN apt-get update && apt-get install -y \
    libopus0 \
    ffmpeg \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=dependencies /app/packages/bot/node_modules ./packages/bot/node_modules

# Copy source code
COPY packages ./packages
COPY supabase/migrations ./supabase/migrations
COPY tsconfig.json ./

ARG RELEASE_COMMIT=unknown
LABEL org.opencontainers.image.revision="${RELEASE_COMMIT}"

# Set environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --eval "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))" || exit 1

# Run with sharding for production
CMD ["bun", "packages/bot/src/shard.ts"]
