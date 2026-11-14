/**
 * "Continue as @you, read-only" — the refusal path, in a real browser.
 *
 * WHAT IT IS FOR
 * Inside a Farcaster client Fiddy signs in from the host's own context. When the
 * host REFUSES (this probe's SDK stub declines the sign-in), the person must not
 * land on the signed-out wall with a QR code for the phone they are holding.
 * They must get their own Following feed, read from public data, with nothing
 * signed, nothing created and no signer minted.
 *
 * TWO SERVERS, BECAUSE THERE ARE TWO CASES
 *   CONTINUE_AS_HOST_SERVER   a dev server whose `@farcaster/miniapp-sdk` is
 *                             `scripts/probe-miniapp-sdk.mjs` (see
 *                             `scripts/probe-continue-as.vite.config.mjs`):
 *                             in a host, host says fid 3 (@dwr), sign-in refused
 *   CONTINUE_AS_PLAIN_SERVER  an ordinary dev server (`scripts/probe.vite.config.mjs`):
 *                             outside any host, where NOTHING about this may appear
 *
 * WHAT IS MEASURED, per width (390 and 1440):
 *   in the host
 *     - the front door offers the host account FIRST, sign-in second, a new
 *       (empty) account last, and the avatar is really there;
 *     - the refusal is a small line at the foot of the page, not a screen: it
 *       does not block the page and takes under a quarter of the viewport;
 *     - nothing was signed in, no account was written, no signer was asked for;
 *     - "Continue as @dwr" opens /feed?as=3 and that feed holds REAL casts;
 *     - the follow graph really read is the HOST'S (fid 3), not a viewer's;
 *     - reading is read-only: no write was submitted, and the note says so.
 *   outside a host
 *     - the front door is the one that shipped ("Look around first" as the
 *       primary action), with no host card anywhere;
 *     - /feed is the anchored public window, with no continue-as surface.
 *
 * BOTH DEV SERVERS NEED `VITE_SNAPCHAIN_DEBUG=true`: the request log the
 * "no signer was minted / nothing was written" checks read is the adapter's own,
 * and a build without the flag has no log to read. The script fails loudly on an
 * absent log rather than passing those checks on nothing.
 *
 * Run:
 *   VITE_SNAPCHAIN_DEBUG=true VITE_SNAPCHAIN_HTTP_URL=... \
 *     npx vite --config scripts/probe-continue-as.vite.config.mjs --port 5234
 *   VITE_SNAPCHAIN_DEBUG=true VITE_SNAPCHAIN_HTTP_URL=... \
 *     npx vite --config scripts/probe.vite.config.mjs --port 5233
 *   CONTINUE_AS_HOST_SERVER=https://localhost:5234 \
 *   CONTINUE_AS_PLAIN_SERVER=https://localhost:5233 \
 *   node apps/farcaster-web/scripts/verify-continue-as.mjs
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const HOST_ORIGIN = process.env.CONTINUE_AS_HOST_SERVER;
const PLAIN_ORIGIN = process.env.CONTINUE_AS_PLAIN_SERVER;
const HOST_FID = Number(process.env.CONTINUE_AS_FID ?? 3);
const HOST_HANDLE = process.env.CONTINUE_AS_HANDLE ?? 'dwr';
const SHOT_DIR =
  process.env.CONTINUE_AS_SHOT_DIR ?? join(tmpdir(), 'fiddy-continue-as');
const WIDTHS = (process.env.CONTINUE_AS_WIDTHS ?? '390,1440')
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

/** Every request the page made, so "nothing was minted" is observable. */
const recordRequests = (page) => {
  const seen = [];
  page.on('request', (request) => {
    seen.push({ url: request.url(), method: request.method() });
  });
  return seen;
};

const waitForText = async (page, text, timeout = 60_000) => {
  await page.waitForFunction(
    (wanted) => (document.body.innerText ?? '').includes(wanted),
    text,
    { timeout },
  );
};

/** The front door's three actions, in DOM order, by what they are. */
const frontDoorActions = () =>
  Array.from(
    document.querySelectorAll(
      '[data-fiddy-step="hi"] button[data-fiddy], [data-fiddy-step="hi"] .fiddy-quiet-btn',
    ),
  ).map((element) => ({
    marker: element.getAttribute('data-fiddy'),
    label: (element.textContent ?? '').trim(),
  }));

