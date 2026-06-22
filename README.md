This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Daily auto-scan cron

Each channel with auto-scan enabled runs **at most once a day**, at its
configured `scheduleHour` (the server's local hour). There are two ways it runs;
the first needs no setup and works in dev and prod.

### Built-in scheduler (default — dev & prod)

On every server start (`next dev` and `next start`), `src/instrumentation.ts`
launches an in-app scheduler (`src/lib/cron/scheduler.ts`) that checks every 15
minutes and scans any channel that is due. Nothing to configure — just set
`CRON_SECRET` and run the app.

Turn it off with `CRON_IN_APP=0` (e.g. when you prefer an external crontab, or
run multiple app instances and want only one scheduler).

> Note: the built-in scheduler assumes a **single** long-running app process
> (the normal VPS / `npm start` case). If you run several instances (PM2
> cluster), set `CRON_IN_APP=0` on all but one, or use the external crontab
> below instead.

### External crontab (optional, VPS)

The same work is exposed at `POST /api/cron/scrape`, protected by a bearer token
and **safe to call once per hour**. Use this instead of the built-in scheduler
if you want the OS to own the schedule.

Set up on a normal VPS (app started with `npm run build && npm start`):

1. Put a strong secret in `.env` (already gitignored):

   ```bash
   echo "CRON_SECRET=\"$(openssl rand -base64 32)\"" >> .env
   ```

   Restart the app so it picks up the new value.

2. Make the trigger script executable:

   ```bash
   chmod +x scripts/cron-scrape.sh
   ```

3. Add an hourly line to the crontab of the user that runs the app
   (`crontab -e`):

   ```cron
   0 * * * * /ABSOLUTE/PATH/TO/podcast-tracker/scripts/cron-scrape.sh >> /var/log/podcast-cron.log 2>&1
   ```

The script reads `CRON_SECRET` from `.env` and `POST`s to
`http://localhost:3000/api/cron/scrape`. If the app is behind a domain/port,
export `APP_URL` in the crontab line (e.g. `APP_URL=https://podcasts.example.com`).

Test it any time:

```bash
./scripts/cron-scrape.sh          # -> {"ok":true,"processed":...}
# force a run now, ignoring the hour/once-a-day guards:
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/scrape?force=1"
```

Notes: the secret is only accepted in the `Authorization` header, never the
query string. `scheduleHour` is the **server's local hour**, so set the VPS
timezone (`timedatectl set-timezone …`) to whatever you want the schedule to
mean.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
