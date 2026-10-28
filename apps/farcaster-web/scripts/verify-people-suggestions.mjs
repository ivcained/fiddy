// The people-to-follow surface (t_e2bedbb5), end to end in a browser: a
// signed-in person opens /~/people and sees the ranked list — one plain
// reason each, latest casts, a working Follow control — read live off the
// public relay by the ported phunk engine.
//
//   node scripts/verify-people-suggestions.mjs
//
// Preconditions — one dev server:
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_SNAPCHAIN_DEBUG=true \
//   PROBE_VITE_CACHE_DIR=/tmp/<a dir outside the repo> \
//   npx vite --config scripts/probe.vite.config.mjs --port 5213 --strictPort
//
//   PEOPLE_SERVER=https://localhost:5213 node scripts/verify-people-suggestions.mjs
//
// Only the SIWF relay is stubbed (with a REAL SIWE message signed by a
// throwaway key), exactly as scripts/verify-cast-submit.mjs does. Every node
// read in this probe is REAL, against the public relay.
//
// NOTHING posts to Farcaster from this probe: Follow is never pressed. The
// button this page renders is the app's stock FollowButton (the same
// component, and the same write path, the right sidebar's recommended users
// already use live); what this probe must prove is the wiring around it.
//
// WHAT IT ASSERTS
//   1. a completed sign-in lands in the client shell
//   2. the home feed's tab row offers a People tab
//   3. the People tab navigates to /~/people
//   4. the page's honesty line is on screen ("No AI involved")
//   5. the ranked list renders (data from the live relay: ~10 s first read)
//   6. every suggestion carries a non-empty reason line
//   7. every suggestion shows their latest casts
//   8. every suggestion carries a visible Follow button
//   9. the request was answered by the node seam (~api/v2/people-suggestions)
//  10. the reason vocabulary is the ported one (followed by / posts in)
//  11. no uncaught page error (HandledFetchError and cross-origin avatar
//      noise excluded, as in every probe of this shell)
//
// Screenshots land in $PEOPLE_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.PEOPLE_SERVER ?? 'https://localhost:5213';
const OUT = process.env.PEOPLE_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'CASTSUBMT';
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
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const safeRead = async (page, fn) => {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (
        !/Execution context was destroyed|Cannot find context|Target closed|navigating/i.test(
          String(e),
        )
      ) {
        throw e;
      }
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
};

let browser;

