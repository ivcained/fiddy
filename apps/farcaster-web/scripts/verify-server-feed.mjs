/**
 * The server-drawn public feed, measured in a real browser (run this; do not
 * eyeball it):
 *
 *   1. the HTML /feed answers already carries real root casts, Fiddy metadata
 *      and a boot seed, and no account addresses;
 *   2. with JavaScript disabled, both widths still read the casts (no
 *      skeleton over them, no console script needed);
 *   3. hydration keeps the seed's cast order and makes NO second first-page
 *      read; Recent and Getting attention both still work;
 *   4. a server fallback plus a failed read keeps the app's own error, retry
 *      and empty states working;
 *   5. the sign-in door still opens, and no new console error or off-site
 *      provider read appears.
 *
 * Recipe: `VITE_SNAPCHAIN_HTTP_URL=... HTTPS=true npx vite --port 5233
 * --strictPort`, then `SERVER_FEED_PROBE_SERVER=https://localhost:5233 node
 * scripts/verify-server-feed.mjs`.
 */
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const ORIGIN = process.env.SERVER_FEED_PROBE_SERVER ?? 'https://localhost:5233';
/** Where the server-drawn HTML itself comes from (the unfurl service). */
const SERVICE =
  process.env.SERVER_FEED_PROBE_SERVICE ?? `${ORIGIN}`;
const SHOT_DIR =
  process.env.SERVER_FEED_PROBE_SHOT_DIR ??
  join(tmpdir(), 'fiddy-server-feed-probe');
const WIDTHS = (process.env.SERVER_FEED_PROBE_WIDTHS ?? '390,1440')
  .split(',')
  .map((width) => Number(width.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);

let checks = 0;
let failures = 0;
const check = (ok, what, detail = '') => {
  checks += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
};

const bootFrom = (html) => {
  const source = /<script type="application\/json" id="fiddy-public-feed-boot">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  return JSON.parse(source ?? 'null');
};

const renderedCasts = () =>
  Array.from(
    document.querySelectorAll('[data-fiddy="public-browse"] > .fade-in > div'),
  )
    .map((card) => {
      const author = card.querySelector('a[href*="castHash="]');
      if (!author) return undefined;
      const url = new URL(
        author.getAttribute('href') ?? '',
        window.location.origin,
      );
      const hash = url.searchParams.get('castHash');
      return hash ? hash.toLowerCase() : undefined;
    })
    .filter(Boolean);

const debugFeedTypes = () =>
  (window.__nodeBackedRequests ?? []).flatMap((entry) => {
    if (!entry.path.endsWith('/v2/feed-items')) return [];
    try {
      const body = JSON.parse(entry.bodyPreview ?? '{}');
      return [String(body.feedType ?? '')];
    } catch {
      return ['unreadable'];
    }
  });

/** Node's fetch refuses the dev server's self-signed certificate; curl does not. */
const getDocument = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(
      url,
      {
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(20_000),
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ ok: (response.statusCode ?? 500) < 400, status: response.statusCode, body });
        });
      },
    );
    request.on('error', reject);
  });

