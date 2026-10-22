// The cards fiddy.fun draws with, rendered from the repo's own art.
//
//   node scripts/render-share-card.mjs            # the og card -> public/fiddy-share-card.png
//   node scripts/render-share-card.mjs embed      # the embed   -> public/fiddy-embed.png
//   node scripts/render-share-card.mjs all        # both
//
// Why this exists, and why it is a script rather than a checked-in drawing:
//
//   * `index.html` is the only thing a crawler reads on this site — the client
//     is an SPA, so every cast, profile and mini app URL answers with the same
//     shell. Until this file existed the shell carried no `og:` tag at all, and
//     the one 1200x630 image on the host was `opengraph.png`: upstream
//     Farcaster's purple brand card, a different product's art.
//   * So the shell points at `/fiddy-share-card.png`, and this is what draws
//     it: the owner's mascot (the same still the chrome paints before the GLB
//     arrives, `fiddy-mark-poster.png`, which already carries its own alpha),
//     the brand's dark ground (#161715), the chartreuse accent (#d4ff3f) and
//     the copy the live mini app poster already ships — no new claim is
//     invented here.
//   * The mascot is the only illustration; the layout is a poster: mark, one
//     line of context, and the address. An unfurl already prints the page's
//     title and description next to this image, so repeating them in the art
//     would read as duplication.
//
// Two cards, one art system, because the two surfaces want different shapes:
//
//   * `share` (1200x630) is the `og:image` / `twitter:image` a crawler lays
//     out — the ratio social platforms expect (1.91:1);
//   * `embed` (1200x800, 3:2) is the `imageUrl` the `fc:miniapp` tag and the
//     app-list manifest both name — the ratio the mini app spec asks of an
//     embed. Measured 2026-10-22 (card t_90a2eee2): that URL was
//     `fiddy.fun/image.png`, an exact-match nginx alias into
//     `/var/www/fiddy-fssc/assets/fiddy-card.png` — the *sibling* FSSC app's
//     asset directory, carrying FSSC's "Network Court" judge art. So Fiddy's
//     app-list icon and every fiddy.fun cast card sat one FSSC art edit away
//     from being repainted. Both surfaces now come from files this repo owns,
//     and this script is where the embed one can be redrawn rather than only
//     replaced by hand.
//
// It uses the Playwright Chromium this repo already installs for its probes, so
// there is nothing extra to fetch, and it needs no network. The font stack is
// the system sans the live mini app card was drawn with; the output is a
// committed PNG, so a machine with different fonts redraws a card only when
// somebody runs this on purpose.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const mascotPath = path.join(webRoot, 'public', 'fiddy-mark-poster.png');

/**
 * The two cards, in the poster language the brand already ships: the mascot on
 * #161715, the wordmark in chartreuse, one line of context, the address.
 *
 * `share`'s numbers are the committed og card's — leave them alone unless the
 * og card is meant to change. `embed` is the same composition given the 3:2
 * canvas the spec asks for, with the extra height spent on a bigger mascot and
 * a lower text block rather than on a band of empty ground (dead space in the
 * frame reads as broken formatting in a feed).
 */
const CARDS = {
  share: {
    file: 'fiddy-share-card.png',
    width: 1200,
    height: 630,
    glow: { size: 560, at: '81% 72%', alpha: 0.2 },
    mascot: { size: 434, right: 54, bottom: 26 },
    text: {
      left: 92,
      top: 132,
      maxWidth: 620,
      wordmark: 34,
      headline: 76,
      line: 30,
      gapWordmark: 18,
      gapLine: 22,
    },
    address: { left: 92, bottom: 62, size: 26 },
  },
  embed: {
    file: 'fiddy-embed.png',
    width: 1200,
    height: 800,
    glow: { size: 660, at: '80% 70%', alpha: 0.2 },
    mascot: { size: 570, right: 34, bottom: 6 },
    text: {
      left: 92,
      top: 214,
      maxWidth: 650,
      wordmark: 36,
      headline: 88,
      line: 34,
      gapWordmark: 20,
      gapLine: 26,
    },
    address: { left: 92, bottom: 74, size: 28 },
  },
};