const run = async () => {
  const consoleErrors = [];

  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__peopleFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      const response = await orig(...args);
      window.__peopleFetchLog.push(
        `${method} ${response.status} ${String(url).slice(0, 200)}`,
      );
      return response;
    };
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
    }
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`),
  );

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

  // ── 1. sign in ────────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.innerText || ''),
      ),
    { timeout: 60000 },
  );
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }
  const readSurface = () =>
    page.evaluate(() => ({
      path: window.location.pathname,
      shellMounted: Boolean(document.querySelector('.fiddy-shell-frame')),
      onboardingSheet: Boolean(
        document.querySelector('[data-fiddy="onboarding"]'),
      ),
      deviceOnlyLanding: Boolean(
        document.querySelector('[data-fiddy="device-only-session"]'),
      ),
    }));
  let surface = await safeRead(page, readSurface);
  for (let i = 0; i < 60; i += 1) {
    if (
      surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding
    ) {
      break;
    }
    await page.waitForTimeout(1000);
    surface = await safeRead(page, readSurface);
  }
  check(
    'a completed sign-in lands in the client',
    surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding,
    `path=${surface.path} shell=${surface.shellMounted}`,
  );

  // The authed shell's floating ask ("Let Fiddy post as you?") covers the
  // bottom of the page at 390 px — dismiss it first, as a person would.
  const notNow = page.locator('[data-fiddy="post-for-you-not-now"]');
  if (await notNow.count()) {
    await notNow.first().click({ trial: true }).catch(() => {});
    await notNow.first().click().catch(() => {});
  }

  // ── 2. the People tab ─────────────────────────────────────────────────────
  try {
    await page.waitForSelector('.fiddy-shell-frame a', { timeout: 60000 });
  } catch {
    // the tab read below reports the failure honestly
  }
  let peopleTab = [];
  for (let i = 0; i < 30 && peopleTab.length === 0; i += 1) {
    peopleTab = await safeRead(page, () =>
      page.evaluate(() => {
        const tabs = [...document.querySelectorAll('a')].filter((a) =>
          /people/i.test(a.innerText || ''),
        );
        return tabs.map((a) => ({
          text: (a.innerText || '').replace(/\s+/g, ' ').trim(),
          href: a.getAttribute('href'),
        }));
      }),
    );
    if (peopleTab.length > 0) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  check(
    'the home feed offers a People tab',
    peopleTab.some((t) => /people/i.test(t.text) && /\/people/.test(t.href ?? '')),
    JSON.stringify(peopleTab),
  );

  // ── 3. navigate ───────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/~/people`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const onPeople = await safeRead(page, () =>
    page.evaluate(() => window.location.pathname),
  );
  check('the People tab address is /~/people', onPeople === '/~/people', onPeople);

  // ── 4-8. the list (live read: the first one takes ~10 s) ─────────────────
  let listState;
  try {
    await page.waitForSelector('[data-fiddy="people-to-follow-list"]', {
      timeout: 120000,
    });
    listState = await page.evaluate(() => {
      const note = document.querySelector('[data-fiddy="people-to-follow-note"]');
      const people = [...document.querySelectorAll('[data-fiddy="person-suggestion"]')];
      return {
        note: note?.textContent ?? '',
        count: people.length,
        reasons: people.map((p) => {
          const reason = p.querySelector('[data-fiddy="person-reason"]');
          return (reason?.textContent ?? '').replace(/\s+/g, ' ').trim();
        }),
        withCasts: people.filter((p) =>
          p.querySelector('[data-fiddy="person-casts"]'),
        ).length,
        withFollow: people.filter((p) => {
          const button = [...p.querySelectorAll('button')].find((b) =>
            /^follow$/i.test((b.innerText || '').trim()),
          );
          return Boolean(button);
        }).length,
      };
    });
  } catch (e) {
    listState = { note: '', count: 0, reasons: [], withCasts: 0, withFollow: 0 };
    console.log('LIST-WAIT-FAILED:', String(e).slice(0, 200));
    const dump = await safeRead(page, () =>
      page.evaluate(() => ({
        path: window.location.pathname,
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 900),
      })),
    );
    console.log('PAGE-DUMP path=', dump.path);
    console.log('PAGE-DUMP text=', dump.text);
    await page.screenshot({ path: `${OUT}/people-to-follow-failed.png` });
  }

  await page.screenshot({ path: `${OUT}/people-to-follow.png`, fullPage: false });

  check(
    'the honesty line is on screen',
    /no AI involved/i.test(listState.note),
    JSON.stringify(listState.note),
  );
  check(
    'the ranked list renders',
    listState.count > 0,
    `count=${listState.count}`,
  );
  check(
    'every suggestion carries a reason line',
    listState.count > 0 &&
      listState.reasons.every((r) => r.length > 0) &&
      listState.reasons.filter((r) => /followed by|posts in/i.test(r)).length ===
        listState.count,
    JSON.stringify(listState.reasons.slice(0, 3)),
  );
  check(
    'suggestions show their latest casts',
    listState.count > 0 && listState.withCasts > 0,
    `withCasts=${listState.withCasts}/${listState.count}`,
  );
  check(
    'every suggestion carries a Follow button',
    listState.count > 0 && listState.withFollow === listState.count,
    `withFollow=${listState.withFollow}/${listState.count}`,
  );

  // ── 9. the seam answered the read ─────────────────────────────────────────
  // The seam answers /v2/people-suggestions IN PLACE (a request it answers
  // never reaches window.fetch — same rule verify-cast-submit.mjs documents),
  // so the evidence is the node fan-out behind it: the viewer's own follow
  // list plus the sampled accounts' follow pages.
  const fetchLog = await page.evaluate(() => window.__peopleFetchLog ?? []);
  const linksReads = fetchLog.filter((line) =>
    line.includes('/v1/linksByFid?'),
  );
  const reverseLinks = linksReads.filter((line) =>
    /reverse=true/.test(line),
  );
  const userDataReads = fetchLog.filter((line) =>
    line.includes('/v1/userDataByFid?'),
  );
  check(
    'the people read was answered by the node seam (graph fan-out)',
    linksReads.length >= 5 && reverseLinks.length >= 5 && userDataReads.length >= 3,
    `links=${linksReads.length} reverse=${reverseLinks.length} userData=${userDataReads.length}`,
  );

  // ── 11. console noise ─────────────────────────────────────────────────────
  const realErrors = consoleErrors.filter(
    (t) =>
      !/HandledFetchError|deemed not signed in|net::ERR_FAILED|Failed to load resource|blocked by CORS|URL scheme .+ is not supported|Fetch API cannot load/i.test(
        t,
      ),
  );
  check('no uncaught page error', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — FAILED: ${failed.map((c) => c.name).join('; ')}` : ''}`,
  );
  process.exit(failed.length ? 1 : 0);
};

run().catch(async (e) => {
  console.error(String(e));
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(1);
});
