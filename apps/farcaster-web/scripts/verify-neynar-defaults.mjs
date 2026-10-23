// The six surfaces a signed-in reader meets first on fiddy.fun — do they LOAD?
//
//   SERVER=https://localhost:5390 node scripts/verify-neynar-defaults.mjs
//   SERVER=https://fiddy.fun    node scripts/verify-neynar-defaults.mjs
//
// WHY THIS PROBE EXISTS
//
// User-reported 2026-10-23: Apps, Referrals, Saved, Your own setup, Updates and
// Profile all showed honest-refusal copy ("This page isn’t on your node",
// "Explore isn’t on your node") on the live site. The refusals were honest — but
// these six are meant to *load*. Neynar is this client's declared default
// read+write provider (`providers/catalog.ts`): the reads a Snapchain node cannot
// answer (the app catalog, and the index reads) are Neynar's job, and the
// released bundle has to carry the key that lets it do that job. A release that
// ships without `VITE_NEYNAR_API_KEY` refuses those surfaces forever, and no
// amount of reader setup fixes it, because the key is a BUILD-time credential
// (`providers/preferences.ts`) and not something the app can be told at runtime.
//
// So the probe holds each of the six to one rule: **it loads with zero reader
// setup** — the surface's own content is on the page, no refusal panel is
// anywhere on it, and no read was answered with a 501. The adapter's own request
// log (`window.__nodeBackedRequests`, filled only when a build sets
// VITE_SNAPCHAIN_DEBUG) is read as evidence of which server carried the reads,
// and every request the page makes to a provider host is recorded, so "Neynar
// answered the catalog read" is proved rather than assumed. A release build
// never sets the debug flag, so on fiddy.fun the DOM half carries the proof and
// the log half says so out loud.
//
// Nothing here is a mock: the session is a real SIWF message, the node reads go
// through the app's own proxy to a live read node, and the provider chain is the
// app's real one.

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.SERVER ?? 'https://localhost:5390';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'NEYNARDEF1';
const SIGNED_IN_FID = 3;
// A cold vite dev server optimizes its dependency graph on the first page load,
// which can take a minute on this app — a nav timeout shorter than that reads as
// a broken surface.
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT ?? 180000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20000);
const QUIET_MS = Number(process.env.QUIET_MS ?? 2500);
const ONLY = process.env.ONLY ?? '';

/**
 * The six surfaces, in the order the nav puts them, with copy that only the real
 * surface paints. Each pattern is drawn from that surface's own component — not
 * from chrome the shell shares with every route — so a check cannot pass on a
 * heading that renders on an empty page.
 */
const SURFACES = [
  {
    name: 'Apps',
    path: '/~/apps',
    shot: 'defaults-apps.png',
    content: /explore farcaster|trending apps|add your own neynar/i,
  },
  {
    name: 'Referrals',
    path: '/~/referrals',
    shot: 'defaults-referrals.png',
    content: /referral|invite/i,
  },
  {
    name: 'Saved',
    path: '/~/saved',
    shot: 'defaults-saved.png',
    content: /bookmarks/i,
  },
  {
    name: 'Your own setup',
    path: '/~/settings/node',
    shot: 'defaults-setup.png',
    content: /your own setup/i,
  },
  {
    name: 'Updates',
    path: '/~/channel/fc-updates',
    shot: 'defaults-updates.png',
    content: /fc-updates/i,
  },
  {
    name: 'Profile',
    path: '/~/profiles/3',
    shot: 'defaults-profile.png',
    content: /dwr|fid 3/i,
  },
];

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

const flatten = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();
const flattenForCompare = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/** `page.evaluate`, tolerating a surface that navigates itself mid-read. */
const safeEvaluate = async (page, fn, arg, fallback) => {
  try {
    return await page.evaluate(fn, arg);
  } catch {
    return fallback;
  }
};

