import "server-only";
import type { BrowserContext, Page } from "playwright-core";
import { parseCompact, isX } from "@/lib/reach";
import { isPublicUrl } from "@/lib/net";

/**
 * Logged-in X (Twitter) follower scraping via CloakBrowser (stealth Chromium).
 *
 * x.com renders follower counts with JavaScript behind a login wall, so they
 * never appear in the served HTML — the only way to read them is to drive a real
 * (stealth) browser that is logged in. YouTube subscriber counts are public and
 * handled by the plain-HTTP scraper in `reach.ts`; this module is X-only.
 *
 * Login: the persistent profile keeps the session across runs, so login happens
 * rarely. Two ways to get a session into the profile:
 *   1. Automatic — set X_USERNAME / X_PASSWORD and we log in headlessly.
 *   2. Manual (more reliable, bypasses bot challenges) — run once with
 *      REACH_BROWSER_HEADLESS=false, complete any captcha/2FA by hand; the
 *      cookies persist in REACH_BROWSER_PROFILE for all later headless runs.
 *
 * Env:
 *   X_USERNAME / X_PASSWORD       — x.com credentials (handle or email + password)
 *   CLOAKBROWSER_LICENSE_KEY      — optional CloakBrowser Pro key
 *   REACH_BROWSER_PROFILE         — persistent profile dir (default ".cloak-profile")
 *   REACH_BROWSER_HEADLESS=false  — show the window (to clear a login challenge once)
 */

const PROFILE_DIR = process.env.REACH_BROWSER_PROFILE || ".cloak-profile";
const HEADLESS = process.env.REACH_BROWSER_HEADLESS !== "false";
const NAV_TIMEOUT = 30_000;

const LOGGED_IN_SELECTOR =
  'a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"], [data-testid="AppTabBar_Home_Link"]';

/** Browser reach is attempted when X credentials are configured. */
export function browserReachEnabled(): boolean {
  return Boolean(process.env.X_USERNAME && process.env.X_PASSWORD);
}

// CloakBrowser launches a persistent Chromium profile, which locks its user-data
// directory — only one context may use it at a time. Serialize every browser job
// through this promise chain so concurrent refreshes don't fight over the lock.
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Resolve the optional dependency at runtime so the app builds/runs even when
// cloakbrowser isn't installed. Returns null if the package is missing.
async function openContext(): Promise<BrowserContext | null> {
  let mod: typeof import("cloakbrowser");
  try {
    mod = await import("cloakbrowser");
  } catch {
    console.warn(
      "[reach-browser] cloakbrowser is not installed — run `npm install cloakbrowser playwright-core`",
    );
    return null;
  }
  return mod.launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless: HEADLESS,
    humanize: true,
    licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY,
    locale: "en-US",
  });
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page
    .locator(LOGGED_IN_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
}

// Best-effort automated login. X frequently injects extra steps (confirm
// username, email/phone verification, captcha) that can't be automated reliably;
// when that happens this returns false and the caller should fall back to a
// session previously established manually in the persistent profile.
async function login(page: Page): Promise<boolean> {
  const username = process.env.X_USERNAME!;
  const password = process.env.X_PASSWORD!;
  try {
    await page.goto("https://x.com/i/flow/login", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });

    const userInput = page.locator('input[autocomplete="username"], input[name="text"]').first();
    await userInput.waitFor({ state: "visible", timeout: 20_000 });
    await userInput.fill(username);
    await page.getByRole("button", { name: /next/i }).first().click();

    const passInput = page.locator('input[name="password"], input[type="password"]').first();
    try {
      await passInput.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      // "Enter your phone number or username" interstitial — re-enter and retry.
      const confirm = page.locator('input[data-testid="ocfEnterTextTextInput"], input[name="text"]').first();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.fill(username);
        await page.getByRole("button", { name: /next/i }).first().click();
        await passInput.waitFor({ state: "visible", timeout: 12_000 });
      }
    }

    await passInput.fill(password);
    await page.getByRole("button", { name: /log in/i }).first().click();

    return await isLoggedIn(page);
  } catch (e) {
    console.warn(
      "[reach-browser] X login failed — log in once manually with REACH_BROWSER_HEADLESS=false to seed the persistent profile:",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

async function ensureLogin(page: Page): Promise<boolean> {
  await page
    .goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    })
    .catch(() => {});
  if (await isLoggedIn(page)) return true; // session restored from profile
  return login(page);
}

async function readFollowers(page: Page, url: string): Promise<number | null> {
  // SSRF guard: only ever drive the browser to a real x.com host. URLs derive
  // from LLM/scrape output, so never navigate to an internal/loopback target.
  if (!isX(url) || !(await isPublicUrl(url))) return null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const link = page
      .locator('a[href$="/verified_followers"], a[href$="/followers"]')
      .first();
    await link.waitFor({ state: "visible", timeout: 15_000 });
    // The link reads e.g. "1.2M Followers"; an exact count may sit in a title attr.
    const title = await link.locator("[title]").first().getAttribute("title").catch(() => null);
    if (title && /^[\d,]+$/.test(title.replace(/\s/g, ""))) {
      return parseCompact(title);
    }
    const text = await link.innerText();
    const m =
      text.match(/([\d.,]+\s*[KMB]?)\s*Followers/i) ??
      text.match(/([\d.,]+\s*[KMB]?)/);
    return m ? parseCompact(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Read the live follower count for an x.com profile URL using a logged-in stealth
 * browser. Returns null when the browser/dependency is unavailable, login fails,
 * or the count can't be read — callers keep the existing value in that case.
 */
export async function fetchXFollowersViaBrowser(
  url: string,
): Promise<number | null> {
  return withLock(async () => {
    const ctx = await openContext();
    if (!ctx) return null;
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(NAV_TIMEOUT);
      if (!(await ensureLogin(page))) return null;
      return await readFollowers(page, url);
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/**
 * Read follower counts for many x.com profiles in ONE browser session — opens the
 * context and logs in once, then visits each profile. Far cheaper than calling
 * fetchXFollowersViaBrowser per guest. Returns a Map keyed by the input url; a url
 * is absent from the map when its count couldn't be read. Returns an empty map if
 * the browser is unavailable or login fails (so callers keep existing values).
 */
export async function fetchXFollowersBatch(
  urls: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(urls)];
  if (unique.length === 0) return out;

  return withLock(async () => {
    const ctx = await openContext();
    if (!ctx) return out;
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      page.setDefaultTimeout(NAV_TIMEOUT);
      if (!(await ensureLogin(page))) return out; // bail once — don't retry per url
      for (const url of unique) {
        const n = await readFollowers(page, url);
        if (n != null) out.set(url, n);
      }
      return out;
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}
