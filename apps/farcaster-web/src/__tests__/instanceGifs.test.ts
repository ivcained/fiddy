/**
 * The same-origin GIF search (server/instance/gifs.mjs), held to its contract:
 * Tenor's search page is parsed into pickable results, the operator's off
 * switch is honest, and failures are never cached.
 */
import { describe, expect, it } from 'vitest';

import { createGifService, gifResults } from '../../server/instance/gifs.mjs';

const tenorPage = (items: unknown[]) =>
  `<html><body><script id="store-cache" type="application/json">${JSON.stringify(
    { universal: { search: { a: { results: items } } } },
  )}</script></body></html>`;

const tenorItem = (overrides: Record<string, unknown> = {}) => ({
  content_description: 'a dancing test gif',
  media_formats: {
    gif: {
      url: 'https://media.tenor.com/full/x.gif',
      size: 3e6,
      dims: [480, 360],
    },
    mediumgif: {
      url: 'https://media.tenor.com/medium/x.gif',
      size: 1.5e6,
      dims: [498, 374],
    },
    tinygif: {
      url: 'https://media1.tenor.com/tiny/x.gif',
      size: 2e5,
      dims: [220, 165],
    },
    webp: {
      url: 'https://media.tenor.com/x.webp',
      size: 9e5,
      dims: [480, 360],
    },
    tinywebp: {
      url: 'https://media.tenor.com/tiny/x.webp',
      size: 8e4,
      dims: [220, 165],
    },
  },
  ...overrides,
});

describe('gifResults', () => {
  it('reads the results a Tenor search page carries, with a castable .gif each', () => {
    const results = gifResults(tenorPage([tenorItem()]));
    expect(results).toHaveLength(1);
    const [gif] = results;
    // the grid shows the light webp pair; the cast embeds the medium .gif
    expect(gif.url).toBe('https://media.tenor.com/x.webp');
    expect(gif.preview).toBe('https://media.tenor.com/tiny/x.webp');
    expect(gif.cast).toBe('https://media.tenor.com/medium/x.gif');
    expect(gif.title).toBe('a dancing test gif');
    expect(gif.w).toBe(480);
    expect(gif.h).toBe(360);
  });

  it('falls back to the full gif, then the tiny one, when the medium is over 4 MB', () => {
    const heavy = tenorItem({
      media_formats: {
        mediumgif: { url: 'https://media.tenor.com/medium/x.gif', size: 9e6 },
        gif: {
          url: 'https://media.tenor.com/full/x.gif',
          size: 3.5e6,
          dims: [480, 360],
        },
        tinygif: { url: 'https://media.tenor.com/tiny/x.gif', size: 2e5 },
        webp: {
          url: 'https://media.tenor.com/x.webp',
          size: 9e5,
          dims: [480, 360],
        },
        tinywebp: { url: 'https://media.tenor.com/tiny/x.webp', size: 8e4 },
      },
    });
    expect(gifResults(tenorPage([heavy]))[0]?.cast).toBe(
      'https://media.tenor.com/full/x.gif',
    );

    const heaviest = tenorItem({
      media_formats: {
        mediumgif: { url: 'https://media.tenor.com/medium/x.gif', size: 9e6 },
        gif: { url: 'https://media.tenor.com/full/x.gif', size: 12e6 },
        tinygif: { url: 'https://media.tenor.com/tiny/x.gif', size: 2e5 },
        webp: {
          url: 'https://media.tenor.com/x.webp',
          size: 9e5,
          dims: [480, 360],
        },
        tinywebp: { url: 'https://media.tenor.com/tiny/x.webp', size: 8e4 },
      },
    });
    expect(gifResults(tenorPage([heaviest]))[0].cast).toBe(
      'https://media.tenor.com/tiny/x.gif',
    );
  });

  it('drops results with no castable .gif, non-Tenor media, or no preview pair', () => {
    const offHost = tenorItem({
      media_formats: {
        gif: { url: 'https://evil.example/x.gif', size: 1e5, dims: [10, 10] },
        webp: { url: 'https://evil.example/x.webp', size: 1e5, dims: [10, 10] },
        tinywebp: { url: 'https://evil.example/t.webp', size: 1e4 },
      },
    });
    const noPreview = tenorItem({
      media_formats: { gif: tenorItem().media_formats.gif },
    });
    expect(gifResults(tenorPage([offHost, noPreview]))).toEqual([]);
  });

  it('answers [] for a page without the store-cache script, and for broken JSON', () => {
    expect(gifResults('<html><body>no results here</body></html>')).toEqual([]);
    expect(gifResults('<script id="store-cache">{not json</script>')).toEqual(
      [],
    );
  });
});

describe('createGifService', () => {
  const okResponse = (items: unknown[]) =>
    new Response(tenorPage(items), { status: 200 });

  it('is off when the operator says so, and the answer says GIFS_OFF', async () => {
    const service = createGifService({
      env: { FIDDY_GIFS: 'off' },
      fetchImpl: (async () => {
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    const answered = await service.search({ q: 'dance', ip: '1' });
    expect(answered.status).toBe(501);
    expect(answered.body).toEqual({ code: 'GIFS_OFF' });
  });

  it('refuses an empty query without asking Tenor', async () => {
    let calls = 0;
    const service = createGifService({
      env: {},
      fetchImpl: (async () => {
        calls += 1;
        return okResponse([]);
      }) as typeof fetch,
    });
    expect((await service.search({ q: '   ', ip: '1' })).status).toBe(400);
    expect(calls).toBe(0);
  });

  it('searches Tenor once per query and serves the hour from cache', async () => {
    const asked: string[] = [];
    const service = createGifService({
      env: {},
      fetchImpl: (async (url) => {
        asked.push(String(url));
        return okResponse([tenorItem()]);
      }) as typeof fetch,
    });
    const first = await service.search({ q: 'Dance Party', ip: '1' });
    const second = await service.search({ q: 'dance party', ip: '2' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/search/Dance-Party-gifs');
    const body = first.body as unknown[];
    expect(body).toHaveLength(1);
  });

  it('never caches a failure: the next search tries Tenor again', async () => {
    let calls = 0;
    const service = createGifService({
      env: {},
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? new Response('upstream sad', { status: 503 })
          : okResponse([tenorItem()]);
      }) as typeof fetch,
      log: () => {},
    });
    await expect(service.search({ q: 'dance', ip: '1' })).rejects.toThrow(
      'tenor 503',
    );
    const retried = await service.search({ q: 'dance', ip: '1' });
    expect(retried.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('rate-limits an IP past 30 searches a minute', async () => {
    const service = createGifService({
      env: {},
      fetchImpl: (async () => okResponse([])) as typeof fetch,
    });
    let last = 0;
    for (let i = 0; i < 35; i += 1) {
      last = (await service.search({ q: `q${i}`, ip: 'flood' })).status;
    }
    expect(last).toBe(429);
  });
});
