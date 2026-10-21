// What does this client ACTUALLY do with a real miniapp cast in the feed?
//
//   MINIAPP_SERVER=https://localhost:5180 \
//     node scripts/verify-miniapp-in-feed.mjs
//
// Requires a dev server pointed at a live read node:
//
//   SNAPCHAIN_HTTP_URL=https://<node> npx vite --port 5180
//
// THE FIXTURE, and why this one. The card asked for a cast found *through the
// node* whose embed URL answers `fc:miniapp`, and one recent enough to be inside
// the window a feed renders. A read node keeps no search index, so finding one
// was reading, not guessing:
//
//   1. Neynar's frame catalog listed 50 miniapp hosts;
//   2. each host's author FID was read on the node (`/v1/castsByFid`) and every
//      embed URL those authors had posted was fetched and grepped for
//      `fc:miniapp`. That left 19 frame/miniapp casts — and every one was
//      326–536 days old, because the catalog's authors are not the people
//      posting miniapps this week;
//   3. so the search was inverted: recent casts embedding a known miniapp URL
//      were looked up, and each confirmed back ON THE NODE (`/v1/castById`).
//
// This is the fixture, and the only one the assertions use:
//
//   fid 1062481, cast 0x8b3019a85bdbd946bab5f1105f62f7b926746ace, a TOP-LEVEL
//   cast (a reply never reaches a home feed), text "ask me anything for $0.05",
//   embedding https://beep.works/send/cmi8mtgn500afiolnh4qelc53 whose page
//   carries:
//     <meta name="fc:miniapp" content='{"version":"1",
//       "imageUrl":"…/opengraph-image","button":{"title":"Beep @topp-airdrop",
//       "action":{"type":"launch_miniapp", …}}}'>
//
// fid 259576 (`ogmaro`, 151 follows) follows fid 1062481 — measured on the node,
// `/v1/linksByTargetFid?target_fid=1062481` returned them — so the cast is in
// the feed column of the account this probe signs in as, not merely reachable by
// URL. That distinction is the whole point: a card that only renders on a
// cast-detail page is not an in-feed miniapp card.
//
// AGED_FIXTURE below is the FIRST fixture tried (fid 17, `thefirm.biz/employees/17`,
// button "Inspect e-ID", a genuine `fc:miniapp` cast in fid 3's follow graph) and
// is reported alongside, never asserted: it is 326 days old, so it is inside the
// follow graph but past the end of the newest-first feed the client renders.
// Every path below uses FIXTURE for its assertions; a runner who signs in for
// AGED_FIXTURE's account is measuring the wrong cast.
//
// WHAT IT RECORDS (evidence, not a verdict): the provenance block first (which
// server and which head served the run, the node, the fixture), then every
// console line, every request with its method and status, and — for the fixture
// cast's own card — the image sources, button labels, links and any iframe that
// the card actually put on screen, at 390px and 1440px. Nothing here writes.
// The report is written even when a viewport dies: a crashed run with no report
// on disk is not evidence, it is a gap.
//
// The sign-in is the same real-SIWE stub the sibling probes use (`relay.farcaster.xyz`
// is the only thing stubbed), so the client reaches its signed-in shell for real.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.MINIAPP_SERVER ?? 'https://localhost:5180';
const DOMAIN = new URL(SERVER).host;
const SERVER_HOST = new URL(SERVER).host;
const OUT = process.env.MINIAPP_SHOT_DIR ?? path.join(os.tmpdir(), 'miniapp-in-feed');
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'MINIAPP1';
/**
 * The account this probe signs in as, and why it is not fid 3.
 *
 * A home feed is the newest casts of the accounts you follow, so a fixture
 * cast reaches the column only if the signed-in account follows its author —
 * and only if it is recent enough to be inside the window the client renders.
 * MEASURED: fid 3 (`dwr`, 79 follows) does not follow the fixture's author at
 * all; the fixture's author has 194 followers, and fid 259576 (`ogmaro`, 151
 * follows) was picked from them because a 151-follow account keeps the probe's
 * own read count honest while still rendering a real feed. That the two are
 * linked is a node read, not an assumption —
 * `/v1/linksByTargetFid?target_fid=1062481` returned 259576.
 */
