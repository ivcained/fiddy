/**
 * The per-page unfurl service, held to its contract without a socket.
 *
 * A shared fiddy.fun link to a CAST or a PROFILE now answers with that page's
 * own `og:` tags over the shell this repo builds, plus a 1200x630 card drawn
 * for it — the work t_1e01f488 left carded because a crawler never runs the
 * bundle and the host serves one static document for every route.
 *
 * These tests hold the four things that can actually go wrong:
 *
 *   1. the document — the page's tags replace the site's rather than piling on
 *      top of them, values are escaped, and the REST of the shell comes back
 *      byte-for-byte (the theme bootstrap, the skeleton, the entry chunk: the
 *      shell is the app's first paint);
 *   2. the bundle guard — nothing injected is inline script, because the host
 *      serves `script-src 'self'`;
 *   3. the failures — an unreadable cast, a source that throws, a card that
 *      cannot be drawn: each answers with the shell or the site card, never
 *      with an invented fact and never with a 500 in a crawler's face;
 *   4. the picture — a real PNG at exactly 1200x630, and two casts do not draw
 *      the same card.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCardRenderer, pngSize } from '../../server/unfurl/cards.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';
import {
  escapeHtml,
  oneLine,
  renderPageHtml,
} from '../../server/unfurl/shellMeta.mjs';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

/**
 * Pillow — the card renderer's one real dependency — or an honest skip: without
 * it no card can be drawn on this machine, and this file must not claim one
 * was. The answer is decided once, here, so the skip shows up as a named test.
 */
