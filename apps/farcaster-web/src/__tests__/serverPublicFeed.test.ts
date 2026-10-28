import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPublicFeedCache } from '../../server/public-feed/cache.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const ORIGIN = 'https://fiddy.fun';
const HASH_A = `0x${'a'.repeat(40)}`;
const HASH_B = `0x${'b'.repeat(40)}`;
const HASH_C = `0x${'c'.repeat(40)}`;
const HASH_D = `0x${'d'.repeat(40)}`;
const ADDRESS = `0x${'1'.repeat(40)}`;

const item = ({
  hash,
  text,
  parentHash,
  parentUrl,
  counts = false,
}: {
  hash: string;
  text: string;
  parentHash?: string;
  parentUrl?: string;
  counts?: boolean;
}) => ({
  id: `cast-${hash}`,
  cast: {
    hash,
    fid: 3,
    text,
    timestamp: 1_760_000_000_000,
    ...(parentHash ? { parentHash } : {}),
    ...(parentUrl ? { parentUrl } : {}),
    author: {
      fid: 3,
      username: 'ann"><img src=x>',
      displayName: 'Ann <script>alert(1)</script>',
      custodyAddress: ADDRESS,
      verifiedAddresses: { ethereum: [ADDRESS] },
      authAddresses: [ADDRESS],
    },
    ...(counts
      ? {
          replies: { count: 0 },
          reactions: { count: 0 },
          recasts: { count: 0 },
        }
      : {}),
    embeds: {
      urls: [
        { url: 'https://example.com/a?x=1&y=2' },
        { url: 'javascript:alert(1)' },
        { url: 'http://127.0.0.1/private' },
        { url: 'https://user:pass@example.com/private' },
      ],
    },
  },
});

const result = {
  latestMainCastTimestamp: 1_760_000_000_000,
  items: [
    item({ hash: HASH_A, text: '"><script>alert(1)</script> & hello' }),
    item({ hash: HASH_B, text: 'Measured zero', counts: true }),
    item({ hash: HASH_C, text: 'A reply', parentHash: HASH_A }),
    item({
      hash: HASH_D,
      text: 'A channel post',
      parentUrl: 'https://warpcast.com/~/channel/dev',
    }),
  ],
};

const handler = ({ feed }: { feed?: unknown } = {}) =>
  createUnfurlHandler({
    origin: ORIGIN,
    shellSource: () => shell,
    siteCard: Buffer.from('site card'),
    renderCard: async () => Buffer.from('card'),
    reader: {
      cast: async () => undefined,
      profile: async () => undefined,
      size: () => 0,
    },
    ...(feed === undefined ? {} : { feed }),
  } as never);

const get = async (h: unknown, url = '/feed') =>
  await (
    h as {
      handle: (request: { method: string; path: string }) => Promise<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>;
    }
  ).handle({ method: 'GET', path: url });

const bootFrom = (html: string) => {
  const source =
    /<script type="application\/json" id="fiddy-public-feed-boot">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  return JSON.parse(source ?? 'null') as {
    at: number;
    result: typeof result;
  };
};