const SIGNED_IN_FID = Number(process.env.MINIAPP_SIGNED_IN_FID ?? 259576);
const SIGNED_IN_USERNAME = process.env.MINIAPP_SIGNED_IN_USERNAME ?? 'ogmaro';
// Budgets, and why they are this large.
//
// MEASURED (2026-10-21, load average 45–49 on 10 cores, two other workers on
// this machine): the dev server compiles each route on first visit, and a cold
// `FollowingPage` under that load did not paint inside 90s — a run then reports
// an empty column, which is the machine's state and not the client's. The
// budgets are env-settable so a slower or calmer machine can say so.
const FEED_BUDGET_MS = Number(process.env.MINIAPP_FEED_BUDGET_MS ?? 240_000);
const SURFACE_BUDGET_MS = Number(process.env.MINIAPP_SURFACE_BUDGET_MS ?? 150_000);
// The sign-in is the longest single wait: the setup flow compiles on first visit,
// the press opens a modal, and the modal waits on the relay. MEASURED
// (2026-10-22 00:33, load average 74): the old hard-coded 120 s expired with the
// browser still on `/welcome/ready`, which read as "this client cannot sign in"
// when it was this machine. Env-settable, and the report says which budget ran.
const SIGNIN_BUDGET_MS = Number(process.env.MINIAPP_SIGNIN_BUDGET_MS ?? 240_000);
const SHOT_MS = Number(process.env.MINIAPP_SHOT_MS ?? 30_000);
const SHOT_RETRY_MS = Number(process.env.MINIAPP_SHOT_RETRY_MS ?? 180_000);

/**
 * The fixture, as measured on the node — and the reason it is this cast.
 *
 * The card asked for a cast found *through the node* whose embed URL answers
 * `fc:miniapp`. Finding one is not a search the node can do (a read node keeps
 * no search index — that is one of the three refused endpoints, in writing, in
 * this repo). It was found by reading:
 *
 *   1. Neynar's frame catalog listed 50 miniapp hosts;
 *   2. each host's author FID was read on the node (`/v1/castsByFid`) and every
 *      embed URL those authors had posted was fetched and grepped for
 *      `fc:miniapp`. That left 19 frame/miniapp casts — and every one of them
 *      was 326–536 days old, because the catalog's authors are not the people
 *      posting miniapps this week;
 *   3. so the search was inverted: recent casts embedding a known miniapp URL
 *      were looked up, and each was confirmed back on THE NODE
 *      (`/v1/castById`) before being used. This cast is 4 hours old at the time
 *      of the run and is a TOP-LEVEL cast, which is what makes it able to reach
 *      a home feed at all.
 *
 * A first fixture (fid 17, thefirm.biz/employees/17, a genuine `fc:miniapp`
 * cast in fid 3's follow graph) was measured too and is reported alongside: it
 * is 326 days old, so it is in the follow graph but past the end of the feed
 * the client renders. Both casts' evidence is in the report; the assertions use
 * the fresh one, because a card only the cast-detail page can reach is not an
 * in-feed card.
 */
const FIXTURE = {
  fid: Number(process.env.MINIAPP_FIXTURE_FID ?? 1062481),
  hash:
    process.env.MINIAPP_FIXTURE_HASH ??
    '0x8b3019a85bdbd946bab5f1105f62f7b926746ace',
  text: process.env.MINIAPP_FIXTURE_TEXT ?? 'ask me anything for $0.05',
  url:
    process.env.MINIAPP_FIXTURE_URL ??
    'https://beep.works/send/cmi8mtgn500afiolnh4qelc53',
  button: process.env.MINIAPP_FIXTURE_BUTTON ?? 'Beep @topp-airdrop',
  image:
    process.env.MINIAPP_FIXTURE_IMAGE ??
    'https://beep.works/send/cmi8mtgn500afiolnh4qelc53/opengraph-image',
};

/** The aged second fixture (fid 17 → fid 3's follow graph), reported not asserted. */
const AGED_FIXTURE = {
  fid: 17,
  hash: '0xac298f3555e453c7b7e0a9338bb9ba065339418b',
  text: 'Colleagues, Co-workers, Comrades',
  url: 'https://thefirm.biz/employees/17',
  button: 'Inspect e-ID',
  image: 'https://thefirm.biz/api/employees/17/og-image',
};

fs.mkdirSync(OUT, { recursive: true });

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

const console_ = [];
const requests = [];
const checks = [];
const check = (name, ok, detail = '') =>
  checks.push({ name, ok: Boolean(ok), detail });