const pillowReady = (() => {
  try {
    execFileSync('python3', ['-c', 'import PIL.Image'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ORIGIN = 'https://fiddy.fun';

const siteCard = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A reader that answers from a fixture, so no test needs a network. */
const fakeReader = (
  facts: {
    cast?: (hash: string) => unknown;
    profile?: (fid: string) => unknown;
  } = {},
) => ({
  cast: async (hash: string) => facts.cast?.(hash),
  profile: async (fid: string) => facts.profile?.(fid),
  size: () => 0,
});

const handler = (overrides: Record<string, unknown> = {}) =>
  createUnfurlHandler({
    origin: ORIGIN,
    shellSource: () => shell,
    siteCard,
    renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
    reader: fakeReader(),
    ...overrides,
  } as never);

const read = async (url: string, overrides: Record<string, unknown> = {}) =>
  (await handler(overrides).handle({ method: 'GET', path: url })) as {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
  };

const metaContent = (
  html: string,
  attribute: 'property' | 'name',
  key: string,
) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(html);
  return tag?.[1] ?? tag?.[2];
};

const allMeta = (html: string, attribute: 'property' | 'name', key: string) =>
  html.match(new RegExp(`<meta\\s+${attribute}="${key}"[^>]*>`, 'g')) ?? [];

const DW_R = {
  cast: {
    hash: '0xec0c8a227d7f34ad3e2243ae098b46459b7d1847',
    fid: 3,
    text: 'Neat',
  },
  author: { fid: 3, username: 'dwr', displayName: 'Dan Romero' },
};

describe('what a cast page tells a crawler', () => {
  const reader = fakeReader({ cast: () => DW_R });

  it("declares that page's own tags, and drops the site's", async () => {
    const { status, body, headers } = await read(
      `/~/conversations/${DW_R.cast.hash}`,
      { reader },
    );
    const html = body as string;

    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['x-unfurl']).toBe('page:cast');

    // The page's own words, and its own URL — the shell deliberately carries no
    // static og:url, and this is the page that can carry a real one.
    expect(metaContent(html, 'property', 'og:title')).toBe('@dwr: Neat');
    expect(metaContent(html, 'property', 'og:url')).toBe(
      `${ORIGIN}/~/conversations/${DW_R.cast.hash}`,
    );
    expect(metaContent(html, 'property', 'og:type')).toBe('article');
    expect(metaContent(html, 'property', 'og:description')).toBe(
      'Dan Romero on Farcaster.',
    );
    expect(metaContent(html, 'property', 'og:image')).toBe(
      `${ORIGIN}/unfurl/cards/cast/${DW_R.cast.hash}.png`,
    );
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'name', 'twitter:card')).toBe(
      'summary_large_image',
    );
    expect(metaContent(html, 'name', 'twitter:image')).toBe(
      metaContent(html, 'property', 'og:image'),
    );
    expect(html).toContain(`<title>@dwr: Neat</title>`);

    // Exactly one of each: two og:title tags means an unfurler picks one at
    // random, which is how the shell's own front-door title used to leak into
    // every shared cast link.
    for (const key of ['og:title', 'og:description', 'og:image', 'og:url']) {
      expect(allMeta(html, 'property', key)).toHaveLength(1);
    }
    expect(allMeta(html, 'name', 'twitter:title')).toHaveLength(1);
    // The site's own front-door title is gone with the tags that carried it.
    expect(html).not.toContain('fiddy — a Farcaster client with an agent');
  });

  it('is still the app: everything but the head comes back untouched', async () => {
    const { body } = await read(`/~/conversations/${DW_R.cast.hash}`, {
      reader,
    });
    const html = body as string;

    // Byte-for-byte from </head> on, and the same document head up to <head>:
    // the injected tags live in one block between them.
    const shellTail = shell.slice(shell.indexOf('</head>'));
    expect(html.slice(html.indexOf('</head>'))).toBe(shellTail);
    expect(html.slice(0, html.indexOf('<head>'))).toBe(
      shell.slice(0, shell.indexOf('<head>')),
    );

    // The three things a reader's first paint depends on.
    expect(html).toContain('<script src="/shell-bootstrap.js"></script>');
    expect(html).toContain('id="shell-skeleton"');
    // The entry chunk the shell names, whatever this tree's shell calls it (the
    // source shell names /src/index.jsx, a built one names /assets/index-*.js).
    const entry = /<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/.exec(
      shell,
    );
    expect(entry).toBeTruthy();
    expect(html).toContain(entry?.[0] as string);
    // and the mini-app embed is the same one the front door declares, aimed at
    // this page.
    const embed = JSON.parse(metaContent(html, 'name', 'fc:miniapp') as string);
    expect(embed.button.action.url).toBe(
      `${ORIGIN}/~/conversations/${DW_R.cast.hash}`,
    );
    expect(embed.button.action.name).toBe('fiddy');
    expect(embed.button.action.splashBackgroundColor).toBe('#161715');
  });

  it('injects no inline script and no event handler (script-src is self)', async () => {
    const { body } = await read(`/~/conversations/${DW_R.cast.hash}`, {
      reader,
    });
    // The same method as the ritual's own check
    // (`scripts/check-shell-has-no-inline-script.mjs`): comments out first,
    // because the shell explains the `onload=` it used to carry in one.
    const html = (body as string).replace(/<!--[\s\S]*?-->/g, '');

    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    expect(
      scripts.filter((tag) => !/\bsrc\s*=/i.test(tag[1])).map((tag) => tag[0]),
    ).toEqual([]);
    expect(
      [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/gi)].map(
        (m) => m[0],
      ),
    ).toEqual([]);
    // Our block adds no script of its own: the tags are `<meta>` and `<title>`.
    expect(scripts.length).toBe(
      (shell.replace(/<!--[\s\S]*?-->/g, '').match(/<script\b[^>]*>/gi) ?? [])
        .length,
    );
  });

  it('cannot be broken out of by the text it quotes', async () => {
    const hostile = {
      cast: {
        hash: '0x' + 'a'.repeat(40),
        fid: 9,
        text: '"><script>alert(1)</script> and "quotes"',
      },
      author: { fid: 9, username: 'x"><img src=x>', displayName: 'a "b" <c>' },
    };
    const { body } = await read(`/~/conversations/${hostile.cast.hash}`, {
      reader: fakeReader({ cast: () => hostile }),
    });
    const html = body as string;

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
    expect(metaContent(html, 'property', 'og:title')).toContain('&quot;');
    // The values survive as text, escaped once and not twice.
    expect(metaContent(html, 'property', 'og:title')).toContain(
      '&lt;script&gt;',
    );
  });
});

