// The card a shared fiddy.fun link unfurls as, rendered from the repo's own art.
//
//   node scripts/render-share-card.mjs            # writes public/fiddy-share-card.png
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
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(webRoot, 'public', 'fiddy-share-card.png');

const WIDTH = 1200;
const HEIGHT = 630;

const card = (mascotUrl) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
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
          560px 560px at 81% 72%,
          rgba(212, 255, 63, 0.2),
          rgba(212, 255, 63, 0) 66%
        );
      }
      .mascot {
        position: absolute;
        right: 54px;
        bottom: 26px;
        width: 434px;
        height: 434px;
        object-fit: contain;
      }
      .text {
        position: absolute;
        left: 92px;
        top: 132px;
        max-width: 620px;
      }
      .wordmark {
        font-size: 34px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #d4ff3f;
      }
      .headline {
        margin-top: 18px;
        font-size: 76px;
        line-height: 1.02;
        font-weight: 700;
        letter-spacing: -0.035em;
        color: #eef0e8;
      }
      .line {
        margin-top: 22px;
        font-size: 30px;
        line-height: 1.35;
        color: #b6bcae;
      }
      .address {
        position: absolute;
        left: 92px;
        bottom: 62px;
        font-size: 26px;
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

mkdirSync(path.dirname(outPath), { recursive: true });

// The mascot travels as a data URL rather than a file:// reference: the page is
// set as content (about:blank), and Chrome will not load a local file into a
// document that is not itself a file.
const mascotUrl = `data:image/png;base64,${readFileSync(mascotPath).toString('base64')}`;

// The probes in this directory launch the reader's own Chrome (`channel:
// 'chrome'`) rather than a bundled Chromium, and this follows them: it is the
// browser a shared link is actually opened in, and it is the one whose fonts
// and text rendering the committed card was drawn with.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.setContent(card(mascotUrl), {
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
  writeFileSync(outPath, png);
} finally {
  await browser.close();
}

console.log(`wrote ${outPath} (${WIDTH}x${HEIGHT})`);