const readSurface = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const main = document.querySelector('main');
        return {
          path: window.location.pathname,
          text,
          columnText: (main?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          columnPresent: Boolean(main),
          onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
          deviceOnlyLanding: Boolean(
            document.querySelector('[data-fiddy="device-only-session"]'),
          ),
          cannotAnswer:
            /didn[’']t load from your node|isn[’']t on your node|could not be loaded from your node|isn[’']t on your node yet/i.test(
              text,
            ),
          nodeRefusal: (text.match(
            /[^.!?]*(isn[’']t on your node|didn[’']t load from your node|No node-backed reader[^.!?]*)[^.!?]*[.!?]?/i,
          ) ?? [])[0] ?? null,
        };
      });
    } catch (error) {
      if (
        !/Execution context was destroyed|Target closed|navigat|Cannot read properties of null/.test(
          String(error),
        )
      ) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  return { path: '', text: '', columnText: '', columnPresent: false };
};

/**
 * The COLUMN's own refusal sentence, or null.
 *
 * MEASURED (2026-10-21): a page-wide predicate is satisfied by the RAIL, which
 * carries 501 panels of its own; it ended the feed wait on the rail's sentence
 * before the column had rendered anything. Every wait below asks the column.
 */
const columnRefusal = (surface) =>
  /didn[’']t load from your node|isn[’']t on your node|could not be loaded|No node-backed reader/i.test(
    surface.columnText,
  );

const readUntil = async (page, done, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  let surface = await readSurface(page);
  while (Date.now() < deadline) {
    if (done(surface)) return surface;
    await page.waitForTimeout(1500);
    surface = await readSurface(page);
  }
  return surface;
};

/**
 * A screenshot is evidence, not the result.
 *
 * MEASURED (2026-10-21 22:24, machine at load average 49 on 10 cores — this
 * probe's own dev server, another worker's `find`s and the media analysis
 * daemon all running): `page.screenshot` timed out at 20s, and a screenshot
 * nobody is waiting on must never end the run. It is retried once with a much
 * longer budget and its failure is reported, not thrown.
 */
const shot = async (page, name) => {
  const budgets = [SHOT_MS, SHOT_RETRY_MS];
  for (const [index, budget] of budgets.entries()) {
    try {
      await page.screenshot({
        path: path.join(OUT, `${name}.png`),
        fullPage: false,
        animations: 'disabled',
        timeout: budget,
      });
      return `${name}.png`;
    } catch (error) {
      if (index === budgets.length - 1) {
        return `(screenshot ${name} skipped: ${String(error).split('\n')[0]})`;
      }
    }
  }
  return `(screenshot ${name} skipped)`;
};

/**
 * Navigate, tolerating a loaded machine.
 *
 * MEASURED (2026-10-21 22:24): `waitUntil: 'domcontentloaded'` on the home feed
 * timed out at 60s at load average 49 — the dev server was still transforming
 * modules. `commit` is the honest wait: the probe then polls the DOM itself, so
 * what it measures is the client's own state, never the network's.
 */
const goTo = async (page, url) => {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 120_000 });
  } catch (error) {
    if (!/Timeout/.test(String(error))) throw error;
  }
};

/**
 * Everything the fixture cast's card put on screen, as four nested containers.
 *
 * The card is the SMALLEST element whose own text carries the cast's text, and
 * the three ancestors above it are dumped with it, because "which box is the
 * card" is exactly the judgement that goes wrong here. MEASURED (2026-10-21):
 * anchoring on `closest('article, li, div[class]')` from the cast's link returns
 * the avatar's wrapper — a DIV with no text, one avatar image and no embed —
 * which reads as "the card has no miniapp anything" on a card that renders a
 * full embed. All four levels are reported, so the evidence shows where the
 * embed actually is instead of the probe's guess about where it should be.
 */
