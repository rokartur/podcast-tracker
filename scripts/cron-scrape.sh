#!/usr/bin/env bash
#
# Hourly trigger for the daily channel auto-scan on a normal VPS.
#
# The /api/cron/scrape endpoint runs every channel whose schedule hour matches
# the current server hour and that has not already run today. So this only needs
# to be called ONCE PER HOUR — each channel still scans at most once a day.
#
# Install (as the user that runs the app), open the crontab:
#   crontab -e
# and add (runs at minute 0 of every hour, logs to a file):
#   0 * * * * /ABSOLUTE/PATH/TO/podcast-tracker/scripts/cron-scrape.sh >> /var/log/podcast-cron.log 2>&1
#
# Make it executable once:
#   chmod +x scripts/cron-scrape.sh
#
# Override the target URL when the app is not on localhost:3000:
#   APP_URL=https://podcasts.example.com  (export it in the crontab line)
#
set -euo pipefail

# Repo root = parent of this script's directory, resolved no matter the CWD that
# cron uses (cron runs jobs from $HOME, not the repo).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Where the running Next.js server listens. Cron hits it over loopback by default.
APP_URL="${APP_URL:-http://localhost:3000}"

# Prefer an already-exported CRON_SECRET; otherwise read just that one key out of
# the repo's .env (handles both quoted and unquoted values).
if [ -z "${CRON_SECRET:-}" ] && [ -f "$ROOT/.env" ]; then
  CRON_SECRET="$(grep -E '^CRON_SECRET=' "$ROOT/.env" | head -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/')"
fi

if [ -z "${CRON_SECRET:-}" ]; then
  echo "[cron-scrape] CRON_SECRET is not set (export it or put it in $ROOT/.env)" >&2
  exit 1
fi

# -f: non-2xx becomes a non-zero exit (so cron logs the failure).
# -m 1800: allow up to 30 min — a long back-catalogue scan must not be cut off.
curl -fsS -m 1800 -X POST \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${APP_URL}/api/cron/scrape"
echo
