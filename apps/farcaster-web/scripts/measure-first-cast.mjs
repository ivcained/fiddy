// Measure the LIVE client: sign-in complete -> first cast painted (cold), and a
// warm re-open -> first cast painted. This is the before/after instrument for
// the "casts take long to load after sign-in" report.
//
//   node apps/farcaster-web/scripts/measure-first-cast.mjs
//
// It prints the run as JSON to stdout and writes the whole run (including the
// request timeline) to MEASURE_OUT.
//
// Only the SIWF relay is stubbed — the same throwaway key, SIWE message, fid 3
// (`dwr`) and channel token the other probes use, so the app's own verifier
// accepts the sign-in for real — and every cross-origin write is aborted, so a
// run is a measurement and never a write.
//
// WHAT IS MEASURED, and why it is measured this way:
//
//   - "a cast is painted" is a VISIBLE link to a cast's own conversation route
//     (`a[href*="/conversations/"]` with a real box) — the permalink every
//     UnfocusedCast renders. The first paint of the feed is the first moment one
//     of those exists, whatever is still in flight behind it.
//   - cold is a FRESH browser context: no HTTP cache, no localStorage, no
//     session. That is the first-ever sign-in case.
//   - warm is the same context after the cold run, re-opening the app: the
//     browser's HTTP cache and the app's own storage are both warm, and only
//     the app's data cache is in question.
//   - every request the page makes is timestamped relative to the case's own
//     start, with its duration, so the wait can be attributed (the bundle, the
//     sign-in handshake, the node reads) instead of described.
//
// Knobs: LIVE_SITE, LIVE_BOOT_MS (per-step ceiling), MEASURE_VIEWS (default
// "390,1440"), MEASURE_OUT.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SITE = process.env.LIVE_SITE ?? 'https://fiddy.fun';
const DOMAIN = new URL(SITE).host;
const CHANNEL_TOKEN = 'FIRSTCST';
const NONCE = 'c'.repeat(128);
const FID = 3;
const HANDLE = 'dwr';
const BOOT = Number(process.env.LIVE_BOOT_MS ?? 180_000);
const OUT = process.env.MEASURE_OUT ?? `${process.cwd()}/first-cast-measure.json`;
const VIEWS = (process.env.MEASURE_VIEWS ?? '390,1440')
  .split(',')
  .map((label) => Number(label.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The permalink every cast in the feed paints: `/<username>/<0x…>`, the
 * timestamp link inside each cast. A cast is on screen when one of those has a
 * real box. Kept as one expression so the cold and warm waits cannot drift
 * apart. */
const CAST_LINK = 'a[href]';
const CAST_HREF = /^\/[^/]+\/0x[0-9a-f]{8,}$/i;

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SITE}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const result = {
  site: SITE,
  ranAt: new Date().toISOString(),
  driver: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  host: { cpus: os.cpus().length, load: os.loadavg().map((n) => Math.round(n * 10) / 10) },
  notes: [],
  runs: [],
};
const note = (...parts) => result.notes.push(parts.join(' '));

// A deployment answers release.json; a locally served build does not, and that
// is a note rather than a failure.
let release = null;
try {
  release = await fetch(`${SITE}/release.json`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  }).then((response) => response.json());
} catch (error) {
  note(`release.json: ${String(error).slice(0, 120)} (a locally served build has none)`);
}
const shell = await fetch(`${SITE}/`, { signal: AbortSignal.timeout(60_000) }).then((response) => response.text());
const entryMatch = shell.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
const entryChunk = entryMatch
  ? {
      path: entryMatch[0],
      bytes: Number((await fetch(`${SITE}${entryMatch[0]}`, { signal: AbortSignal.timeout(180_000) })).headers.get('content-length')) || null,
    }
  : null;
result.release = { ...(release ?? { revision: null, note: 'no release.json (a locally served build)' }), entryChunk };

const browser = await chromium.launch({ channel: 'chrome' });

