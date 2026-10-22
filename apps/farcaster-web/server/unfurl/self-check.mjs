/**
 * The two pages this service serves, rendered from the build under release and
 * checked against the rules the shell itself is held to.
 *
 *   node server/unfurl/self-check.mjs dist/index.html [outDir]
 *
 * This runs inside the release ritual (scripts/release-client.sh step 3), before
 * anything is uploaded: the service renders a cast page and a profile page from
 * fixture data with NO network, and this asserts
 *
 *   1. the page's own `og:` tags are there, exactly once each, naming the page
 *      and a card on this host;
 *   2. the site's front-door tags are gone, because a document that declares
 *      both tells an unfurler whichever one it reads first;
 *   3. everything from `</head>` on is byte-for-byte the shell — the theme
 *      bootstrap, the skeleton and the entry chunk are the app's first paint;
 *   4. nothing in the injected head is inline script or an inline handler, the
 *      same check `scripts/check-shell-has-no-inline-script.mjs` makes of the
 *      shell (that host serves `script-src 'self'`), so a tag that would be
 *      refused in a browser cannot ship;
 *   5. values that came off the network cannot close an attribute — a cast whose
 *      text contains a quote and a handle built out of angle brackets.
 *
 * The rendered documents are written to `<outDir>/` so the ritual (and a person)
 * can grep what will actually be served.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnfurlHandler } from './handler.mjs';
import { pngSize, CARD_WIDTH, CARD_HEIGHT } from './cards.mjs';

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const shellPath = process.argv[2] ?? path.join(webRoot, 'dist', 'index.html');
const outDir = path.resolve(
  process.argv[3] ?? path.join(webRoot, 'unfurl-self-check'),
);
const origin = process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun';

const failures = [];
const note = (line) => console.log(`  ${line}`);
const check = (name, condition, detail) => {
  if (condition) {
    note(`${name}: ok${detail ? ` (${detail})` : ''}`);
    return true;
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  return false;
};

const shell = readFileSync(shellPath, 'utf8');

// WHAT A PAGE IS, built here rather than fetched: the fixtures carry the shapes
// a hostile one takes (a quote, an angle bracket, a long body, no text at all).
const CAST_HASH = `0x${'a'.repeat(40)}`;
const fixtures = {
  cast: {
    cast: {
      hash: CAST_HASH,
      fid: 3,
      text: 'A cast with a "quote" and <brackets> in it, long enough to be clipped by a card that refuses to grow: '.repeat(
        2,
      ),
    },
    author: { fid: 3, username: 'dwr', displayName: 'Dan "Romero" <d>' },
  },
  profile: {
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      bio: 'Interested in technology and other stuff.',
    },
  },
};

const handler = createUnfurlHandler({
  origin,
  shellSource: () => shell,
  siteCard: Buffer.alloc(0),
  renderCard: async () => Buffer.alloc(0),
  reader: {
    cast: async (hash) =>
      hash.toLowerCase() === CAST_HASH ? fixtures.cast : undefined,
    profile: async (fid) =>
      String(fid) === '3' ? fixtures.profile : undefined,
    size: () => 0,
  },
});

const pages = {
  'cast.html': await handler.handle({
    method: 'GET',
    path: `/~/conversations/${CAST_HASH}`,
  }),
  'profile.html': await handler.handle({
    method: 'GET',
    path: '/~/profiles/3',
  }),
};

mkdirSync(outDir, { recursive: true });

const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const count = (html, pattern) => (html.match(pattern) ?? []).length;

for (const [file, answer] of Object.entries(pages)) {
  const html = String(answer.body);
  writeFileSync(path.join(outDir, file), html);

  const isCast = file === 'cast.html';
  const url = isCast
    ? `${origin}/~/conversations/${CAST_HASH}`
    : `${origin}/~/profiles/3`;
  const image = isCast
    ? `${origin}/unfurl/cards/cast/${CAST_HASH}.png`
    : `${origin}/unfurl/cards/profile/3.png`;

  check(
    `${file} answers 200 with the page's own tags`,
    answer.status === 200 &&
      answer.headers['x-unfurl'] === `page:${isCast ? 'cast' : 'profile'}`,
    answer.headers['x-unfurl'],
  );
  check(
    `${file} og:url is this page`,
    html.includes(`<meta property="og:url" content="${url}" />`),
  );
  check(
    `${file} og:image is this page's card`,
    html.includes(`<meta property="og:image" content="${image}" />`),
  );
  check(
    `${file} states the card size`,
    html.includes('<meta property="og:image:width" content="1200" />') &&
      html.includes('<meta property="og:image:height" content="630" />'),
  );
  check(
    `${file} has one og:title, not two`,
    count(html, /<meta property="og:title"/g) === 1,
  );
  check(
    `${file} has one twitter:card, not two`,
    count(html, /<meta name="twitter:card"/g) === 1,
  );
  check(
    `${file} drops the site's front-door tags`,
    !html.includes('fiddy — a Farcaster client with an agent') &&
      !html.includes('/fiddy-share-card.png'),
  );
  check(
    `${file} is the shell after </head>, byte for byte`,
    html.slice(html.indexOf('</head>')) ===
      shell.slice(shell.indexOf('</head>')),
  );
  check(
    `${file} keeps the entry chunk`,
    html.includes(
      shell.match(/<script type="module"[^>]*>/)?.[0] ?? 'NO-ENTRY',
    ),
  );
  check(
    `${file} has no inline script`,
    count(withoutComments(html), /<script\b[^>]*>/gi) ===
      count(withoutComments(shell), /<script\b[^>]*>/gi),
  );
  check(
    `${file} has no inline handler`,
    !/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/i.test(withoutComments(html)),
  );
  // The fixture's hostile values must survive as TEXT: escaped, and not able to
  // open a tag or close an attribute.
  if (isCast) {
    check(
      `${file} escapes the handle it quotes`,
      html.includes('&lt;d&gt;') && html.includes('&quot;'),
    );
    check(
      `${file} cannot be broken out of by a cast body`,
      !html.includes('<brackets>') && !/<script>alert/i.test(html),
    );
  }
}

// The size the tags PROMISE, read out of a PNG the same way the service reads it.
const cardSize = pngSize(
  readFileSync(path.join(webRoot, 'public', 'fiddy-share-card.png')),
);
check(
  'the site card is the size the per-page tags declare',
  cardSize?.width === CARD_WIDTH && cardSize?.height === CARD_HEIGHT,
  cardSize ? `${cardSize.width}x${cardSize.height}` : 'not a PNG',
);

note(`wrote ${Object.keys(pages).join(', ')} to ${outDir}`);

if (failures.length > 0) {
  console.error('unfurl self-check failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(
  "  unfurl self-check ok: both pages carry their own card over this build's own shell",
);
