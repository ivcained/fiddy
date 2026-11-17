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
// So the probe holds each surface to the contract its providers can actually
// meet. Four of the six (Apps, Your own setup, Updates, Profile) must **load
// with zero reader setup**: the surface's own content on the page, and no read
// answered with a 501 outside the known-unservable class below. The other two (Saved,
// Referrals) hold state no reachable provider has — Neynar's reference has no
// bookmarks, referrals, XP or starter packs (re-checked 2026-11-17) and a
// Snapchain node cannot answer them by construction — so their contract is the
// honest refusal, pinned as a check: they must settle into their own refusal
// rather than hang or fail silently. What to build on those two instead is the
// owner decision on card t_9f7f7075, split out of this card.
//
// The adapter's own request log (`window.__nodeBackedRequests`, filled only
// when a build sets VITE_SNAPCHAIN_DEBUG=true) is read as evidence of which
// server carried the reads, and every request to a provider host is recorded,
// so "Neynar answered the catalog read" is proved rather than assumed. A
// release build never sets the debug flag, so on fiddy.fun the DOM half and the
// provider traffic carry the proof and the log half says so out loud.
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
const CONTENT_TIMEOUT = Number(process.env.CONTENT_TIMEOUT ?? 90000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20000);
const QUIET_MS = Number(process.env.QUIET_MS ?? 2500);
const ONLY = process.env.ONLY ?? '';
// Which profile the probe opens. The default is the SESSION'S OWN profile (the
// shape nav → Profile opens, viewer fid == profile fid), because it is the
// one profile whose connected-accounts section must refuse (linked accounts
// are Warpcast account state, not protocol messages) — and that refusal is
// contained to its own section, so the profile header must still paint. This
// used to default to a public profile while the own-profile view rendered only
// its refusal panel (defect t_c64a428d); with the section contained, the own
// profile is the stricter check. Pass PROFILE_FID=<fid> to watch another one.
const PROFILE_FID = process.env.PROFILE_FID ?? '3';

/**
 * The six surfaces, in the order the nav puts them. Each pattern is drawn from
 * that surface's own component — not from chrome the shell shares with every
 * route — so a check cannot pass on a heading that renders on an empty page.
 *
 * Two expectations, not one. `loads` is the surfaces a reachable provider can
 * serve (Neynar owns the catalog and the index reads; the node owns on-chain
 * state): they must paint their own content with no panel and no 501.
 * `refuses-honestly` is Saved and Referrals: no provider this client can reach
 * holds that state (Neynar's reference has no bookmarks, referrals, XP or
 * starter packs — re-checked 2026-11-17; a Snapchain node cannot answer them by
 * construction), so the honest contract for them is the in-place refusal, and
 * the probe pins THAT: the page must settle into its refusal (its own panel, or
 * the adapter's 501 sentence for the surface's route) rather than hang on a
 * spinner or paint a generic error with nothing behind it. Faking either
 * surface is off the table (standing product rule), and what to do about them
 * long-term is the owner decision on card t_9f7f7075 — this probe only refuses
 * to let them fail SILENTLY.
 */