describe('the server-drawn public feed', () => {
  it('draws real root casts with Fiddy metadata and a matching boot seed', async () => {
    const answer = await get(
      handler({ feed: { get: async () => ({ at: 1234, result }) } }),
    );

    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('page:feed');
    expect(answer.headers['cache-control']).toBe(
      'public, max-age=60, no-transform',
    );
    expect(answer.body).toContain(
      `<link rel="canonical" href="${ORIGIN}/feed" />`,
    );
    expect(answer.body).toContain('<title>Fiddy / Feed</title>');
    expect(answer.body).toContain('data-fiddy-server-feed');
    expect(answer.body).toContain('#shell-skeleton{display:none}');

    const staticRoot = answer.body.slice(
      answer.body.indexOf('<div id="root">'),
      answer.body.indexOf('<script type="application/json"'),
    );
    expect(staticRoot.match(/data-fiddy-server-cast=/g) ?? []).toHaveLength(2);
    expect(staticRoot).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(staticRoot).not.toContain('<script>alert(1)</script>');
    expect(staticRoot).not.toContain('<img src=x>');
    expect(staticRoot).not.toContain('A reply');
    expect(staticRoot).not.toContain('A channel post');
    expect(staticRoot).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(staticRoot).not.toContain('href="javascript:');
    expect(staticRoot).not.toContain('href="http://127.0.0.1');
    expect(staticRoot).not.toContain('href="https://user:pass@');

    // A missing count is unknown, not zero. The one measured zero is still zero.
    expect(
      staticRoot.match(/data-fiddy-server-like-count=/g) ?? [],
    ).toHaveLength(1);
    expect(staticRoot).toContain('>0</span> likes');

    const boot = bootFrom(answer.body);
    expect(boot.at).toBe(1234);
    expect(boot.result.items.map((entry) => entry.cast.hash)).toEqual([
      HASH_A,
      HASH_B,
    ]);
    expect(boot.result.items[0]?.cast.text).toContain(
      '<script>alert(1)</script>',
    );
    const serialized = JSON.stringify(boot);
    expect(serialized).not.toContain(ADDRESS);
    for (const key of [
      'custodyAddress',
      'verifiedAddresses',
      'verifications',
      'authAddresses',
      'viewerContext',
      'apiKey',
      'signer',
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it.each([
    undefined,
    { get: async () => undefined },
    {
      get: async () => {
        throw new Error('provider unavailable');
      },
    },
  ])(
    'serves the ordinary shell when no honest page is available',
    async (feed) => {
      const answer = await get(handler(feed === undefined ? {} : { feed }));
      expect(answer.status).toBe(200);
      expect(answer.headers['x-unfurl']).toBe('shell');
      expect(answer.body).toBe(shell);
    },
  );
});

describe('the bounded stale-while-refresh feed cache', () => {
  it('waits only for the first-paint budget, then keeps loading in the background', async () => {
    let finish: ((value: typeof result) => void) | undefined;
    let loads = 0;
    const cache = createPublicFeedCache({
      load: () => {
        loads += 1;
        return new Promise<typeof result>((resolve) => {
          finish = resolve;
        });
      },
      waitMs: 5,
      timeoutMs: 100,
    });

    expect(await cache.get()).toBeUndefined();
    expect(loads).toBe(1);
    finish?.(result);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await cache.get())?.result).toBe(result);
    expect(loads).toBe(1);
    expect(cache.stats().entries).toBe(1);
  });

  it('serves a stale page immediately and refreshes it once behind the reader', async () => {
    let clock = 1_000;
    let loads = 0;
    let finish: ((value: typeof result) => void) | undefined;
    const fresh = { ...result, items: result.items.slice(1, 2) };
    const cache = createPublicFeedCache({
      now: () => clock,
      ttlMs: 60,
      load: () => {
        loads += 1;
        if (loads === 1) {
          return Promise.resolve(result);
        }
        return new Promise<typeof result>((resolve) => {
          finish = resolve;
        });
      },
    });

    expect((await cache.get())?.result).toBe(result);
    clock += 61;
    expect((await cache.get())?.result).toBe(result);
    expect((await cache.get())?.result).toBe(result);
    expect(loads).toBe(2);
    finish?.(fresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await cache.get())?.result).toBe(fresh);
  });

  it('fails a stuck read at the hard deadline and can retry honestly', async () => {
    let loads = 0;
    const cache = createPublicFeedCache({
      waitMs: 1,
      timeoutMs: 5,
      retryMs: 0,
      load: () => {
        loads += 1;
        if (loads === 1) {
          return new Promise<typeof result>(() => {});
        }
        return Promise.resolve(result);
      },
    });

    expect(await cache.get()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect((await cache.get())?.result).toBe(result);
    expect(loads).toBe(2);
  });
});