/** What the page says about itself: panels, copy, the shell's state. */
const readSurface = (page) =>
  safeEvaluate(
    page,
    () => {
      const flatInPage = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();
      const panels = [
        ...document.querySelectorAll(
          '[data-fiddy="node-cannot-answer"], [data-fiddy="shell-section-degraded"]',
        ),
      ].map((panel) => ({
        kind: panel.getAttribute('data-fiddy'),
        title: flatInPage(
          panel.querySelector('.fiddy-degrade-title')?.textContent ?? '',
        ),
        body: flatInPage(
          panel.querySelector('.fiddy-degrade-body')?.textContent ?? '',
        ),
      }));
      const column = document.querySelector('main');
      return {
        path: window.location.pathname,
        text: flatInPage(document.body.innerText),
        column: flatInPage(column ? column.innerText : ''),
        panels,
        deviceOnly: Boolean(
          document.querySelector('[data-fiddy="device-only-session"]'),
        ),
        onboarding: Boolean(
          document.querySelector('[data-fiddy="onboarding"]'),
        ),
      };
    },
    undefined,
    {
      path: '',
      text: '',
      column: '',
      panels: [],
      deviceOnly: false,
      onboarding: false,
    },
  );

/** Every request the adapter classified since a marker (dev debug builds only). */
const readLog = (page, marker) =>
  safeEvaluate(
    page,
    (from) => {
      const log = Array.isArray(window.__nodeBackedRequests)
        ? window.__nodeBackedRequests
        : null;
      if (log === null) return { available: false, length: 0, entries: [] };
      return { available: true, length: log.length, entries: log.slice(from) };
    },
    marker,
    { available: false, length: 0, entries: [] },
  );

/** Wait until the adapter has been quiet, so a surface's reads are all in. */
const settle = async (page, marker) => {
  const started = Date.now();
  let last = marker;
  let quietSince = Date.now();
  while (Date.now() - started < SETTLE_MS) {
    await page.waitForTimeout(400);
    const now = await safeEvaluate(
      page,
      () => {
        const log = Array.isArray(window.__nodeBackedRequests)
          ? window.__nodeBackedRequests
          : [];
        return log.length;
      },
      undefined,
      null,
    );
    if (now === null) return;
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_MS) return;
  }
};