const SURFACES = [
  {
    name: 'Referrals',
    path: '/~/referrals',
    shot: 'defaults-referrals.png',
    expect: 'refuses-honestly',
    refusal: /xp and rewards|referral/i,
  },
  {
    name: 'Apps',
    path: '/~/apps',
    shot: 'defaults-apps.png',
    expect: 'loads',
    content: /trending|#1 .+caster|your apps/i,
  },
  {
    name: 'Saved',
    path: '/~/saved',
    shot: 'defaults-saved.png',
    expect: 'refuses-honestly',
    refusal: /saved casts|bookmark/i,
  },
  {
    name: 'Your own setup',
    path: '/~/settings/node',
    shot: 'defaults-setup.png',
    expect: 'loads',
    content: /your own setup/i,
  },
  {
    name: 'Updates',
    path: '/~/channel/fc-updates',
    shot: 'defaults-updates.png',
    expect: 'loads',
    content: /fc-updates/i,
  },
  {
    name: 'Profile',
    path: `/~/profiles/${PROFILE_FID}`,
    shot: 'defaults-profile.png',
    expect: 'loads',
    content: /followers|following/i,
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

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/**
 * Refusal sentences from every visit so far, not just the current one: the app
 * PREFETCHES some routes' reads (the XP-rewards read fires during the Apps
 * visit, before Referrals is opened), so a surface's own refusal sentence can
 * land in an earlier window. The sentence names its route (getXPRewards,
 * getBookmarkedCasts, getExploreFeed), so matching against the whole run is
 * still matching THIS surface's read, not another's.
 */
const allRefusalSentences = [];

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
    if (surface.expect === 'loads') {
      // Content first, then quiet: a first visit on a cold dev server can spend
      // a minute optimizing deps, and a fixed settle window would read that as
      // a broken surface. Waiting for the surface's own copy bounds the wait to
      // what the check actually needs.
      await page
        .waitForFunction(
          (patternSource) =>
            new RegExp(patternSource, 'i').test(document.body.innerText),
          surface.content.source,
          { timeout: CONTENT_TIMEOUT },
        )
        .catch(() => {});
    } else {
      // Same idea for the refusal surfaces: wait until the main column holds
      // SOMETHING of its own (its header, its panel, its error copy) — a column
      // that is still empty when the window closes is a silent failure, and
      // that is exactly what this check exists to catch.
      await page
        .waitForFunction(
          () => {
            const column = document.querySelector('main');
            const text = column ? column.innerText : '';
            const panel = document.querySelector(
              '[data-fiddy="node-cannot-answer"]',
            );
            return text.trim().length > 5 || panel !== null;
          },
          undefined,
          { timeout: CONTENT_TIMEOUT },
        )
        .catch(() => {});
    }
    await settle(page, 0);
    const now = await readSurface(page);
    const log = await readLog(page, 0);
    await page.screenshot({ path: `${OUT}/${surface.shot}` });

    const newErrors = consoleErrors.slice(errorsMark);
    const newPageErrors = pageErrors.slice(pageErrorsMark);
    const traffic = providerTraffic.slice(trafficMark);
    const refusalSentences = newErrors
      .map((line) =>
        /HandledFetchError(?:\$\w+)?: [A-Za-z]+ 501 - (.*) Details:/.exec(
          line,
        ),
      )
      .filter(Boolean)
      .map((found) => found[1].trim());
    allRefusalSentences.push(...refusalSentences);
    // Overkill guard: a 501 anywhere in the console for this visit, whatever
    // shape its sentence has.
    const any501 = newErrors.filter((line) => / 501 /.test(line));
    // 501s split by CLASS, not by count. A 501 whose sentence names state no
    // reachable provider holds (Warpcast editorial ranking, Warpcast account
    // state, the XP programme, bookmarks) is the known-unservable class — the
    // owner decision on card t_9f7f7075 — and is REPORTED, because a release
    // with the key cannot fix it and no instrument should pretend otherwise.
    // Any OTHER 501 is a read this build's key was supposed to carry (a catalog
    // or index read going unanswered), and it FAILS the run.
    const UNSERVABLE = /ranking is an indexer|warpcast account state|warpcast programme|xp and rewards|starter packs are|bookmark/i;
    const unservable501 = any501.filter((line) =>
      UNSERVABLE.test(line),
    );
    const keyClass501 = any501.filter((line) => !UNSERVABLE.test(line));

    seen.push({
      surface: surface.name,
      asked: surface.path,
      landed: now.path,
      inClient:
        now.path !== '/welcome/ready' && !now.deviceOnly && !now.onboarding,
      panels: now.panels,
      unservable501,
      keyClass501,
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
        : 'no debug log (a release build never sets VITE_SNAPCHAIN_DEBUG=true)',
      traffic,
      text: now.text.slice(0, 700),
      pageErrors: newPageErrors,
    });

    check(
      `${surface.name}: opens signed in, inside the shell`,
      seen.at(-1).inClient && newPageErrors.length === 0,
      `landed=${now.path} deviceOnly=${now.deviceOnly} onboarding=${now.onboarding} pageErrors=${newPageErrors.length}`,
    );
    if (surface.expect === 'loads') {
      check(
        `${surface.name}: no 501 outside the known-unservable class (the key's reads all answered)`,
        keyClass501.length === 0,
        keyClass501.length === 0
          ? unservable501.length === 0
            ? 'no 501 at all'
            : `${unservable501.length} 501(s), all known-unservable (t_9f7f7075): ${unservable501[0].slice(0, 120)}`
          : `${keyClass501.length} 501(s) the key should have carried, first: ${keyClass501[0].slice(0, 160)}`,
      );
      check(
        `${surface.name}: the page carries the surface's own content`,
        surface.content.test(now.text),
        `text[0..160]="${now.text.slice(0, 160)}"`,
      );
    } else {
      // The honest-refusal contract: the surface must SETTLE into a terminal
      // state — its own refusal panel, the adapter's 501 sentence for its
      // route, or its own error copy — rather than hang on a spinner with
      // nothing behind it. What to build instead of the refusal is the owner
      // decision on card t_9f7f7075.
      const panelEvidence = now.panels.filter((panel) =>
        surface.refusal.test(`${panel.title} ${panel.body}`),
      );
      // See allRefusalSentences above: the surface's own read may refuse
      // during an EARLIER visit's window (prefetch), and a release build's
      // minified class name is `HandledFetchError$1`, which the sentence
      // regex tolerates.
      const refusalEvidence = allRefusalSentences.filter((sentence) =>
        surface.refusal.test(sentence),
      );
      const errorEvidence = /error retrieving data/i.test(now.text)
        ? ['surface error state: Error retrieving data. Please try again.']
        : [];
      const settledIntoRefusal =
        panelEvidence.length > 0 ||
        refusalEvidence.length > 0 ||
        errorEvidence.length > 0;
      check(
        `${surface.name}: settles into its refusal (unservable by any reachable provider; decision on t_9f7f7075)`,
        settledIntoRefusal,
        settledIntoRefusal
          ? `refusal copy: ${(panelEvidence[0]?.body ?? refusalEvidence[0] ?? errorEvidence[0] ?? '').slice(0, 140)}`
          : `no terminal state: panels=${JSON.stringify(now.panels.map((p) => p.title))} refusals=${JSON.stringify(refusalSentences)}`,
      );
    }
  }

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `── the six default surfaces, signed in, at ${SERVER} ──`,
  );
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  // The gaps this release deliberately does NOT close, named so nobody has to
  // mine the per-surface sections for them: every unservable-class 501 and
  // every refusal panel seen, in one place, under the card that owns them.
  const unservable = seen.flatMap((entry) => [
    ...entry.unservable501.map((line) => `${entry.surface}: ${line}`),
    ...entry.panels.map(
      (panel) => `${entry.surface}: panel "${panel.title}"`,
    ),
  ]);
  if (unservable.length > 0) {
    console.log('\n── known-unservable gaps, owned by card t_9f7f7075 ──');
    for (const line of unservable.slice(0, 12)) {
      console.log(`  ${flatten(line).slice(0, 160)}`);
    }
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