/**
 * The picker's search-state machine (components/composer/gifs/gifSearch):
 * loading / results / empty / error / service-off, and the HTTP-to-state
 * mapping — a 404 or 501 is "off", a non-JSON answer is "off" (a static
 * host's SPA fallback), everything else failed is "error".
 */
import { describe, expect, it } from 'vitest';

import {
  gifSearchReducer,
  type GifSearchResult,
  type GifSearchState,
  searchGifs,
} from '~/components/composer/gifs/gifSearch';

const GIF: GifSearchResult = {
  url: 'https://media.tenor.com/x.webp',
  preview: 'https://media.tenor.com/tiny-x.webp',
  w: 480,
  h: 360,
  title: 'a dancing test gif',
  cast: 'https://media.tenor.com/medium-x.gif',
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

describe('gifSearchReducer', () => {
  const idle: GifSearchState = { status: 'idle' };

  it('walks idle -> loading -> results', () => {
    const loading = gifSearchReducer(idle, { type: 'search' });
    expect(loading.status).toBe('loading');
    const results = gifSearchReducer(loading, {
      type: 'results',
      results: [GIF],
    });
    expect(results).toEqual({ status: 'results', results: [GIF] });
  });

  it('reads an empty array as empty, not as results', () => {
    const loading = gifSearchReducer(idle, { type: 'search' });
    expect(gifSearchReducer(loading, { type: 'results', results: [] })).toEqual(
      { status: 'empty' },
    );
  });

  it('keeps error and off as their own states, from anywhere', () => {
    const loading = gifSearchReducer(idle, { type: 'search' });
    expect(gifSearchReducer(loading, { type: 'error' })).toEqual({
      status: 'error',
    });
    expect(gifSearchReducer(loading, { type: 'off' })).toEqual({
      status: 'off',
    });
  });

  it('a retry from error goes back through loading', () => {
    const error = gifSearchReducer(idle, { type: 'error' });
    expect(gifSearchReducer(error, { type: 'search' }).status).toBe('loading');
  });
});

describe('searchGifs', () => {
  it('returns results for a 200 JSON array, same-origin and never cross-origin', async () => {
    let seenUrl = '';
    let seenCredentials: RequestCredentials | undefined;
    const answer = await searchGifs('dance party', {
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenCredentials = init?.credentials;
        return jsonResponse(200, [GIF]);
      }) as typeof fetch,
    });
    expect(answer).toEqual({ ok: true, results: [GIF] });
    expect(seenUrl).toBe('/api/gifs?q=dance%20party');
    expect(seenCredentials).toBe('same-origin');
  });

  it('reads a 501 (mounted but FIDDY_GIFS=off) and a 404 (nothing mounted) as off', async () => {
    for (const status of [501, 404]) {
      const answer = await searchGifs('dance', {
        fetchImpl: (async () => jsonResponse(status, { code: 'X' })) as never,
      });
      expect(answer).toEqual({ ok: false, reason: 'off' });
    }
  });

  it('reads a non-JSON 200 as off: a static host answers the API path with the SPA HTML', async () => {
    const answer = await searchGifs('dance', {
      fetchImpl: (async () =>
        new Response('<!doctype html><title>fiddy</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch,
    });
    expect(answer).toEqual({ ok: false, reason: 'off' });
  });

  it('reads a 500, a network failure, and a wrong-shaped body as error', async () => {
    const fiveHundred = await searchGifs('dance', {
      fetchImpl: (async () => jsonResponse(500, {})) as typeof fetch,
    });
    expect(fiveHundred).toEqual({ ok: false, reason: 'error' });

    const networkDown = await searchGifs('dance', {
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    expect(networkDown).toEqual({ ok: false, reason: 'error' });

    const wrongShape = await searchGifs('dance', {
      fetchImpl: (async () =>
        jsonResponse(200, { nope: true })) as typeof fetch,
    });
    expect(wrongShape).toEqual({ ok: false, reason: 'error' });
  });

  it('drops array entries that are not pickable GIFs only by refusing the whole answer', async () => {
    // The server contract is an array of { url, preview, cast }; anything
    // else is an error state, never a half-trusted grid.
    const answer = await searchGifs('dance', {
      fetchImpl: (async () =>
        jsonResponse(200, [
          { url: 'https://media.tenor.com/x.webp' },
        ])) as never,
    });
    expect(answer).toEqual({ ok: false, reason: 'error' });
  });
});