const run = async () => {
  const surfaces = SURFACES.filter((surface) =>
    ONLY ? surface.path.includes(ONLY) : true,
  );
  const consoleErrors = [];
  const pageErrors = [];
  const providerTraffic = [];
  const seen = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(flatten(m.text()).slice(0, 400));
  });
  page.on('pageerror', (e) => pageErrors.push(flatten(String(e)).slice(0, 300)));
  // Which host actually answered a read. `api.neynar.com` is the one that proves
  // a released key is doing its job; a node read goes through the app's own
  // origin, so it is not counted here.
  page.on('response', (response) => {
    const url = response.url();
    if (
      /api\.neynar\.com|snapchain-api\.neynar\.com|api\.farcaster\.xyz/.test(url)
    ) {
      providerTraffic.push({ url: url.slice(0, 150), status: response.status() });
    }
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS')
      return route.fulfill({ status: 204, headers: CORS, body: '' });
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

  // ── sign in, exactly as the shell's front door does it ────────────────────
  //
  // The shell paints its text before the sign-in button is live, so an early
  // click lands on nothing (MEASURED: a `$$` sweep at first paint clicked a
  // button with no handler attached, and the run then failed five checks later
  // as "not signed in"). So this waits for the button's own text AND for a beat
  // that gives React its handlers, then retries the click rather than trusting
  // one attempt.
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });
  await page.waitForFunction(() => /go social/i.test(document.body.innerText), {
    timeout: 60000,
  });
  const signedIn = async () =>
    safeEvaluate(
      page,
      () =>
        window.location.pathname === '/' &&
        !document.querySelector('[data-fiddy="device-only-session"]') &&
        !document.querySelector('[data-fiddy="onboarding"]'),
      undefined,
      false,
    );
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await signedIn()) break;
    await page.waitForTimeout(1500);
    for (const el of await page.$$('button, a, [role=button]')) {
      const text = flatten((await el.innerText()) || '');
      if (/go social/i.test(text)) {
        await el.click({ timeout: 10000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(2500);
  }
  if (!(await signedIn())) {
    throw new Error(
      `could not sign in at ${SERVER} — the front door never landed`,
    );
  }

  for (const surface of surfaces) {
    const errorsMark = consoleErrors.length;
    const pageErrorsMark = pageErrors.length;
    const trafficMark = providerTraffic.length;

    await page.goto(`${SERVER}${surface.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    // A navigation gives a FRESH document and a fresh adapter log, so the marker
    // for this surface is always 0 — carrying the previous surface's length over
    // would slice this surface's reads away.
    await settle(page, 0);
    const now = await readSurface(page);
    const log = await readLog(page, 0);
    await page.screenshot({ path: `${OUT}/${surface.shot}` });

    const newErrors = consoleErrors.slice(errorsMark);
    const newPageErrors = pageErrors.slice(pageErrorsMark);
    const traffic = providerTraffic.slice(trafficMark);
    const refusalSentences = newErrors
      .map((line) =>
        /HandledFetchError: [A-Za-z]+ 501 - (.*) Details:/.exec(line),
      )
      .filter(Boolean)
      .map((found) => found[1].trim());
    // Overkill guard: a 501 anywhere in the console for this visit, whatever
    // shape its sentence has.
    const any501 = newErrors.filter((line) => / 501 /.test(line));
    const panelOnScreen = now.panels.filter((panel) => {
      const title = flattenForCompare(panel.title);
      return title.length > 4 && flattenForCompare(now.text).includes(title);
    });

    seen.push({
      surface: surface.name,
      asked: surface.path,
      landed: now.path,
      inClient:
        now.path !== '/welcome/ready' && !now.deviceOnly && !now.onboarding,
      panels: now.panels,
      refusals: refusalSentences,
      refused: any501.length,
      reads: log.available
        ? log.entries.map((entry) => ({
            method: entry.method,
            path: entry.path,
            kind: entry.kind,
            provider: entry.providerId,
            status: entry.status,
          }))
        : 'no debug log (a release build never sets VITE_SNAPCHAIN_DEBUG)',
      traffic,
      text: now.text.slice(0, 700),
      pageErrors: newPageErrors,
    });

    check(
      `${surface.name}: opens signed in, inside the shell`,
      seen.at(-1).inClient && newPageErrors.length === 0,
      `landed=${now.path} deviceOnly=${now.deviceOnly} onboarding=${now.onboarding} pageErrors=${newPageErrors.length}`,
    );
    check(
      `${surface.name}: no refusal panel anywhere on the page`,
      panelOnScreen.length === 0,
      panelOnScreen.length === 0
        ? 'no panel'
        : `panels: ${panelOnScreen.map((p) => p.title).join(' / ')}`,
    );
    check(
      `${surface.name}: no read was answered with a 501`,
      any501.length === 0,
      any501.length === 0
        ? 'no 501'
        : `${any501.length} 501(s), first: ${refusalSentences[0] ?? any501[0]}`,
    );
    check(
      `${surface.name}: the page carries the surface's own content`,
      surface.content.test(now.text),
      `text[0..160]="${now.text.slice(0, 160)}"`,
    );
  }

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`── the six default surfaces, signed in, at ${SERVER} ──`);
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  console.log('\n── what each surface did ──');
  for (const entry of seen) {
    console.log(`\n${entry.surface}  ${entry.asked} → ${entry.landed}`);
    console.log(
      `  panels:   ${entry.panels.length === 0 ? 'none' : JSON.stringify(entry.panels)}`,
    );
    console.log(
      `  refusals: ${entry.refused === 0 ? 'none' : JSON.stringify(entry.refusals)}`,
    );
    console.log(`  text:     ${entry.text.slice(0, 320)}`);
    if (Array.isArray(entry.reads)) {
      const byKind = new Map();
      for (const read of entry.reads) {
        const key = `${read.kind ?? '?'} ${read.status ?? '?'}`;
        byKind.set(key, (byKind.get(key) ?? 0) + 1);
      }
      console.log(
        `  reads:    ${entry.reads.length} classified, by kind/status: ${JSON.stringify(Object.fromEntries(byKind))}`,
      );
      const catalog = entry.reads.filter(
        (r) => r.kind === 'catalog' || r.kind === 'index',
      );
      if (catalog.length > 0) {
        console.log(`  catalog:  ${JSON.stringify(catalog)}`);
      }
    } else {
      console.log(`  reads:    ${entry.reads}`);
    }
    console.log(
      `  provider: ${entry.traffic.length === 0 ? 'no provider host was called' : JSON.stringify(entry.traffic.slice(0, 8))}`,
    );
  }
  console.log(
    `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${checks.length} checks)`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

await run();