// End-to-end check that a signed-in client reads its surfaces from the NODE.
//
//   node scripts/verify-node-backed-client.mjs
//
// Requires a dev server whose /snapchain-api relay points at a live public read
// node:
//
//   SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com npx vite --port 5174
//   NODE_BACKED_SERVER=https://localhost:5174 node scripts/verify-node-backed-client.mjs
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts the sign-in for
// real. The FID the stubbed relay names is 3 (`dwr`) — a real, active account —
// because the point of this probe is that real casts come back from the node,
// and an invented FID has no follow graph to read. Nothing here writes: the
// whole probe is reads.
//
// WHAT IT ASSERTS
//   1. a completed sign-in lands in the CLIENT (not the setup, not the
//      device-only landing that says nothing can load here)
//   2. the home feed reads the node's own routes and renders cast text that
//      came back from them — the text is compared against the bytes the node
//      returned, so an empty or foreign feed cannot pass
//   3. a cast detail, a profile, a channel and notifications each render, and
//      each one's reads went to the node relay
//   4. a reload keeps all of that working
//   5. every node route the client used is reported with its status, and every
//      endpoint that came back 501 is listed — so the gaps (the reads a read
//      node genuinely cannot answer) are visible rather than implied
//
// Screenshots land in $NODE_BACKED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5174';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NODE_BACKED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'NODEBACK1';
const SIGNED_IN_FID = 3;

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/**
 * Read the surface, tolerating a page that is mid-navigation.
 *
 * MEASURED (2026-10-21, under load): a read taken while the client is still
 * swapping routes throws `Execution context was destroyed, most likely because
 * of a navigation` and takes the whole probe down with it — the checks it was
 * about to make never run. A destroyed execution context is retried; anything
 * else still throws.
 */