const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  let feedResponse = await getDocument(`${SERVICE}/feed`);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if ((bootFrom(feedResponse.body)?.result?.items ?? []).length > 0) {
      break;
    }
    // A cold or expired cache honestly answers the shell while the bounded
    // read finishes. The probe waits for the real page instead of measuring
    // that fallback as if it were the seeded document.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    feedResponse = await getDocument(`${SERVICE}/feed`);
  }
  const feedHtml = feedResponse.body;
  const shellHtml = (await getDocument(`${ORIGIN}/`)).body;
  const boot = bootFrom(feedHtml);
  const seedHashes = (boot?.result?.items ?? [])
    .map((item) => item?.cast?.hash)
    .filter(Boolean);

  check(
    feedResponse.ok && feedHtml.includes('data-fiddy-server-feed'),
    'the served HTML already carries the public feed',
    `${seedHashes.length} casts`,
  );
  check(
    seedHashes.length >= 5 &&
      seedHashes.every(
        (hash) => /^0x[0-9a-f]{40}$/i.test(hash) && !hash.includes('parent'),
      ),
    'the boot seed carries real cast hashes',
  );
  check(
    feedHtml.includes(`<link rel="canonical" href="${ORIGIN}/feed" />`) &&
      feedHtml.includes('<title>Fiddy / Feed</title>'),
    'the document carries the feed metadata',
  );
  check(
    !JSON.stringify(boot).match(
      /"(custodyAddress|verifiedAddresses|verifications|authAddresses|apiKey|signer)"/,
    ),
    'the boot seed carries no address or key fields',
  );

  const browser = await chromium.launch({ headless: true });
  for (const width of WIDTHS) {
    console.log(`\n${width}px, JavaScript disabled`);
    const plain = await browser.newContext({
      viewport: { width, height: 900 },
      javaScriptEnabled: false,
      ignoreHTTPSErrors: true,
    });
    const plainPage = await plain.newPage();
    await plainPage.goto(`${ORIGIN}/feed`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const staticState = await plainPage.evaluate(() => ({
      casts: Array.from(
        document.querySelectorAll('[data-fiddy-server-cast]'),
      ).length,
      skeleton: getComputedStyle(
        document.getElementById('shell-skeleton'),
      ).display,
    }));
    check(
      staticState.casts === seedHashes.length && staticState.skeleton === 'none',
      'the no-JavaScript page reads the casts with no skeleton over them',
      `${staticState.casts} casts`,
    );
    await plainPage.screenshot({
      path: join(SHOT_DIR, `server-feed-${width}-nojs.png`),
      fullPage: false,
    });
    await plain.close();

    console.log(`\n${width}px, hydration`);
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const offsiteProviderReads = [];
    const consoleErrors = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        /^(api\.neynar\.com|snapchain-api\.neynar\.com|hub-api\.neynar\.com|api\.farcaster\.xyz|api\.quilcast\.com)$/i.test(
          url.hostname,
        )
      ) {
        offsiteProviderReads.push(url.hostname);
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !message.text().startsWith('Access to fetch at ') &&
        message.text() !== 'Failed to load resource: net::ERR_FAILED' &&
        !message
          .text()
          .startsWith(
            'Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin',
          )
      ) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${ORIGIN}/feed`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(
          '[data-fiddy="public-browse"] [href*="castHash="]',
        ).length >= count,
      Math.min(3, seedHashes.length),
      { timeout: 90_000 },
    );
    const hydrated = await page.evaluate(renderedCasts);
    const initialFeedReads = await page.evaluate(debugFeedTypes);
    check(
      !initialFeedReads.some(
        (type) => type === 'recent' || type === 'unreadable',
      ),
      'hydration makes no second first-page read',
      initialFeedReads.join(',') || 'none',
    );
    check(
      hydrated.slice(0, seedHashes.length).join() ===
        seedHashes.slice(0, hydrated.length).join(),
      'the hydrated feed keeps the server cast order',
      `${hydrated.length} rendered`,
    );
    await page.screenshot({
      path: join(SHOT_DIR, `server-feed-${width}.png`),
      fullPage: false,
    });

    await page.getByRole('button', { name: 'Getting attention' }).click();
    await page.waitForFunction(
      () =>
        window.__nodeBackedRequests?.some?.(
          (entry) =>
            entry.path.endsWith('/v2/feed-items') && entry.status === 200,
        ) ?? false,
      undefined,
      { timeout: 90_000 },
    );
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(
          '[data-fiddy="public-browse"] > .fade-in > div a[href*="castHash="]',
        ).length >= count,
      Math.min(3, seedHashes.length),
      { timeout: 90_000 },
    );
    const trending = await page.evaluate(renderedCasts);
    const tabFeedReads = await page.evaluate(debugFeedTypes);
    check(
      trending.length > 0 && tabFeedReads.includes('trending'),
      'the ranked tab still reads and renders',
      `${trending.length} casts; ${tabFeedReads.join(',') || 'no read'}`,
    );
    await page.getByRole('button', { name: 'Newest' }).click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(
          '[data-fiddy="public-browse"] [href*="castHash="]',
        ).length >= count,
      Math.min(3, seedHashes.length),
      { timeout: 90_000 },
    );
    check(
      (await page.evaluate(renderedCasts)).slice(0, seedHashes.length).join() ===
        seedHashes.slice(0, Math.min(hydrated.length, seedHashes.length)).join(),
      'returning to Newest restores the seeded order',
    );

    await page
      .getByRole('button', { name: 'Sign in to join in' })
      .first()
      .click();
    check(
      await page
        .locator('[data-fiddy="connect-door"]')
        .first()
        .isVisible()
        .catch(() => false),
      'the sign-in door still opens from the seeded page',
    );
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.close();

    check(
      consoleErrors.length === 0,
      'no unexpected console or page error (existing embed CORS noise excluded)',
      consoleErrors.slice(0, 3).join(' | ').slice(0, 160),
    );
    check(
      offsiteProviderReads.length === 0,
      'no off-site feed/provider read (existing embed probes excluded)',
      offsiteProviderReads.join(',').slice(0, 160),
    );
    await context.close();
  }

  console.log(`\nerror, retry and empty states`);
  const stateContext = await browser.newContext({
    viewport: { width: 390, height: 900 },
    ignoreHTTPSErrors: true,
  });
  for (const [name, nodePattern, firstBody, marker, retry] of [
    [
      'a failed read shows the error state',
      '**/v1/userDataByFid*',
      { status: 500, body: '{"error":"the node is not answering"}' },
      '[data-fiddy="public-error"]',
      'Try again',
    ],
    [
      'an empty read shows the empty state',
      '**/v1/userNameProofByName*',
      { status: 404, body: '{"error":"not found"}' },
      '[data-fiddy="public-empty"]',
      'Look again',
    ],
  ]) {
    const page = await stateContext.newPage();
    await page.route(`${ORIGIN}/feed`, (route) =>
      route.fulfill({ body: shellHtml, contentType: 'text/html' }),
    );
    let interceptReads = true;
    await page.route(nodePattern, async (route) => {
      if (interceptReads) {
        await route.fulfill({
          ...firstBody,
          contentType: 'application/json',
        });
        return;
      }
      await route.fallback();
    });
    await page.goto(`${ORIGIN}/feed`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForSelector(marker, { timeout: 90_000 });
    check(true, name);
    interceptReads = false;
    await page.getByRole('button', { name: retry }).click();
    await page.waitForSelector(
      '[data-fiddy="public-browse"] [href*="castHash="]',
      { timeout: 90_000 },
    );
    check(
      await page
        .locator('[data-fiddy="public-browse"] [href*="castHash="]')
        .first()
        .isVisible(),
      `${retry} recovers from the server read`,
    );
    await page.close();
  }
  await stateContext.close();
  await browser.close();

  console.log(
    `\n${checks - failures}/${checks} checks passed${
      failures === 0 ? '' : ` — ${failures} FAILED`
    }`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(`probe failed: ${String(error)}`);
  process.exit(1);
});
