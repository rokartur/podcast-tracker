# syntax=docker/dockerfile:1

# =============================================================================
# podcast-tracker — multi-stage build, lean by default.
#
# Final image = Alpine + Node + only the standalone server (no dev deps, no
# Chromium). Tiny. The optional X/YouTube "reach" scraper needs Chromium, so it
# lives in a separate, heavier target you opt into.
#
# Targets:
#   runner       (default) — Alpine. Minimal app. ~150 MB.
#   runner-reach           — Debian slim + Chromium libs for the reach scraper.
#   migrator               — runs `npm run db:push`.
#
#   docker build -t podcast-tracker .                          # lean app
#   docker build --target runner-reach -t podcast-tracker .    # + reach scraper
#   docker build --target migrator -t podcast-tracker-migrate .
# =============================================================================

ARG NODE_VERSION=22

# ----------------------------------------------------------------------------
# deps — install ALL deps (incl. dev) against the lockfile, once. Cached layer.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js SWC/Turbopack native binaries link against glibc symbols on musl.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ----------------------------------------------------------------------------
# builder — compile Next.js into a standalone server bundle.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Only NEXT_PUBLIC_* are inlined at build time; the one this app reads is
# optional (cross-origin auth only). Everything real is read at RUNTIME.
ARG NEXT_PUBLIC_BETTER_AUTH_URL
# Some route modules import the DB/auth clients at module load (e.g.
# /api/cron/scrape), whose constructors throw if these are unset — so they must
# EXIST during build. They are throwaway placeholders set ONLY for this RUN (not
# persisted as image ENV): postgres-js connects lazily so the DB is never hit,
# and the builder stage is never shipped. Real values come from runtime env.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    BETTER_AUTH_SECRET="build-time-placeholder-not-used-at-runtime" \
    NEXT_PUBLIC_BETTER_AUTH_URL="${NEXT_PUBLIC_BETTER_AUTH_URL}" \
    npm run build

# ----------------------------------------------------------------------------
# migrator — applies the Drizzle schema to Postgres (`npm run db:push`).
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "db:push"]

# ----------------------------------------------------------------------------
# runner-reach — heavier variant for the optional CloakBrowser/Chromium reach
# scraper ("Refresh numbers" → X followers / YouTube subs). Debian-based because
# CloakBrowser's downloaded Chromium is a glibc build that won't run on Alpine.
# NOTE: kept BEFORE `runner` on purpose — the LAST stage is the default build
# target, and we want the lean image to be the default.
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner-reach
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CLOAKBROWSER_CACHE_DIR=/home/nextjs/.cloakbrowser \
    REACH_BROWSER_PROFILE=/home/nextjs/cloak-profile
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
      libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home /home/nextjs --create-home nextjs \
    && mkdir -p "$CLOAKBROWSER_CACHE_DIR" "$REACH_BROWSER_PROFILE" \
    && chown -R nextjs:nodejs /home/nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# ----------------------------------------------------------------------------
# runner (DEFAULT) — lean Alpine image: just the standalone server, non-root.
# No Chromium → the optional reach scraper is disabled here (use runner-reach).
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache libc6-compat \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs --home /home/nextjs nextjs
# Standalone output: server.js + only the traced node_modules. `public` and
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
