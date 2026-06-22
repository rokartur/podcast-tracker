# syntax=docker/dockerfile:1

# =============================================================================
# podcast-tracker — multi-stage build
#
# Targets:
#   runner   (default) — minimal Next.js standalone server. `docker build` / app.
#   migrator           — has drizzle-kit + tsx + source to run `db:push`.
#
# Build the app:      docker build -t podcast-tracker .
# Build the migrator: docker build --target migrator -t podcast-tracker-migrate .
# (docker-compose.yml wires both together with Postgres.)
# =============================================================================

ARG NODE_VERSION=22-bookworm-slim

# ----------------------------------------------------------------------------
# deps — install ALL dependencies (incl. dev) against the lockfile, once.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Only the manifests, so this layer caches until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

# ----------------------------------------------------------------------------
# builder — compile the Next.js app into a standalone server bundle.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Only NEXT_PUBLIC_* values are inlined at build time. The single one this app
# reads (NEXT_PUBLIC_BETTER_AUTH_URL) is optional; expose it as a build arg for
# the rare cross-origin auth setup. Everything else is read at RUNTIME.
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_BETTER_AUTH_URL=${NEXT_PUBLIC_BETTER_AUTH_URL}
RUN npm run build

# ----------------------------------------------------------------------------
# migrator — applies the Drizzle schema to Postgres (`npm run db:push`).
# Reuses the full dev dependency tree + source; not the app runtime.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "db:push"]

# ----------------------------------------------------------------------------
# runner — final, minimal production image.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # CloakBrowser caches its native Chromium here; mount a volume to persist it.
    CLOAKBROWSER_CACHE_DIR=/home/nextjs/.cloakbrowser \
    # Persistent X (Twitter) login profile for the optional reach scraper.
    REACH_BROWSER_PROFILE=/home/nextjs/cloak-profile

# Shared libraries the optional CloakBrowser/Chromium reach scraper needs at
# runtime (the "Refresh numbers" feature). Harmless if that feature is unused;
# drop this block to shave the image if you never scrape X/YouTube counts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
      libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user (also required so Chromium will start).
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home /home/nextjs --create-home nextjs \
    && mkdir -p "$CLOAKBROWSER_CACHE_DIR" "$REACH_BROWSER_PROFILE" \
    && chown -R nextjs:nodejs /home/nextjs

# Standalone output: server.js + only the node_modules it traced. `public` and
# `.next/static` are NOT copied by standalone automatically — add them by hand.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# No curl/wget in the runtime; Node 22 has global fetch. /login is public.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# instrumentation.ts starts the in-app daily-scan scheduler when this boots.
CMD ["node", "server.js"]