const inspectFixtureCard = (page, fixture = FIXTURE) =>
  page.evaluate((fixture) => {
    const candidates = Array.from(
      document.querySelectorAll('div, article, li, section'),
    ).filter((el) => (el.innerText ?? '').includes(fixture.text));
    candidates.sort(
      (a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length,
    );
    const smallest = candidates[0] ?? null;
    if (!smallest) return { found: false };

    const describe = (el, depth) => ({
      depth,
      tag: el.tagName,
      textLength: (el.innerText ?? '').length,
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      buttonTexts: Array.from(el.querySelectorAll('button, [role=button], a'))
        .map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      images: Array.from(el.querySelectorAll('img')).map((img) => ({
        src: (img.currentSrc || img.src || '').slice(0, 160),
        alt: img.alt || '',
        natural: `${img.naturalWidth}x${img.naturalHeight}`,
      })),
      iframes: Array.from(el.querySelectorAll('iframe')).map((f) => f.src),
      externalLinks: Array.from(el.querySelectorAll('a[href^="http"]'))
        .map((a) => a.href)
        .filter((href) => !href.startsWith(window.location.origin))
        .slice(0, 8),
    });

    const levels = [describe(smallest, 0)];
    let el = smallest;
    for (let depth = 1; depth <= 3 && el?.parentElement; depth += 1) {
      el = el.parentElement;
      levels.push(describe(el, depth));
    }

    const everything = levels.flatMap((level) => [
      ...level.buttonTexts,
      ...level.images.map((i) => i.src),
      ...level.iframes,
    ]);

    return {
      found: true,
      levels,
      levelsHtml: levels.map((level) => level.text).join(' | '),
      containerHtml: smallest.outerHTML.slice(0, 6000),
      // The host of the page the cast embeds. An og:image card would carry an
      // image from this host too, so an image alone proves nothing — the
      // descriptor's BUTTON does, because `og:title` and the frame's button
      // title are different strings.
      //
      // MEASURED BUG (2026-10-21, caught in review): this used to be
      // `everything.some((s) => s.includes(fixture.host))` with the host
      // defaulted to `''` for a fixture that declares no URL — and EVERY string
      // includes `''`, so an undeclared fixture reported `miniappImage=true`
      // whenever the container held any image at all. A fixture with no URL has
      // no measurable image; it now says so instead of answering yes.
      miniappImageMeasured: fixture.host !== '',
      hasMiniappImage:
        fixture.host !== '' && everything.some((s) => s.includes(fixture.host)),
      hasMiniappButton:
        fixture.button !== '' &&
        everything.some((s) => s.includes(fixture.button)),
      // WHICH SOURCE drew the card. A card built from the page's own
      // `fc:miniapp` tag carries the page's declared `imageUrl`; a card built
      // from an index's app entry carries the app's catalog art instead, and the
      // two are different URLs. MEASURED (2026-10-22 01:40): in the feed the art
      // was `beep.works/images/beeper-og-0326.png` (the catalog's) while on the
      // cast page it was `…/send/cmi8…/opengraph-image` (the page's own) — the
      // check used to call both "the miniapp's own image", which hid that.
      hasPageDeclaredImage:
        Boolean(fixture.image) && everything.some((s) => s.includes(fixture.image)),
      fixtureHost: fixture.host,
      hasLaunchAffordance: levels
        .flatMap((l) => l.buttonTexts)
        .some((t) => /launch|open (mini ?app|app)|play/i.test(t)),
      iframeCount: levels.reduce((n, l) => n + l.iframes.length, 0),
      showsEmbedUrl: Boolean(fixture.url) && levels[0].text.includes(fixture.url),
    };
  }, { ...fixture, host: fixture.url ? new URL(fixture.url).host : '' });

/**
 * One line per surface: what the card did, and whether the fixture even has an
 * image to look for.
 *
 * MEASURED (caught in review, 2026-10-21): `found=false` printed
 * `miniappImage=undefined`, which reads as "unknown" when it means "there was no
 * container to look in", and an undeclared-URL fixture printed
 * `miniappImage=true` off any image at all. Both are said in words now.
 */
const cardLine = (card) =>
  card.found
    ? `card found=true miniappImage=${card.hasMiniappImage}${
        card.miniappImageMeasured
          ? ` (looking for ${card.fixtureHost})`
          : ' (the fixture declares no url: not measurable)'
      } pageDescriptorImage=${card.hasPageDeclaredImage} miniappButton=${card.hasMiniappButton} iframes=${card.iframeCount ?? 0}`
    : 'card found=false (no container carries the fixture text)';

const report = [];
const log = (line) => {
  report.push(line);
  console.log(line);
};

// ── provenance, first ───────────────────────────────────────────────────────
// A measurement without its head is not a measurement: the review of this
// card's first run could not attribute a single number to a client revision.
// The probe states the tree IT lives in, the server it drove, and the head that
// served it — the last two cannot be read from inside the browser, so they are
// env-stated and print "(not stated)" rather than a guess.
const probePath = fileURLToPath(import.meta.url);
const gitHead = (dir) => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '(not a git checkout)';
  }
};
log('── provenance ──');
log(`probe: ${probePath} (this tree's HEAD: ${gitHead(path.dirname(probePath))})`);
log(`server the probe drove: ${SERVER}`);
log(
  `head the dev server served: ${process.env.MINIAPP_SERVED_HEAD ?? '(not stated — pass MINIAPP_SERVED_HEAD=<sha>)'}`,
);
log(
  `read node: ${process.env.MINIAPP_NODE ?? '(not stated — pass MINIAPP_NODE=<url>)'}`,
);
log(`fixture: fid ${FIXTURE.fid}, cast ${FIXTURE.hash}, "${FIXTURE.text}", embed ${FIXTURE.url}`);
log(
  `aged second fixture (reported, not asserted): fid ${AGED_FIXTURE.fid}, cast ${AGED_FIXTURE.hash}, embed ${AGED_FIXTURE.url}`,
);
log(`signed in as: fid ${SIGNED_IN_FID} (${SIGNED_IN_USERNAME})`);
log(`screenshots into: ${OUT}`);
log(
  `budgets: sign-in ${SIGNIN_BUDGET_MS / 1000}s · feed ${FEED_BUDGET_MS / 1000}s · surface ${SURFACE_BUDGET_MS / 1000}s · warm-up ${Number(process.env.MINIAPP_WARMUP_MS ?? 240_000) / 1000}s · screenshot ${SHOT_MS / 1000}s then ${SHOT_RETRY_MS / 1000}s`,
);

