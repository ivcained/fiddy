/** Signed-out /feed smoke: every rendered cast is top-level on the node. */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const ORIGIN = process.env.FEED_TOP_LEVEL_SERVER ?? 'https://localhost:5279';
const NODE = process.env.FEED_TOP_LEVEL_NODE ?? 'https://haatz.quilibrium.com';
const SHOT_DIR =
  process.env.FEED_TOP_LEVEL_SHOT_DIR ?? join(tmpdir(), 'fiddy-feed-top-level');
const WIDTHS = (process.env.FEED_TOP_LEVEL_WIDTHS ?? '390,1440')
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

const waitForWindow = async (page, kind) => {
  await page.waitForFunction(
    (expectedReads) => {
      const entries = window.__nodeBackedRequests ?? [];
      return (
        entries.filter(
          (entry) =>
            entry.path.endsWith('/v2/feed-items') && entry.status === 200,
        ).length >= expectedReads
      );
    },
    kind === 'trending' ? 2 : 1,
    { timeout: 90_000 },
  );
  await page.waitForSelector('a[href*="/~/conversations/"]', {
    timeout: 90_000,
  });
};

const renderedCasts = () => {
  const cards = Array.from(
    document.querySelectorAll('[data-fiddy="public-browse"] > .fade-in > div'),
  );
  const casts = cards.flatMap((card) => {
    const author = card.querySelector('a[href*="castHash="]');
    if (!author) return [];
    const url = new URL(
      author.getAttribute('href') ?? '',
      window.location.origin,
    );
    const hash = url.searchParams.get('castHash');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!hash || parts.length === 0) return [];
    return [{ hash, handle: decodeURIComponent(parts.at(-1) ?? '') }];
  });
  return { cards: cards.length, casts };
};

const nodeJson = async (path, params) => {
  const url = new URL(path, NODE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${path} answered ${response.status}: ${body.slice(0, 160)}`,
    );
  }
  return response.json();
};

const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const rendered = [];
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`${ORIGIN}/feed`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    for (const kind of ['recent', 'trending']) {
      if (kind === 'trending') {
        await page.getByRole('button', { name: 'Getting attention' }).click();
      }
      console.log(`\n/feed ${kind} at ${width}px`);
      try {
        await waitForWindow(page, kind);
      } catch (error) {
        check(false, 'the feed finishes reading', String(error).slice(0, 160));
        const state = await page.evaluate(() => ({
          requests: window.__nodeBackedRequests ?? null,
          text: document.body.innerText.slice(0, 1200),
        }));
        console.log(JSON.stringify(state, null, 2));
        continue;
      }
      const shown = await page.evaluate(renderedCasts);
      check(shown.cards > 0, 'the page renders casts', `${shown.cards} cards`);
      check(
        shown.casts.length > 0 && shown.casts.every((cast) => cast.handle),
        'every rendered cast has an author and hash',
        `${shown.casts.length} unique casts`,
      );
      check(
        (await page
          .locator('[data-fiddy="public-error"], [data-fiddy="public-empty"]')
          .count()) === 0,
        'the feed has no error or empty state',
      );
      rendered.push(...shown.casts.map((cast) => ({ ...cast, kind, width })));
      await page.screenshot({
        path: join(SHOT_DIR, `feed-${kind}-${width}.png`),
        fullPage: false,
      });
    }
    check(
      pageErrors.length === 0,
      `no uncaught page errors at ${width}px`,
      pageErrors[0] ?? '',
    );
    await context.close();
  }
  await browser.close();

  const unique = [
    ...new Map(
      rendered.map((cast) => [`${cast.handle}:${cast.hash}`, cast]),
    ).values(),
  ];
  console.log(`\n${unique.length} rendered casts checked against the node`);
  await Promise.all(
    unique.map(async (cast) => {
      const where = `@${cast.handle} ${cast.hash.slice(0, 10)}…`;
      try {
        const proof = await nodeJson('/v1/userNameProofByName', {
          name: cast.handle,
        });
        const answer = await nodeJson('/v1/castById', {
          fid: proof.fid,
          hash: cast.hash,
        });
        const body =
          answer?.data?.castAddBody ?? answer?.message?.data?.castAddBody;
        check(
          body && !body.parentCastId && !body.parentUrl,
          `${where} is top-level`,
          body ? '' : 'cast body missing',
        );
      } catch (error) {
        check(
          false,
          `${where} reads back from the node`,
          `${cast.hash}: ${String(error).slice(0, 180)}`,
        );
      }
    }),
  );
  console.log(`\nchecks: ${checks}, failures: ${failures}`);
  return failures === 0 ? 0 : 1;
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