const readSurface = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(surfaceProbe);
    } catch (error) {
      if (!/Execution context was destroyed|Target closed|navigat/i.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  return { path: '', text: '', castLinks: [] };
};

const surfaceProbe = () => {
  const text = document.body.innerText.replace(/\s+/g, ' ').trim();
  return {
    path: window.location.pathname,
    text,
    onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
    deviceOnlyLanding: Boolean(
      document.querySelector('[data-fiddy="device-only-session"]'),
    ),
    dmsUnavailable: Boolean(document.querySelector('[data-fiddy="dms-unavailable"]')),
    dmsNoteText: /direct casts\s+soon/i.test(text),
    errorText:
      /Could not reach Farcaster|Error retrieving data|Something went wrong/i.test(text),
    castLinks: Array.from(document.querySelectorAll('a[href*="/conversations/"]'))
      .map((a) => a.getAttribute('href'))
      .slice(0, 12),
  };
};

const run = async () => {
  /** "GET 200 /snapchain-api/v1/castsByFid?fid=3…" — what left the page. */
  const readLog = (page) =>
    page.evaluate(() => window.__nodeBackedFetchLog ?? []);
  const nodeCastTexts = [];
  /** The same casts' hashes, so a thread can be opened by hash. */
  const nodeCastHashes = [];
  const consoleErrors = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Every call that leaves the page through `window.fetch`. The client's own
  // requests go through the node adapter (never over the network); the
  // adapter's node reads go through here, so this log is the evidence of what
  // the node was actually asked for.
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__nodeBackedFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      try {
        const response = await orig(...args);
        window.__nodeBackedFetchLog.push(
          `${method} ${response.status} ${String(url).slice(0, 170)}`,
        );
        return response;
      } catch (error) {
        window.__nodeBackedFetchLog.push(
          `${method} THREW ${String(url).slice(0, 170)} :: ${String(error).slice(0, 100)}`,
        );
        throw error;
      }
    };
  });

  const page = await ctx.newPage();

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`));

  // The node's own cast bytes, so the DOM can be checked against what the node
  // really returned rather than against "some text rendered".
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/snapchain-api/')) return;
    const path = new URL(url).pathname.replace(/^\/snapchain-api/, '');
    if (!path.startsWith('/v1/castsByFid') || response.status() !== 200) return;
    try {
      const body = await response.json();
      for (const msg of body.messages ?? []) {
        const text = msg?.data?.castAddBody?.text;
        if (typeof text === 'string' && text.trim().length > 12) {
          nodeCastTexts.push(text);
          if (typeof msg.hash === 'string') nodeCastHashes.push(msg.hash);
        }
      }
    } catch {
      /* the read is still reported through the fetch log */
    }
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
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
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        state: 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  const waitForSurface = async (predicate, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const surface = await readSurface(page);
      if (predicate(surface) && surface.text.length > 40) return surface;
      await page.waitForTimeout(1000);
    }
    return await readSurface(page);
  };

  /** Wait until the page has logged a node read matching `matcher`. */
  const waitForNodeRead = async (matcher, tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const lines = await readLog(page);
      const hit = lines.find((line) => matcher.test(line));
      if (hit) return hit;
      await page.waitForTimeout(1000);
    }
    return undefined;
  };

  const inClient = (surface) =>
    !surface.onboardingSheet && !surface.deviceOnlyLanding && surface.path === '/';

  // ── 1. sign in ────────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(() => document.body.innerText.trim().length > 40, {
    timeout: 60000,
  });

  let clicked = null;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      clicked = text;
      break;
    }
  }

  const afterSignIn = await waitForSurface(inClient);
  await page.screenshot({ path: `${OUT}/node-backed-after-signin.png` });

  check(
    'a completed sign-in lands in the client, not on a setup or device-only screen',
    inClient(afterSignIn) && clicked !== null,
    `clicked="${clicked}" path=${afterSignIn.path} deviceOnly=${afterSignIn.deviceOnlyLanding} onboarding=${afterSignIn.onboardingSheet}`,
  );

  // ── 2. the feed reads the node and shows its casts ────────────────────────
  const feedRead = await waitForNodeRead(
    /^GET 200 .*\/snapchain-api\/v1\/castsByFid/,
    90,
  );

  // The feed is assembled from the follow graph, so its first page takes as
  // long as a bounded fan-out over a real node takes (seconds, not
  // milliseconds). Wait for cast text rather than for a stopwatch — and wait
  // for the node's OWN text, so an empty or cached page cannot pass.
  const onScreen = (haystack, text) => {
    const needle = text.replace(/\s+/g, ' ').trim().slice(0, 30);
    return needle.length > 12 && haystack.includes(needle);
  };
  let feedNow = await readSurface(page);
  let matched = [];
  for (let i = 0; i < 40; i += 1) {
    feedNow = await readSurface(page);
    matched = nodeCastTexts.filter((text) => onScreen(feedNow.text, text));
    if (matched.length > 0) break;
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: `${OUT}/node-backed-feed.png` });

  const lines = await readLog(page);
  const nodeReadLines = lines.filter((line) => line.includes('/snapchain-api/'));

  check(
    'the home feed read the node directly (/v1/castsByFid through the relay)',
    Boolean(feedRead),
    feedRead ?? `no castsByFid read; ${nodeReadLines.length} node reads: ${JSON.stringify(
      nodeReadLines.slice(0, 3),
    )}`,
  );

  check(
    'real cast text from the node is on screen',
    matched.length > 0,
    `${matched.length} of ${nodeCastTexts.length} node casts on screen; first on screen=${
      matched[0]?.slice(0, 60) ?? 'none'
    }`,
  );
  check(
    'the feed is not an error page',
    !(feedNow.errorText && matched.length === 0),
    feedNow.errorText ? feedNow.text.slice(0, 160) : 'no error copy',
  );
  check(
    'the rail says what the node cannot do (direct messages)',
    feedNow.dmsUnavailable || feedNow.dmsNoteText,
    `element=${feedNow.dmsUnavailable} text=${feedNow.dmsNoteText}`,
  );

  // ── 3. a cast, a profile, a channel, notifications ────────────────────────
  const surfaces = {};

  // Open a cast the FEED itself just rendered: its text was on screen, and the
  // hash came from the node's own bytes. The fork's cast components are not
  // anchors, so the URL is built rather than scraped.
  const shownHash = nodeCastHashes[nodeCastTexts.indexOf(matched[0])];
  const castHref = shownHash ? `/~/conversations/${shownHash}` : undefined;
  if (castHref) {
    await page.goto(`${SERVER}${castHref}`, { waitUntil: 'domcontentloaded' });
    const threadRead = await waitForNodeRead(
      /^GET 200 .*\/snapchain-api\/v1\/(castsByParent|castById)/,
      45,
    );
    surfaces.cast = await waitForSurface((s) => !s.errorText && s.text.length > 120, 20);
    await page.screenshot({ path: `${OUT}/node-backed-cast.png` });
    check(
      'a cast detail opens, with the thread read from the node',
      Boolean(threadRead) && !surfaces.cast.errorText,
      threadRead ?? `no thread read for ${castHref}`,
    );
  } else {
    check(
      'a cast detail opens, with the thread read from the node',
      false,
      'the feed rendered no cast link to open',
    );
  }

  await page.goto(`${SERVER}/~/profiles/${SIGNED_IN_FID}`, {
    waitUntil: 'domcontentloaded',
  });
  const profileRead = await waitForNodeRead(
    /^GET 200 .*\/snapchain-api\/v1\/userDataByFid\?fid=3/,
    45,
  );
  surfaces.profile = await waitForSurface((s) => s.text.includes('dwr'), 45);
  await page.screenshot({ path: `${OUT}/node-backed-profile.png` });
  check(
    'a profile page reads the node and names the account',
    Boolean(profileRead) && surfaces.profile.text.includes('dwr'),
    profileRead ? `${profileRead} | ${surfaces.profile.text.slice(0, 90)}` : 'no userData read',
  );

  await page.goto(`${SERVER}/~/channel/dev`, { waitUntil: 'domcontentloaded' });
  const channelRead = await waitForNodeRead(
    /^GET 200 .*\/snapchain-api\/v1\/castsByParent.*channel/,
    45,
  );
  surfaces.channel = await waitForSurface((s) => s.text.length > 120, 20);
  await page.screenshot({ path: `${OUT}/node-backed-channel.png` });
  check(
    'a channel page reads its casts from the node',
    Boolean(channelRead) && !surfaces.channel.errorText,
    channelRead ?? 'no castsByParent read for the channel',
  );

  await page.goto(`${SERVER}/~/notifications`, { waitUntil: 'domcontentloaded' });
  const notificationRead = await waitForNodeRead(
    /^GET 200 .*\/snapchain-api\/v1\/(castsByMention|reactionsByFid|linksByTargetFid)/,
    45,
  );
  surfaces.notifications = await waitForSurface((s) => s.text.length > 120, 20);
  await page.screenshot({ path: `${OUT}/node-backed-notifications.png` });
  check(
    'notifications are derived from the node (mentions / reactions / follows)',
    Boolean(notificationRead),
    notificationRead ?? 'no node read on the notifications surface',
  );
  check(
    'the notifications surface does not render an error page',
    !surfaces.notifications.errorText,
    surfaces.notifications.errorText
      ? surfaces.notifications.text.slice(0, 140)
      : surfaces.notifications.text.slice(0, 90),
  );

  // ── 4. a reload keeps it working ──────────────────────────────────────────
  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  const reloadSurface = await waitForSurface(inClient, 45);
  // The feed's own fan-out reads 10 casts per author, so that is the read that
  // marks the feed rebuilding itself after a reload.
  const reloadRead = await waitForNodeRead(
    /^GET 200 .*\/snapchain-api\/v1\/castsByFid\?fid=\d+&pageSize=10/,
    60,
  );
  let reloadNow = await readSurface(page);
  let reloadMatched = [];
  for (let i = 0; i < 40; i += 1) {
    reloadNow = await readSurface(page);
    reloadMatched = nodeCastTexts.filter((text) => onScreen(reloadNow.text, text));
    if (reloadMatched.length > 0) break;
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: `${OUT}/node-backed-after-reload.png` });
  check(
    'after a reload the client still reads the feed from the node',
    inClient(reloadSurface) && Boolean(reloadRead) && reloadMatched.length > 0,
    `${reloadRead ?? 'no bounded castsByFid read after the reload'} | casts back on screen: ${reloadMatched.length}`,
  );

  await browser.close();

  // ── the endpoint report: what the node was asked for, and what 501'd ──────
  const byPath = new Map();
  for (const line of await Promise.resolve(lines)) {
    const match = /^([A-Z]+) (\d+|THREW) (\S+)/.exec(line);
    if (!match) continue;
    const [, method, status, rawUrl] = match;
    let path = rawUrl;
    try {
      path = new URL(rawUrl, SERVER).pathname;
    } catch {
      /* keep the raw string */
    }
    if (!path.startsWith('/snapchain-api')) continue;
    const key = `${method} ${path.replace(/^\/snapchain-api/, '')}`;
    const entry = byPath.get(key) ?? { key, calls: 0, statuses: new Set() };
    entry.calls += 1;
    entry.statuses.add(status);
    byPath.set(key, entry);
  }
  const report = [...byPath.values()]
    .map((e) => ({ key: e.key, calls: e.calls, statuses: [...e.statuses].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const gapLines = consoleErrors.filter((line) => /HandledFetchError|501/.test(line));
  const failed = checks.filter((c) => !c.ok);

  console.log('── the client, driven with a real SIWF session against a real node ──');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  console.log(`\n── node routes the client used (${report.length}) ──`);
  for (const r of report) {
    console.log(`${r.statuses.join('/')}  x${String(r.calls).padStart(3)}  ${r.key}`);
  }

  console.log(`\n── endpoints the node could not answer (501) ──`);
  const seenGaps = new Set();
  for (const line of gapLines) {
    const name = /HandledFetchError: ([A-Za-z]+) 501 - (.{0,110})/.exec(line);
    if (!name || seenGaps.has(name[1])) continue;
    seenGaps.add(name[1]);
    console.log(`  ${name[1]}: ${name[2]}`);
  }
  if (seenGaps.size === 0) console.log('  (none)');

  console.log(
    `\nconsole errors: ${consoleErrors.length} (${gapLines.length} of them the adapter saying "not on the node")`,
  );

  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );

  if (failed.length > 0) process.exitCode = 1;
};

await run();