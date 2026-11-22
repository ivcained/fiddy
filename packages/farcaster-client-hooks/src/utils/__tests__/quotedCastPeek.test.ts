/**
 * The three questions a quote card asks, as tests.
 *
 * The payloads here are the shapes MEASURED on the live hosted API on
 * 2026-11-14: a quoted cast handed back inside another cast's quote embed
 * carries `embeds: {}`, while the same cast read on its own carries its real
 * buckets — including the `casts` bucket a quote of a quote has.
 *
 * adapted from quilcast (backmeupplz), MIT — the cases upstream's own
 * `src/shared.ts` handling had to answer for, rewritten for this client's
 * buckets.
 */

import { describe, expect, it } from 'vitest';

import { castRefOf, peekOf, quotedOf } from '../quotedCastPeek';

const INNER_HASH = '0xd59f6618f8af7f77242fe48b1f9b87401c23054f';
const OUTER_HASH = '0x7fdee7f9dc6b9d6d709ca5fa1602c9899b4102c0';

const innerCast = (overrides: Record<string, unknown> = {}) => ({
  hash: INNER_HASH,
  threadHash: INNER_HASH,
  author: { fid: 602, username: 'farcaster' },
  text: 'Introducing Farcaster Articles!',
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe('castRefOf', () => {
  it('keeps a real cast hash and a real fid', () => {
    expect(castRefOf({ hash: INNER_HASH, fid: 602 })).toEqual({
      hash: INNER_HASH,
      fid: 602,
    });
  });

  it('drops a fid that addresses nobody', () => {
    expect(castRefOf({ hash: INNER_HASH, fid: 0 })).toEqual({
      hash: INNER_HASH,
    });
    expect(castRefOf({ hash: INNER_HASH, fid: -1 })).toEqual({
      hash: INNER_HASH,
    });
    expect(castRefOf({ hash: INNER_HASH, fid: 1.5 })).toEqual({
      hash: INNER_HASH,
    });
  });

  it('refuses a string that is not a cast hash', () => {
    expect(castRefOf({ hash: 'not-a-hash' })).toBeUndefined();
    expect(castRefOf({ hash: '0x1234' })).toBeUndefined();
    // Forty hex characters and nothing else: a 39- or 41-character string is
    // not a hash a node can resolve, so it is not passed on as one.
    expect(castRefOf({ hash: `0x${'a'.repeat(39)}` })).toBeUndefined();
    expect(castRefOf({ hash: `0x${'a'.repeat(41)}` })).toBeUndefined();
    expect(castRefOf({ hash: undefined })).toBeUndefined();
  });
});

describe('quotedOf', () => {
  it('finds the cast a wordless quote quotes', () => {
    const quoteOfQuote = {
      hash: OUTER_HASH,
      threadHash: OUTER_HASH,
      author: { fid: 1, username: 'pk' },
      text: '',
      // What the live API hands back for the *quoted* half: no words, and its
      // own embeds stripped.
      embeds: {},
    };

    expect(quotedOf(quoteOfQuote)).toBeUndefined();
    expect(
      quotedOf({
        ...quoteOfQuote,
        embeds: { casts: [innerCast()] },
      }),
    ).toEqual({ fid: 602, hash: INNER_HASH, username: 'farcaster' });
  });

  it('names the inner cast without a handle when the payload has none', () => {
    expect(
      quotedOf({ embeds: { casts: [innerCast({ author: { fid: 602 } })] } }),
    ).toEqual({ fid: 602, hash: INNER_HASH });
  });

  it('ignores a quote embed whose hash is malformed', () => {
    expect(
      quotedOf({ embeds: { casts: [innerCast({ hash: '0xnope' })] } }),
    ).toBeUndefined();
  });
});

describe('peekOf', () => {
  it('prefers a picture', () => {
    const image = { type: 'image' as const, url: 'https://img.test/a.png' };
    expect(
      peekOf({
        embeds: {
          images: [image],
          casts: [innerCast()],
        },
      }),
    ).toEqual({ kind: 'image', image });
  });

  it('takes a video poster, and says so when the video has none', () => {
    const withPoster = {
      type: 'video' as const,
      url: 'https://media.test/clip.m3u8',
      thumbnailUrl: 'https://media.test/poster.jpg',
    };
    expect(peekOf({ embeds: { videos: [withPoster] } })).toMatchObject({
      kind: 'video',
      poster: 'https://media.test/poster.jpg',
    });

    // The Firefly HLS / plain-mp4 case: a video whose payload carries no
    // poster. It is still a video — the card draws a stand-in, not a blank
    // tile — but there is no poster to report.
    const withoutPoster = {
      type: 'video' as const,
      url: 'https://media.test/clip.m3u8',
    };
    const peek = peekOf({ embeds: { videos: [withoutPoster] } });
    expect(peek).toEqual({ kind: 'video', video: withoutPoster });
    expect(peek).not.toHaveProperty('poster');
  });

  it('falls through to a link, then to the inner quote', () => {
    const url = {
      type: 'url' as const,
      openGraph: { url: 'https://folio.pedieth.workers.dev' },
    };
    expect(peekOf({ embeds: { urls: [url] } })).toMatchObject({
      kind: 'link',
    });
    expect(
      peekOf({ embeds: { urls: [url], casts: [innerCast()] } }),
    ).toMatchObject({ kind: 'link' });
    expect(peekOf({ embeds: { casts: [innerCast()] } })).toMatchObject({
      kind: 'quote',
      quote: { hash: INNER_HASH },
    });
  });

  it('says a cast with nothing of its own has nothing', () => {
    expect(peekOf({ embeds: {} })).toEqual({ kind: 'none' });
    expect(peekOf({})).toEqual({ kind: 'none' });
  });
});