describe('what a profile page tells a crawler', () => {
  const profile = {
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      bio: 'Interested in technology and other stuff.',
    },
  };

  it('declares the profile and its own card', async () => {
    const { body, headers } = await read('/~/profiles/3', {
      reader: fakeReader({ profile: () => profile }),
    });
    const html = body as string;

    expect(headers['x-unfurl']).toBe('page:profile');
    expect(metaContent(html, 'property', 'og:title')).toBe('Dan Romero (@dwr)');
    expect(metaContent(html, 'property', 'og:description')).toBe(
      'Interested in technology and other stuff.',
    );
    expect(metaContent(html, 'property', 'og:image')).toBe(
      `${ORIGIN}/unfurl/cards/profile/3.png`,
    );
    expect(metaContent(html, 'property', 'og:url')).toBe(
      `${ORIGIN}/~/profiles/3`,
    );
    expect(metaContent(html, 'property', 'og:type')).toBe('profile');
  });
});

describe('the pages this service cannot read', () => {
  it('answers with the shell, unchanged, rather than an error', async () => {
    const { status, body, headers } = await read(
      '/~/conversations/0x' + 'b'.repeat(40),
      { reader: fakeReader({}) },
    );
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('shell');
    expect(body).toBe(shell);
    // The site tags are still the site's: this URL unfurls as the front door,
    // exactly as it did before this service existed.
    expect(metaContent(body as string, 'property', 'og:image')).toBe(
      `${ORIGIN}/fiddy-share-card.png`,
    );
  });

  it('answers with the shell when a source throws, not with a 500', async () => {
    const reader = {
      cast: async () => {
        throw new Error('the node is not answering');
      },
      profile: async () => {
        throw new Error('the node is not answering');
      },
      size: () => 0,
    };
    for (const url of [
      `/~/conversations/0x${'c'.repeat(40)}`,
      '/~/profiles/3',
    ]) {
      const { status, body } = await read(url, { reader });
      expect(status).toBe(200);
      expect(body).toBe(shell);
    }
  });

  it('answers a path it does not own with a 404, and a POST with a 405', async () => {
    expect((await read('/index.html')).status).toBe(404);
    expect((await read('/robots.txt')).status).toBe(404);
    // The route FAMILIES without an id are not pages the service has facts for,
    // but they are still the app's own prefix — the answer is the shell, which
    // is what the host served for them before this service existed.
    for (const url of ['/~/conversations', '/~/profiles', '/~/']) {
      const { status, body, headers } = await read(url);
      expect(status).toBe(200);
      expect(headers['x-unfurl']).toBe('shell');
      expect(body).toBe(shell);
    }
    const posted = (await handler().handle({ method: 'POST', path: '/' })) as {
      status: number;
    };
    expect(posted.status).toBe(405);
  });

  it('still serves the app for the routes under the prefix it does not tag', async () => {
    // nginx sends the whole `/~/conversations|profiles/` family here, and the
    // client owns the rest of it: a reaction list, a follower list, a profile
    // tab. Those are pages, not 404s.
    for (const url of [
      `/~/conversations/${'0x' + 'a'.repeat(40)}/reactions`,
      '/~/profiles/3/followers',
      '/~/settings',
    ]) {
      const { status, body, headers } = await read(url);
      expect(status).toBe(200);
      expect(headers['x-unfurl']).toBe('shell');
      expect(body).toBe(shell);
    }
  });
});

describe('the cast-hash index the client asks for', () => {
  it('answers the FID that wrote a cast', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cast-author/${DW_R.cast.hash}`,
      {
        reader: fakeReader({ cast: () => DW_R }),
      },
    );
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(JSON.parse(body as string)).toEqual({
      hash: DW_R.cast.hash,
      fid: 3,
    });
  });

  it('says so when it cannot answer, rather than guessing a FID', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cast-author/0x${'d'.repeat(40)}`,
      {
        reader: fakeReader({}),
      },
    );
    expect(status).toBe(404);
    expect(headers['x-unfurl']).toBe('author:miss');
    expect(JSON.parse(body as string).fid).toBeNull();
  });
});