const runInHost = async (browser, width) => {
  console.log(`\ninside a Farcaster client, ${width}px`);
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const requests = recordRequests(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${HOST_ORIGIN}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  // The front door learns who the client says is here, and the automatic
  // sign-in runs and is refused. Both are asynchronous.
  await page.waitForSelector('[data-fiddy="host-identity"]', {
    timeout: 60_000,
  });
  await page.waitForSelector('[data-fiddy="miniapp-auto-sign-in-refused"]', {
    timeout: 60_000,
  });

  const actions = await page.evaluate(frontDoorActions);
  const labels = actions.map((action) => action.label);
  const continueLabel = `Continue as @${HOST_HANDLE}`;

  check(
    labels[0] === continueLabel,
    'the host account is the FIRST thing offered',
    labels[0] ?? '(none)',
  );
  check(
    labels.includes('Sign in to post'),
    'signing in is offered second',
    labels.join(' | '),
  );
  check(
    labels[labels.length - 1] === 'Make a new, empty account',
    'a new account is offered LAST, as its own account',
    labels[labels.length - 1] ?? '(none)',
  );

  const avatar = await page.evaluate(() => {
    const card = document.querySelector('[data-fiddy="host-identity"]');
    if (!card) return null;
    const image = card.querySelector('img');
    return {
      text: (card.textContent ?? '').trim().slice(0, 80),
      hasImage: !!image && image.complete && image.naturalWidth > 0,
    };
  });
  check(
    !!avatar?.hasImage,
    'the host account card carries an avatar',
    avatar?.text ?? '(no card)',
  );

  // The refusal is a line, not a wall.
  const refusal = await page.evaluate(() => {
    const card = document.querySelector(
      '[data-fiddy="miniapp-auto-sign-in-refused"]',
    );
    if (!card) return null;
    const box = card.getBoundingClientRect();
    const style = window.getComputedStyle(card);
    return {
      text: (card.textContent ?? '').trim(),
      height: Math.round(box.height),
      viewport: window.innerHeight,
      pointerEvents: style.pointerEvents,
      coversCentre: (() => {
        const point = document.elementFromPoint(
          window.innerWidth / 2,
          window.innerHeight / 2,
        );
        return !!point && card.contains(point);
      })(),
      hasFullScreenChild: Array.from(card.querySelectorAll('*')).some(
        (element) => {
          const child = element.getBoundingClientRect();
          return (
            child.width >= window.innerWidth * 0.98 &&
            child.height >= window.innerHeight * 0.98
          );
        },
      ),
    };
  });
  check(!!refusal, 'the refusal says something');
  check(
    /won’t sign this one in/.test(refusal?.text ?? ''),
    'the refusal is one plain sentence',
    refusal?.text ?? '',
  );
  check(
    refusal?.pointerEvents === 'none',
    'the refusal cannot swallow a tap meant for the page',
    refusal?.pointerEvents ?? '',
  );
  check(
    !refusal?.coversCentre && !refusal?.hasFullScreenChild,
    'the refusal does not cover the page',
    refusal ? `${refusal.height}px of ${refusal.viewport}px` : '',
  );
  check(
    (refusal?.height ?? 0) < (refusal?.viewport ?? 1) * 0.25,
    'the refusal takes less than a quarter of the screen',
    refusal ? `${refusal.height}px` : '',
  );

  // Nothing was signed in, nothing was created, nothing was minted.
  const storage = await page.evaluate(() => ({
    authToken: window.localStorage.getItem('auth-token'),
    accounts: window.localStorage.getItem('fiddy:accounts'),
    host: window.sessionStorage.getItem('fiddy.miniapp.host'),
  }));
  check(!storage.authToken, 'no session was written');
  check(
    !storage.accounts || !/fid/i.test(storage.accounts),
    'no account was created on this device',
    storage.accounts ? storage.accounts.slice(0, 60) : '',
  );
  check(
    !!storage.host && storage.host.includes(String(HOST_FID)),
    'the client’s account is remembered for this tab',
    storage.host ?? '',
  );

  // Continue as @dwr.
  await page.locator('[data-fiddy="host-continue"]').click();
  await page.waitForURL(new RegExp(`/feed\\?as=${HOST_FID}`), {
    timeout: 45_000,
  });
  await page.waitForSelector(
    `[data-fiddy="public-browse"][data-as="${HOST_FID}"]`,
    {
      timeout: 45_000,
    },
  );
  await waitForText(page, `Carrying on as @${HOST_HANDLE}`);

  // The first read is a real follow-graph walk against a public node (one
  // linksByFid for the host, then a castsByFid per account they follow), so it
  // lands seconds after the surface paints. Waiting for the casts rather than
  // asserting on the paint is what makes "real current content" a measurement;
  // the timeout is long enough for a cold node and short enough to fail.
  await page
    .waitForFunction(
      () =>
        Array.from(
          document.querySelector('[data-fiddy="public-browse"]')?.children ??
            [],
        ).some((child) => child.querySelector('a[href*="castHash="]')),
      undefined,
      { timeout: 120_000 },
    )
    .catch(() => undefined);

  const surface = await page.evaluate(() => {
    const root = document.querySelector('[data-fiddy="public-browse"]');
    const cards = Array.from(root?.children ?? []).filter((child) =>
      child.querySelector('a[href*="castHash="]'),
    );
    const note = document.querySelector('[data-fiddy="public-continue-as"]');
    return {
      note: (note?.textContent ?? '').trim(),
      signIn: !!document.querySelector('[data-fiddy="continue-as-sign-in"]'),
      tabs: !!document.querySelector('[data-fiddy="public-tabs"]'),
      cards: cards.length,
      loading: !!document.querySelector('[data-fiddy="public-loading"]'),
      error: !!document.querySelector('[data-fiddy="public-error"]'),
      empty: !!document.querySelector('[data-fiddy="public-empty"]'),
      refusalCard: !!document.querySelector(
        '[data-fiddy="miniapp-auto-sign-in-refused"]',
      ),
      workingOverlay: !!document.querySelector(
        '[data-fiddy="miniapp-auto-sign-in"]',
      ),
      signInPrompt: !!document.querySelector(
        '[data-fiddy="public-sign-in-prompt"]',
      ),
      heading: (document.querySelector('h2')?.textContent ?? '').trim(),
      docTitle: document.title,
      firstCardVisible: (() => {
        const first = cards[0];
        if (!first) return false;
        const box = first.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const point = document.elementFromPoint(
          Math.min(Math.max(box.x + box.width / 2, 1), window.innerWidth - 1),
          Math.min(Math.max(box.y + 20, 1), window.innerHeight - 1),
        );
        return !!point && first.contains(point);
      })(),
    };
  });

  check(
    /Carrying on as @/.test(surface.note) && /Reading only/.test(surface.note),
    'the surface says who it is reading as, and that it is read-only',
    surface.note.slice(0, 120),
  );
  check(surface.signIn, 'there is a way to sign in when posting is wanted');
  check(!surface.tabs, 'a Following feed offers no ranked tabs');
  check(
    surface.heading === 'Following' && surface.docTitle === 'Fiddy / Following',
    'the surface names itself Following, not the anchored Feeds',
    `${surface.heading || '(no heading)'} / ${surface.docTitle}`,
  );
  check(!surface.signInPrompt, 'the anchored-window prompt is not reused');
  check(!surface.loading, 'the feed finished its first read');
  check(!surface.error && !surface.empty, 'the feed has real content');
  check(surface.cards > 0, 'casts are on the page', `${surface.cards} cards`);
  check(
    !surface.refusalCard && !surface.workingOverlay,
    'nothing covers the feed on the read-only surface',
  );
  check(
    surface.firstCardVisible,
    'the first cast is really clickable, not under an overlay',
  );

  // The follow graph read is the HOST's, and nothing was written or minted.
  const reads = await page.evaluate(() =>
    (window.__nodeBackedRequests ?? []).map((entry) => ({
      path: entry.path,
      status: entry.status,
    })),
  );
  // An absent log would make every check below pass on nothing, which is the
  // shape of a green run that proves nothing. Name the cause instead.
  check(
    reads.length > 0,
    'the adapter kept its request log (both dev servers need VITE_SNAPCHAIN_DEBUG=true)',
    `${reads.length} entries`,
  );
  const hostFeedRead = reads.find((entry) =>
    entry.path.endsWith('/v2/feed-items'),
  );
  check(
    !!hostFeedRead,
    'the surface read through the client’s own feed request',
    hostFeedRead?.path ?? '(none)',
  );

  // Which account's graph was walked is visible on the wire, not in the tab:
  // the reader asks the node for that FID's follow links and then for the casts
  // of the accounts it named. Asking for `as:<fid>` in an in-page adapter log
  // would prove only that a string was set; this proves whose feed it is.
  const graphRead = requests.find(
    (request) =>
      request.url.includes('/linksByFid') &&
      request.url.includes(`fid=${HOST_FID}&`),
  );
  check(
    !!graphRead,
    'the follow graph really read is the HOST’S',
    graphRead?.url.split('/v1/')[1] ?? '(no linksByFid for that fid)',
  );
  const followeeReads = requests.filter((request) =>
    request.url.includes('/castsByFid'),
  );
  check(
    followeeReads.length > 0 &&
      followeeReads.every(
        (request) => !request.url.includes(`castsByFid?fid=${HOST_FID}&`),
      ),
    'the casts read are the accounts that fid follows, not the fid itself',
    `${followeeReads.length} account reads`,
  );
  check(
    reads.every((entry) => entry.status !== 501),
    'no read was refused as unsupported',
  );

  const writes = requests.filter(
    (request) =>
      request.url.includes('/v1/submitMessage') ||
      request.url.includes('/api/fiddy/connect') ||
      request.url.includes('/v2/fiddy/connect'),
  );
  check(
    writes.length === 0,
    'no write was submitted and no signer was asked for',
    writes.map((write) => write.url).join(' '),
  );

  const afterStorage = await page.evaluate(() => ({
    authToken: window.localStorage.getItem('auth-token'),
    accounts: window.localStorage.getItem('fiddy:accounts'),
  }));
  check(
    !afterStorage.authToken && afterStorage.accounts === storage.accounts,
    'reading as an account created and signed in nothing',
  );

  check(
    pageErrors.length === 0,
    `no uncaught page errors at ${width}px`,
    pageErrors[0] ?? '',
  );

  await page.screenshot({
    path: join(SHOT_DIR, `continue-as-${width}.png`),
    fullPage: false,
  });

  await context.close();
};

const runOutsideHost = async (browser, width) => {
  console.log(`\noutside any host, ${width}px`);
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${PLAIN_ORIGIN}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForSelector('[data-fiddy="browse-cta"]', { timeout: 60_000 });

  const frontDoor = await page.evaluate(() => ({
    primary: (
      document.querySelector('[data-fiddy="browse-cta"]')?.textContent ?? ''
    ).trim(),
    hostCard: !!document.querySelector('[data-fiddy="host-identity"]'),
    continueAs: !!document.querySelector('[data-fiddy="host-continue"]'),
    refusal: !!document.querySelector(
      '[data-fiddy="miniapp-auto-sign-in-refused"]',
    ),
    note: (
      document.querySelector('.fiddy-sheet-note')?.textContent ?? ''
    ).trim(),
  }));

  check(
    frontDoor.primary === 'Look around first',
    'the front door is the one that shipped',
    frontDoor.primary,
  );
  check(!frontDoor.hostCard && !frontDoor.continueAs, 'no host card appears');
  check(!frontDoor.refusal, 'no refusal line appears');
  check(
    /No account needed to look around or say hi/.test(frontDoor.note),
    'the front door keeps its own note',
    frontDoor.note.slice(0, 80),
  );

  await page.goto(`${PLAIN_ORIGIN}/feed`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForSelector('[data-fiddy="public-browse"]', {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-fiddy="public-loading"]') ||
      !!document.querySelector('[data-fiddy="public-error"]'),
    undefined,
    { timeout: 90_000 },
  );

  const feed = await page.evaluate(() => ({
    as: document
      .querySelector('[data-fiddy="public-browse"]')
      ?.getAttribute('data-as'),
    continueAs: !!document.querySelector('[data-fiddy="public-continue-as"]'),
    prompt: !!document.querySelector('[data-fiddy="public-sign-in-prompt"]'),
    tabs: !!document.querySelector('[data-fiddy="public-tabs"]'),
    title: (document.querySelector('h2')?.textContent ?? '').trim(),
    docTitle: document.title,
  }));

  check(feed.as === null, '/feed is the anchored window, not anybody’s feed');
  check(!feed.continueAs, 'no continue-as surface outside a host');
  check(feed.prompt, 'the shipped signed-out prompt is the one shown');
  check(feed.tabs, 'the shipped tabs are there');
  // `PageTitle` is an `h2` (hidden below `sm`, where the mobile header carries
  // the name instead), so the heading itself plus the document title are the two
  // things a reader actually sees.
  check(
    feed.title === 'Feed' && feed.docTitle === 'Fiddy / Feed',
    '/feed keeps its title',
    `${feed.title || '(no heading)'} / ${feed.docTitle}`,
  );
  check(
    pageErrors.length === 0,
    `no uncaught page errors outside a host at ${width}px`,
    pageErrors[0] ?? '',
  );

  await page.screenshot({
    path: join(SHOT_DIR, `plain-${width}.png`),
    fullPage: false,
  });

  await context.close();
};

const run = async () => {
  if (!HOST_ORIGIN || !PLAIN_ORIGIN) {
    console.error(
      'Set CONTINUE_AS_HOST_SERVER and CONTINUE_AS_PLAIN_SERVER (the two dev servers).',
    );
    process.exit(2);
  }

  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const width of WIDTHS) {
    await runInHost(browser, width);
    await runOutsideHost(browser, width);
  }

  await browser.close();

  console.log(`\nchecks: ${checks}, failures: ${failures}`);
  return failures === 0 ? 0 : 1;
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
