/**
 * Reply context must be visible, not just present in the API response.
 *
 * REPLY_CONTEXT_SERVER    default https://fiddy.fun
 * REPLY_CONTEXT_SHOT_DIR  default the system temp dir
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const ORIGIN = process.env.REPLY_CONTEXT_SERVER ?? 'https://fiddy.fun';
const SHOT_DIR =
  process.env.REPLY_CONTEXT_SHOT_DIR ?? join(tmpdir(), 'fiddy-reply-context');
const REPLY = '0xf8efbc8682a7d6b1f0eaa2c5e95140f9931cd5a5';
const PARENT = '0xd7792fbf5004198c0ec37d12e8626b883c8e52a7';
const ROOT = '0x0cfeea5111f372a31502482088ab7959ed08560e';
const REPLY_TEXT = 'Ok we’ll let you block and mute';

mkdirSync(SHOT_DIR, { recursive: true });

let checks = 0;
let failures = 0;
const check = (ok, label, detail = '') => {
  checks += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ headless: true });

/** A dev server has no unfurl service. Proxy its real read-only author handoff. */
const installAuthorHandoff = async (page) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN)) return;
  await page.route('**/unfurl/cast-author/*', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `https://fiddy.fun${url.pathname}`,
    });
    await route.fulfill({ response });
  });
};

try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    console.log(`\n${width}px: the reported reply`);
    await installAuthorHandoff(page);
    await page.goto(`${ORIGIN}/~/conversations/${REPLY}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      (text) => document.querySelector('main')?.textContent?.includes(text),
      REPLY_TEXT,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(1_000);

    const state = await page.evaluate(
      ({ replyHash, parentHash, rootHash }) => {
        const selected = document.querySelector(
          `[data-fiddy="selected-reply"][data-cast-hash="${replyHash}"]`,
        );
        const parent = document.getElementById(`cast:${parentHash}`);
        const root = document.getElementById(`cast:${rootHash}`);
        const context = selected?.querySelector(
          `[data-fiddy="reply-context"][data-parent-hash="${parentHash}"]`,
        );
        const link = context?.querySelector('a[title="Open parent cast"]');
        return {
          selected: Boolean(selected),
          parent: Boolean(parent),
          root: Boolean(root),
          rootFirst: Boolean(
            root &&
            parent &&
            root.compareDocumentPosition(parent) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          parentFirst: Boolean(
            parent &&
            selected &&
            parent.compareDocumentPosition(selected) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          context: context?.textContent ?? '',
          href: link?.getAttribute('href') ?? '',
          horizontalOverflow:
            document.documentElement.scrollWidth > window.innerWidth,
        };
      },
      { replyHash: REPLY, parentHash: PARENT, rootHash: ROOT },
    );
    check(state.selected, 'selected cast is highlighted as a reply');
    check(state.parent, 'the reported parent cast is rendered', PARENT);
    check(state.root, 'the thread root is rendered', ROOT);
    check(state.rootFirst, 'root appears above the parent');
    check(state.parentFirst, 'parent appears above the selected reply');
    check(
      state.context.includes('Replying to @trish'),
      'selected reply names its parent author',
      state.context,
    );
    check(
      state.href === `/~/conversations/${PARENT}`,
      'reply-to line links to the parent cast',
      state.href,
    );
    check(!state.horizontalOverflow, 'no horizontal overflow');
    await page.screenshot({
      path: join(SHOT_DIR, `reply-${width}.png`),
      fullPage: true,
    });

    console.log(`${width}px: a top-level cast stays unchanged`);
    await page.goto(`${ORIGIN}/~/conversations/${ROOT}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => document.querySelector('main')?.textContent?.includes('GM! Today'),
      null,
      { timeout: 60_000 },
    );
    const topLevel = await page.evaluate(() => ({
      selectedReplies: document.querySelectorAll(
        '[data-fiddy="selected-reply"]',
      ).length,
      contexts: document.querySelectorAll('[data-fiddy="reply-context"]')
        .length,
    }));
    check(
      topLevel.selectedReplies === 0,
      'top-level cast has no reply highlight',
    );
    check(topLevel.contexts === 0, 'top-level cast has no reply-to line');
    await page.close();
  }

  const feedPage = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  console.log('\n390px: reply cards in a casts-and-replies feed');
  await feedPage.goto(`${ORIGIN}/statuette/casts-and-replies`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await feedPage.waitForFunction(
    () => document.querySelector('main')?.textContent?.includes('statuette'),
    null,
    { timeout: 60_000 },
  );
  await feedPage.waitForTimeout(5_000);
  const feed = await feedPage.evaluate(() => ({
    replyLines: document.querySelectorAll('[data-fiddy="reply-context"]')
      .length,
    namedLines: [
      ...document.querySelectorAll('[data-fiddy="reply-context"]'),
    ].filter((node) => /Replying to @/.test(node.textContent ?? '')).length,
    replyLinesFit: [
      ...document.querySelectorAll('[data-fiddy="reply-context"]'),
    ].every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }),
  }));
  check(feed.replyLines > 0, 'reply cards carry a reply-to line');
  check(feed.namedLines > 0, 'feed reply-to lines name the parent author');
  check(feed.replyLinesFit, 'feed reply-to lines fit the phone viewport');
  await feedPage.screenshot({
    path: join(SHOT_DIR, 'feed-390.png'),
    fullPage: true,
  });
  await feedPage.close();
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`screenshots: ${SHOT_DIR}`);
if (failures > 0) process.exitCode = 1;