for (const view of VIEWS.map((width) => ({
  label: String(width),
  width,
  height: width < 500 ? 844 : 900,
}))) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 1,
    isMobile: view.width < 500,
  });
  const page = await context.newPage();

  // ── the timeline: every request this page makes, with when it started and
  // how long the answer took. This is what attributes the wait.
  let timeline = [];
  let open = new Map();
  page.on('request', (request) => {
    open.set(request, { method: request.method(), url: request.url(), start: Date.now(), end: null, status: null, failed: null });
  });
  const close = (request, failed) => {
    const entry = open.get(request);
    if (!entry) return;
    entry.end = Date.now();
    entry.failed = failed ?? null;
    timeline.push(entry);
  };
  page.on('requestfinished', async (request) => {
    close(request);
    const entry = timeline[timeline.length - 1];
    if (entry) {
      try {
        entry.status = (await request.response())?.status() ?? null;
      } catch {
        entry.status = null;
      }
    }
  });
  page.on('requestfailed', (request) => close(request, request.failure()?.errorText ?? 'failed'));

  const abortedWrites = [];
  const signIns = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url.startsWith('https://relay.farcaster.xyz')) {
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
      if (method === 'POST') {
        return route.fulfill({
          status: 201,
          headers: CORS,
          body: JSON.stringify({
            channelToken: CHANNEL_TOKEN,
            url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
            nonce: NONCE,
          }),
        });
      }
      signIns.push(Date.now());
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          state: 'completed',
          nonce: NONCE,
          message,
          signature,
          fid: FID,
          username: HANDLE,
          displayName: HANDLE,
        }),
      });
    }
    if (WRITE_METHODS.has(method) && !url.startsWith(SITE)) {
      abortedWrites.push(`${method} ${url}`);
      return route.abort();
    }
    return route.continue();
  });

  const run = { viewport: view.label, cold: {}, warm: {}, abortedWrites, timeline: [], warmTimeline: [] };

  /** Everything a cast-bearing page can be read from, for the report. */
  const sample = async () => {
    try {
      return await page.evaluate(
        ({ link, pattern }) => {
          const re = new RegExp(pattern, 'i');
          const visible = Array.from(document.querySelectorAll(link)).filter(
            (node) =>
              re.test(node.getAttribute('href') ?? '') &&
              node.getBoundingClientRect().width > 0,
          );
          const first = visible[0];
          const block = first
            ? first.closest('div[class]')?.innerText ?? first.innerText
            : '';
          return {
            casts: visible.length,
            href: first?.getAttribute('href') ?? null,
            text: (block ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 220),
          };
        },
        { link: CAST_LINK, pattern: CAST_HREF.source },
      );
    } catch (error) {
      return { error: String(error).slice(0, 120) };
    }
  };

  /** Wait for the first cast, tolerating the sign-in's own navigation. The
 * predicate is self-contained and takes its pattern as an argument: a function
 * that closes over a module binding is serialized into the page without it. */
  const waitForFirstCast = async (budgetMs) => {
    const started = Date.now();
    await page
      .waitForFunction(
        ({ link, pattern }) => {
          const re = new RegExp(pattern, 'i');
          return Array.from(document.querySelectorAll(link)).filter(
            (node) =>
              re.test(node.getAttribute('href') ?? '') &&
              node.getBoundingClientRect().width > 0,
          ).length;
        },
        { link: CAST_LINK, pattern: CAST_HREF.source },
        { timeout: budgetMs, polling: 100 },
      )
      .catch((error) => note(`first cast wait: ${String(error).slice(0, 140)}`));
    return Date.now() - started;
  };

  /** When the feed stopped asking for things after that first paint. */
  const waitForSettled = async () => {
    const started = Date.now();
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    return Date.now() - started;
  };

  // ── COLD: a fresh browser (no storage at all) signs in and waits for a cast.
  const coldStart = Date.now();
  try {
    await page.goto(`${SITE}/welcome/ready`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-fiddy="onboarding"]', { timeout: BOOT });
    const signIn = page.locator('button:has-text("sign in with Farcaster")').first();
    await signIn.waitFor({ state: 'visible', timeout: BOOT });
    const clickedAt = Date.now();
    await signIn.click({ timeout: 60_000, force: true });
    const waited = await waitForFirstCast(BOOT);
    const paintedAt = Date.now();
    const inFlightAtPaint = open.size;
    const settled = await waitForSettled();
    const signedInAt = signIns.length ? signIns[signIns.length - 1] : null;
    run.cold = {
      readyMs: clickedAt - coldStart,
      signInCompletedMs: signedInAt ? signedInAt - clickedAt : null,
      firstCastMs: paintedAt - clickedAt,
      firstCastFromSignInMs: signedInAt ? paintedAt - signedInAt : null,
      settledAfterPaintMs: settled,
      inFlightAtPaint,
      waitedMs: waited,
      sample: await sample(),
      url: page.url(),
    };
  } catch (error) {
    run.cold = { error: String(error).slice(0, 300), url: page.url() };
  }
  run.timeline = timeline.map((entry) => ({
    method: entry.method,
    url: entry.url,
    fromMs: entry.start - coldStart,
    ms: entry.end === null ? null : entry.end - entry.start,
    status: entry.status,
    failed: entry.failed,
  }));
  timeline = [];
  open = new Map();

  // ── WARM: the same browser, with whatever the cold run left behind.
  const warmStart = Date.now();
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForFirstCast(BOOT);
    const paintedAt = Date.now();
    const inFlightAtPaint = open.size;
    const settled = await waitForSettled();
    run.warm = {
      firstCastMs: paintedAt - warmStart,
      inFlightAtPaint,
      settledAfterPaintMs: settled,
      sample: await sample(),
      url: page.url(),
      storage: await page.evaluate(() => {
        const keys = Object.keys(window.localStorage);
        return {
          count: keys.length,
          keys: keys.slice(0, 40),
          bytes: keys.reduce((total, key) => total + (window.localStorage.getItem(key)?.length ?? 0), 0),
        };
      }),
    };
  } catch (error) {
    run.warm = { error: String(error).slice(0, 300), url: page.url() };
  }
  run.warmTimeline = timeline.map((entry) => ({
    method: entry.method,
    url: entry.url,
    fromMs: entry.start - warmStart,
    ms: entry.end === null ? null : entry.end - entry.start,
    status: entry.status,
    failed: entry.failed,
  }));

  result.runs.push(run);
  await context.close();
}