const card = (spec, mascotUrl) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${spec.width}px; height: ${spec.height}px; overflow: hidden; }
      body {
        position: relative;
        background: #161715;
        color: #eef0e8;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .glow {
        position: absolute;
        inset: 0;
        background: radial-gradient(
          ${spec.glow.size}px ${spec.glow.size}px at ${spec.glow.at},
          rgba(212, 255, 63, ${spec.glow.alpha}),
          rgba(212, 255, 63, 0) 66%
        );
      }
      .mascot {
        position: absolute;
        right: ${spec.mascot.right}px;
        bottom: ${spec.mascot.bottom}px;
        width: ${spec.mascot.size}px;
        height: ${spec.mascot.size}px;
        object-fit: contain;
      }
      .text {
        position: absolute;
        left: ${spec.text.left}px;
        top: ${spec.text.top}px;
        max-width: ${spec.text.maxWidth}px;
      }
      .wordmark {
        font-size: ${spec.text.wordmark}px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #d4ff3f;
      }
      .headline {
        margin-top: ${spec.text.gapWordmark}px;
        font-size: ${spec.text.headline}px;
        line-height: 1.02;
        font-weight: 700;
        letter-spacing: -0.035em;
        color: #eef0e8;
      }
      .line {
        margin-top: ${spec.text.gapLine}px;
        font-size: ${spec.text.line}px;
        line-height: 1.35;
        color: #b6bcae;
      }
      .address {
        position: absolute;
        left: ${spec.address.left}px;
        bottom: ${spec.address.bottom}px;
        font-size: ${spec.address.size}px;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: #9ba193;
      }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <img class="mascot" src="${mascotUrl}" alt="" />
    <div class="text">
      <div class="wordmark">fiddy</div>
      <div class="headline">Meet your Fiddy.</div>
      <div class="line">A little agent. A world to discover.</div>
    </div>
    <div class="address">fiddy.fun</div>
  </body>
</html>`;

// Which cards to draw: the first argument names one (`share`, `embed`) or says
// `all`. An unknown name lists what there is rather than drawing the wrong card.
const requested = process.argv[2] ?? 'share';
const names =
  requested === 'all'
    ? Object.keys(CARDS)
    : Object.keys(CARDS).filter((name) => name === requested);
if (names.length === 0) {
  console.error(
    `unknown card "${requested}" — known cards: ${Object.keys(CARDS).join(', ')}, all`,
  );
  process.exit(2);
}

// The mascot travels as a data URL rather than a file:// reference: the page is
// set as content (about:blank), and Chrome will not load a local file into a
// document that is not itself a file.
const mascotUrl = `data:image/png;base64,${readFileSync(mascotPath).toString('base64')}`;

// The probes in this directory launch the reader's own Chrome (`channel:
// 'chrome'`) rather than a bundled Chromium, and this follows them: it is the
// browser a shared link is actually opened in, and it is the one whose fonts
// and text rendering the committed cards were drawn with.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const name of names) {
    const spec = CARDS[name];
    const outPath = path.join(webRoot, 'public', spec.file);
    mkdirSync(path.dirname(outPath), { recursive: true });
    const page = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(card(spec, mascotUrl), {
      waitUntil: 'load',
    });
    // Wait for the mascot to have decoded, or the card screenshots an empty slot
    // instead of the drawing.
    await page.waitForFunction(
      () => {
        const image = document.querySelector('img.mascot');
        return image !== null && image.complete && image.naturalWidth > 0;
      },
      undefined,
      { timeout: 15000 },
    );
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${spec.width}x${spec.height})`);
  }
} finally {
  await browser.close();
}