describe('a card that cannot be drawn', () => {
  it('falls back to the site card, which is the picture this URL had yesterday', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cards/cast/${DW_R.cast.hash}.png`,
      {
        reader: fakeReader({ cast: () => DW_R }),
        renderCard: async () => {
          throw new Error('pillow is not installed');
        },
      },
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['x-unfurl']).toBe('card:site');
    expect(body).toEqual(siteCard);
  });

  it('answers 503 when there is no site card to fall back to', async () => {
    const { status, headers } = await read(
      `/unfurl/cards/cast/${DW_R.cast.hash}.png`,
      {
        reader: fakeReader({ cast: () => DW_R }),
        siteCard: undefined,
        renderCard: async () => {
          throw new Error('pillow is not installed');
        },
      },
    );
    expect(status).toBe(503);
    expect(headers['x-unfurl']).toBe('card:unavailable');
  });

  it('serves the bytes the renderer drew, as image/png', async () => {
    const drawn = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000004b0000000276',
      'hex',
    );
    const { status, body, headers } = await read(
      `/unfurl/cards/profile/3.png`,
      {
        reader: fakeReader({
          profile: () => ({ author: { fid: 3, username: 'dwr' } }),
        }),
        renderCard: async () => drawn,
      },
    );
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('card:profile');
    expect(body).toEqual(drawn);
  });
});

describe('the card renderer, against the real thing', () => {
  const render = createCardRenderer({
    pythonPath: 'python3',
    scriptPath: path.join(webRoot, 'server', 'unfurl', 'render-card.py'),
    mascotPath: path.join(webRoot, 'public', 'fiddy-mark-poster.png'),
  }).render;

  // Three cards, three python3 processes, and a Pillow check: this one is a
  // subprocess test, not a unit test, and it gets its own budget. Without
  // Pillow no card can be drawn at all, so the test is skipped BY NAME rather
  // than passing quietly — a green run must never mean "did not run".
  it.skipIf(!pillowReady)(
    'draws 1200x630 for two different casts and one profile, and they differ',
    async () => {
      const casthash = '0xec0c8a227d7f34ad3e2243ae098b46459b7d1847';
      const other = '0x' + 'e'.repeat(40);
      const cards = [
        await render({
          kind: 'cast',
          hash: casthash,
          text: 'Neat',
          username: 'dwr',
          displayName: 'Dan Romero',
          fid: 3,
        }),
        await render({
          kind: 'cast',
          hash: other,
          text: 'A different cast, with different words in it.',
          username: 'someone',
          fid: 12,
        }),
        await render({
          kind: 'profile',
          fid: 3,
          username: 'dwr',
          displayName: 'Dan Romero',
          bio: 'Interested in technology and other stuff.',
        }),
      ];
      for (const png of cards) {
        expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
      }
      expect(cards[0].equals(cards[1])).toBe(false);
      expect(cards[0].equals(cards[2])).toBe(false);
    },
    60_000,
  );

  it('refuses a card that is not 1200x630', async () => {
    const render = createCardRenderer({
      pythonPath: 'python3',
      scriptPath: path.join(webRoot, 'server', 'unfurl', 'cards.mjs'),
      mascotPath: path.join(webRoot, 'public', 'fiddy-mark-poster.png'),
    }).render;
    await expect(render({ kind: 'cast', text: 'x' })).rejects.toThrow();
  });
});

describe('the copy a card carries', () => {
  it('clips a long line on a word boundary, with one ellipsis', () => {
    expect(oneLine('a  b\n\nc', 40)).toBe('a b c');
    expect(oneLine('word '.repeat(30), 40).endsWith('…')).toBe(true);
    expect(oneLine('word '.repeat(30), 40).length).toBeLessThanOrEqual(41);
  });

  it('escapes everything that could close an attribute', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });

  it('refuses a shell with no head instead of serving it as a page', () => {
    expect(() =>
      renderPageHtml('<html><body>nothing</body></html>', 'x'),
    ).toThrow(/no <\/head>/);
  });
});