await browser.close();
writeFileSync(OUT, JSON.stringify(result, null, 2));

/** What the summary says: enough to compare two runs, nothing to interpret. */
const isNodeRead = (url) => url.includes('haatz') || url.includes('/snapchain-api/') || url.includes('/v1/') || url.includes('/v2/');
const summary = result.runs.map((run) => {
  const nodeAt = (list) => list.filter((entry) => isNodeRead(entry.url)).map((entry) => entry.fromMs);
  const coldNode = nodeAt(run.timeline).sort((a, b) => a - b);
  const warmNode = nodeAt(run.warmTimeline).sort((a, b) => a - b);
  return {
    viewport: run.viewport,
    coldFirstCastMs: run.cold.firstCastMs ?? null,
    coldFromSignInMs: run.cold.firstCastFromSignInMs ?? null,
    coldError: run.cold.error ?? null,
    coldCasts: run.cold.sample?.casts ?? null,
    coldInFlightAtPaint: run.cold.inFlightAtPaint ?? null,
    coldText: run.cold.sample?.text ?? null,
    warmFirstCastMs: run.warm.firstCastMs ?? null,
    warmError: run.warm.error ?? null,
    warmCasts: run.warm.sample?.casts ?? null,
    warmInFlightAtPaint: run.warm.inFlightAtPaint ?? null,
    warmText: run.warm.sample?.text ?? null,
    warmStorageKeys: run.warm.storage?.keys ?? null,
    warmStorageBytes: run.warm.storage?.bytes ?? null,
    coldRequests: run.timeline.length,
    coldNodeReads: coldNode.length,
    coldFirstNodeReadMs: coldNode[0] ?? null,
    warmRequests: run.warmTimeline.length,
    warmNodeReads: warmNode.length,
    warmFirstNodeReadMs: warmNode[0] ?? null,
    abortedWrites: run.abortedWrites.length,
  };
});
console.log(
  JSON.stringify({ out: OUT, driver: result.driver, release: result.release, host: result.host, notes: result.notes, runs: summary }, null, 2),
);