// `channel: 'chrome'` — the same real Chrome the sibling probes drive. The
// bundled headless shell is not in this machine's playwright cache, and a
// missing browser is not a measurement.
const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});

const runViewport = async ({ label, width, height }) => {
  const context = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const netSeen = [];
  page.on('requestfailed', (r) =>
    netSeen.push({ method: r.method(), url: r.url(), status: 'failed' }),
  );
  page.on('response', (r) =>
    netSeen.push({ method: r.request().method(), url: r.url(), status: r.status() }),
  );
  page.on('console', (m) => console_.push({ viewport: label, type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => console_.push({ viewport: label, type: 'pageerror', text: String(e) }));

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
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
    return route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        state: 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: SIGNED_IN_USERNAME,
        displayName: SIGNED_IN_USERNAME,
      }),
    });
  });

  // ── sign in ─────────────────────────────────────────────────────────────
  //
  // The press happens IN PAGE, in one evaluate, rather than over the wire one
  // element at a time. MEASURED (2026-10-22 00:33, load average 74 on 10 cores):
  // a per-element `innerText()` loop is the slowest thing in this pass, and when
  // the sign-in then does not land, the log said only "path=/welcome/ready" —
  // no word on what was pressed or what the screen was holding. Both are logged
  // now, and the press is made a second time when the first did not reach the
  // client, because the sign-in is a modal with a surface of its own.
  const pressGoSocial = () =>
    page.evaluate(() => {
      const target = Array.from(
        document.querySelectorAll('button, a, [role=button]'),
      ).find((el) => /go social/i.test((el.innerText || '').replace(/\s+/g, ' ')));
      if (!target) return null;
      target.click();
      return (target.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    });
  let pressed = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await goTo(page, `${SERVER}/welcome/ready`);
    try {
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('button, a, [role=button]')).some((el) =>
            /go social/i.test((el.innerText || '').replace(/\s+/g, ' ')),
          ),
        undefined,
        { timeout: SIGNIN_BUDGET_MS },
      );
      pressed = await pressGoSocial();
      break;
    } catch {
      /* retry once */
    }
  }
  // The client, and not merely "not the onboarding sheet".
  //
  // MEASURED (2026-10-21 23:16): the setup flow moved twice while this probe was
  // being written (both sibling cards are live in this repo), and a wait that
  // only asked for "no onboarding marker" was satisfied by `/welcome/ready` —
  // which carries no marker — so the whole run then measured an onboarding
  // screen and reported an empty feed. The path is asked for by name.
  const inClient = (s) =>
    !s.onboardingSheet && !s.deviceOnlyLanding && (s.path === '/' || s.path.startsWith('/~/'));

  /** What the screen was holding when a wait ran out — evidence, not a guess. */
  const holdingNow = () =>
    page
      .evaluate(() => ({
        path: window.location.pathname,
        dialog: (document.querySelector('[role=dialog]')?.innerText ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240),
        buttons: Array.from(document.querySelectorAll('button, a, [role=button]'))
          .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 12),
      }))
      .catch(() => null);

  let afterSignIn = await readUntil(page, inClient, SIGNIN_BUDGET_MS);
  if (!inClient(afterSignIn)) {
    const holding = await holdingNow();
    log(
      `\nsign-in did not reach the client after ${Math.round(SIGNIN_BUDGET_MS / 1000)}s: pressed=${JSON.stringify(pressed)} path=${afterSignIn.path}`,
    );
    if (holding) {
      log(`  screen holding: dialog=${JSON.stringify(holding.dialog)}`);
      log(`  screen holding: buttons=${JSON.stringify(holding.buttons)}`);
    }
    pressed = (await pressGoSocial().catch(() => pressed)) ?? pressed;
    afterSignIn = await readUntil(page, inClient, SIGNIN_BUDGET_MS);
  }
  const shotAfterSignIn = await shot(page, `${label}-1-after-signin`);
  log(`\n── ${label} (${width}px) ──`);
  log(`signed in -> path=${afterSignIn.path} onboarding=${afterSignIn.onboardingSheet} deviceOnly=${afterSignIn.deviceOnlyLanding}`);
  log(`screenshot: ${path.join(OUT, shotAfterSignIn)}`);

  // The ARRIVAL window starts here.
  //
  // MEASURED, and it is why this marker exists (2026-10-22 01:40, this probe's
  // first complete run): the request table used to start at the measured feed
  // pass, so everything the client did while it was still arriving — the bundler
  // and the feed's own warm-up render — was in NO slice at all. That is exactly
  // where the fixture's card gets built (the resolver reads the page once, is
  // refused, asks the index, and caches the answer), so the table could not say
  // where the card's art and words came from. The arrival window is its own
  // slice now, and a request that answers "where did this card come from" cannot
  // fall between the slices again.
  const netAtArrival = netSeen.length;

  // ── the feed, which is where an in-feed card must appear ────────────────
  //
  // `/` opens the RANKED "Home" tab by default, and ranking is an indexer's job
  // — the client says so itself (`getExploreFeed 501 - explore is a ranking, and
  // ranking is an indexer's job`, measured in this probe's own console). The
  // node-backed feed is the FOLLOWING tab, whose tab state is in-memory only, so
  // the probe presses it the way a reader does instead of assuming it is open.
  //
  // A WARM-UP pass comes first and is reported separately: the dev server
  // compiles the feed's chunks on first paint, and on a loaded machine that is
  // the slowest thing in the run (MEASURED: a cold `FollowingPage` did not paint
  // inside 90s at load average 45). The warm-up waits for the column to carry
  // ANY cast, with its own budget, and the measurement that follows is then the
  // client's behaviour rather than the bundler's.
  await goTo(page, `${SERVER}/`);
  const followingTab = page.locator('a[title="Following"]').first();
  const followingTabClicked = (await followingTab.count()) > 0;
  if (followingTabClicked) {
    await followingTab.click({ timeout: 60_000 }).catch(() => {});
  }
  const warmupStart = Date.now();
  await readUntil(
    page,
    () => false,
    Number(process.env.MINIAPP_WARMUP_MS ?? 240_000),
  ).catch(() => {});
  const warmupCasts = await page.evaluate(
    () => document.querySelectorAll('a[href*="/conversations/"]').length,
  );
  log(
    `\nwarm-up: the feed column carried ${warmupCasts} cast link(s) after ${Math.round((Date.now() - warmupStart) / 1000)}s`,
  );
  if (warmupCasts === 0) {
    log(
      '  (an empty column after this budget is the loaded machine, not a verdict — the measurement below still reports what the client said)',
    );
  }
  // Same reason, for the cast page: it is a lazy route of its own, and the
  // measurement below must be the client's, not vite's compile time.
  const detailWarmupStart = Date.now();
  await goTo(page, `${SERVER}/~/conversations/${FIXTURE.hash}`);
  await readUntil(
    page,
    () => false,
    Number(process.env.MINIAPP_WARMUP_MS ?? 240_000) / 2,
  ).catch(() => {});
  log(
    `warm-up: the cast page settled after ${Math.round((Date.now() - detailWarmupStart) / 1000)}s`,
  );
  // Back to the feed for the measured pass, with the tab pressed again because
  // the tab state is in-memory and the navigations above dropped it.
  await goTo(page, `${SERVER}/`);
  if (followingTabClicked) {
    await followingTab.click({ timeout: 60_000 }).catch(() => {});
  }
  const netAtFeed = netSeen.length;
  const feed = await readUntil(
    page,
    (s) => s.columnText.includes(FIXTURE.text) || columnRefusal(s),
    FEED_BUDGET_MS,
  );
  const feedCard = await inspectFixtureCard(page);
  const feedShot = await shot(page, `${label}-2-feed`);
  const feedNet = netSeen.slice(netAtFeed);
  const feedCasts = await page.evaluate(() => {
    const hashes = Array.from(document.querySelectorAll('a[href*="/conversations/"]'))
      .map((a) => a.getAttribute('href').replace(/^.*\/conversations\//, ''))
      .filter(Boolean);
    return [...new Set(hashes)].slice(0, 12);
  });

  log(`\nfeed: path=${feed.path} followingTabClicked=${followingTabClicked} fixtureTextOnScreen=${feed.columnText.includes(FIXTURE.text)}`);
  log(`feed column text: ${feed.columnText.slice(0, 400) || '(empty)'}`);
  log(`cast ids in the column (first 12): ${JSON.stringify(feedCasts)}`);
  log(`feed refusal sentence: ${feed.nodeRefusal ?? '(none)'}`);
  log(`feed card found=${feedCard.found}`);
  if (feedCard.found) {
    for (const level of feedCard.levels) {
      log(
        `  [${level.depth}] <${level.tag}> text=${level.textLength}ch images=${level.images.length} iframes=${level.iframes.length}`,
      );
      log(`      text: ${level.text.slice(0, 300)}`);
      if (level.images.length) log(`      image srcs: ${JSON.stringify(level.images.map((i) => i.src))}`);
      if (level.buttonTexts.length) log(`      buttons/links: ${JSON.stringify(level.buttonTexts.slice(0, 10))}`);
      if (level.externalLinks.length) log(`      external links: ${JSON.stringify(level.externalLinks)}`);
      if (level.iframes.length) log(`      iframes: ${JSON.stringify(level.iframes)}`);
    }
    log(`  miniapp image=${feedCard.hasMiniappImage} (host ${feedCard.fixtureHost || '(none declared)'}) pageDescriptorImage=${feedCard.hasPageDeclaredImage} miniapp button=${feedCard.hasMiniappButton} launch affordance=${feedCard.hasLaunchAffordance} url shown=${feedCard.showsEmbedUrl} iframes=${feedCard.iframeCount ?? 0}`);
  }
  log(`feed screenshot: ${path.join(OUT, feedShot)}`);

  check(
    `${label}: the fixture miniapp cast reaches the feed column`,
    feed.columnText.includes(FIXTURE.text),
    feed.columnText.includes(FIXTURE.text)
      ? 'the cast text is in the column'
      : `not in the column; refusal="${feed.nodeRefusal ?? 'none'}"`,
  );
  check(
    `${label}: the card carries an image from the app's own host (${feedCard.fixtureHost || '(none declared)'})`,
    Boolean(feedCard.found && feedCard.hasMiniappImage),
    feedCard.found
      ? JSON.stringify(feedCard.levels.flatMap((l) => l.images.map((i) => i.src)).slice(0, 5))
      : 'no card container found',
  );
  check(
    `${label}: the card carries the PAGE's own descriptor, not only the index's art`,
    Boolean(feedCard.found && feedCard.hasPageDeclaredImage),
    feedCard.found
      ? `looking for ${FIXTURE.image} in ${JSON.stringify(feedCard.levels.flatMap((l) => l.images.map((i) => i.src)).slice(0, 5))}`
      : 'no card container found',
  );
  check(
    `${label}: the card carries the page's own button words ("${FIXTURE.button}")`,
    Boolean(feedCard.found && feedCard.hasMiniappButton),
    feedCard.found
      ? JSON.stringify(feedCard.levels.flatMap((l) => l.buttonTexts).slice(0, 10))
      : 'no card container found',
  );

  // ── the cast's own page, for comparison ─────────────────────────────────
  const netAtDetail = netSeen.length;
  await goTo(page, `${SERVER}/~/conversations/${FIXTURE.hash}`);
  const detail = await readUntil(
    page,
    (s) => s.columnText.includes(FIXTURE.text) || columnRefusal(s),
    SURFACE_BUDGET_MS,
  );
  const detailCard = await inspectFixtureCard(page);
  const detailShot = await shot(page, `${label}-3-cast-detail`);
  log(`\ncast detail: path=${detail.path} fixtureTextOnScreen=${detail.columnText.includes(FIXTURE.text)}`);
  log(`  refusal sentence: ${detail.nodeRefusal ?? '(none)'}`);
  log(`  ${cardLine(detailCard)}`);
  if (detailCard.found) {
    for (const level of detailCard.levels) {
      log(
        `  [${level.depth}] <${level.tag}> text=${level.textLength}ch images=${level.images.length} iframes=${level.iframes.length} text: ${level.text.slice(0, 260)}`,
      );
      if (level.images.length) log(`      image srcs: ${JSON.stringify(level.images.map((i) => i.src))}`);
    }
  }
  log(`cast-detail screenshot: ${path.join(OUT, detailShot)}`);

  requests.push({
    viewport: label,
    arrival: netSeen.slice(netAtArrival, netAtFeed),
    feed: feedNet,
    detail: netSeen.slice(netAtDetail),
  });

  // ── the aged fixture's own page, reported not asserted ──────────────────
  // It is in `dwr`'s follow graph but 326 days old, so it can never reach that
  // account's home feed (the feed is newest-first). Its value here is that it is
  // a SECOND real `fc:miniapp` cast, from a different host, so the cast-detail
  // reading is not a one-off property of one site.
  await goTo(page, `${SERVER}/~/conversations/${AGED_FIXTURE.hash}`);
  const aged = await readUntil(
    page,
    (s) => s.columnText.includes(AGED_FIXTURE.text) || columnRefusal(s),
    SURFACE_BUDGET_MS,
  );
  const agedCard = await inspectFixtureCard(page, AGED_FIXTURE);
  const agedShot = await shot(page, `${label}-4-aged-fixture-detail`);
  log(`\nsecond (aged) fixture, cast detail: fixtureTextOnScreen=${aged.columnText.includes(AGED_FIXTURE.text)}`);
  log(`  ${cardLine(agedCard)}`);
  if (agedCard.found) {
    for (const level of agedCard.levels) {
      log(
        `  [${level.depth}] <${level.tag}> text=${level.textLength}ch images=${level.images.length} iframes=${level.iframes.length} text: ${level.text.slice(0, 260)}`,
      );
      if (level.images.length) log(`      image srcs: ${JSON.stringify(level.images.map((i) => i.src))}`);
    }
  }
  log(`screenshot: ${path.join(OUT, agedShot)}`);

  await context.close();
};

// MEASURED (2026-10-21 22:54): the first run of this probe died here with
// `page.waitForTimeout: Target page, context or browser has been closed` — and
// the whole report died with it, so the one run whose column DID carry the
// fixture left no request table and no checks. A dead viewport is reported now,
// never fatal: the other viewport still runs, the checks section still prints,
// and the report is still written.
const crashed = [];
for (const viewport of [
  { label: 'mobile-390', width: 390, height: 844 },
  { label: 'desktop-1440', width: 1440, height: 900 },
]) {
  try {
    await runViewport(viewport);
  } catch (error) {
    const line = `${viewport.label}: ${String(error).split('\n')[0]}`;
    crashed.push(line);
    log(`\n!! ${viewport.label} ended early — ${line}`);
  }
}

// A run that lost a viewport must not read as a clean sweep: the count says so.
check(
  'every viewport reached the end of its own pass',
  crashed.length === 0,
  crashed.length > 0 ? crashed.join('; ') : 'both passes completed',
);

await browser.close().catch(() => {});

// ── the evidence, grouped ──────────────────────────────────────────────────
log('\n── requests, by route and answer ──');
// The dev server's own module requests (`/@fs/…`, `/src/…`, `/node_modules/…`)
// are how the page got here, not what it read. They are counted, not listed:
// MEASURED (2026-10-21) they are ~5700 of the ~6100 lines a run produces and
// they buried the protocol reads the report exists for.
const MODULE_REQUEST = /^\/(@fs|@vite|@react-refresh|src|node_modules)\//;
let moduleRequests = 0;
const byRoute = new Map();
for (const group of requests) {
  for (const scope of ['arrival', 'feed', 'detail']) {
    for (const entry of group[scope]) {
      const route = (() => {
        try {
          const u = new URL(entry.url);
          const p = u.pathname.replace(/^\/snapchain-api/, '');
          return /^\/v1\//.test(p) ? `${p} @ ${u.host}` : `${p || '/'} @ ${u.host}`;
        } catch {
          return entry.url;
        }
      })();
      if (MODULE_REQUEST.test(route.split(' @ ')[0]) && route.includes(SERVER_HOST)) {
        moduleRequests += 1;
        continue;
      }
      const key = `${scope} · ${entry.method} ${route} → ${entry.status}`;
      byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
    }
  }
}
log(`  (${moduleRequests} dev-server module requests omitted)`);
for (const [key, count] of [...byRoute].sort((a, b) => a[0].localeCompare(b[0]))) {
  log(`  ${count}× ${key}`);
}

log('\n── console ──');
const consoleLines = console_.filter(
  (c) => c.type !== 'debug' && !/Download the React DevTools|Lit is in dev mode/.test(c.text),
);
if (consoleLines.length === 0) log('  (nothing)');
for (const c of consoleLines.slice(0, 40)) log(`  [${c.viewport}] ${c.type}: ${c.text.slice(0, 300)}`);

log('\n── checks ──');
const failed = checks.filter((c) => !c.ok);
for (const c of checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`);

fs.writeFileSync(
  path.join(OUT, 'miniapp-in-feed.txt'),
  report.join('\n'),
  'utf8',
);
console.log(`\nreport: ${path.join(OUT, 'miniapp-in-feed.txt')}`);
process.exit(0);