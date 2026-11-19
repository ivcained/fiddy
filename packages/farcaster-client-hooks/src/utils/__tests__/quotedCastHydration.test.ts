/**
 * A quote of a quote gets its inner cast back.
 *
 * MEASURED (the hosted API, 2026-11-14): a cast handed back inside another cast's
 * quote embed carries `embeds: {}`. The hydration fetch exists because of that,
 * and these tests pin what its result is allowed to restore — including the one
 * thing the card needs in order to open the inner cast rather than promise
 * content it cannot produce.
 */

import type { ApiQuoteCastEmbed } from 'farcaster-client-data';
import { describe, expect, it } from 'vitest';

import {
  carriesEmbeds,
  mergeHydratedEmbeds,
  mergeSpaceUrlEmbeds,
} from '../quotedCastHydration';

const INNER_HASH = '0xd59f6618f8af7f77242fe48b1f9b87401c23054f';
const OUTER_HASH = '0x7fdee7f9dc6b9d6d709ca5fa1602c9899b4102c0';
const SPACE_URL = 'https://warpcast.com/~/spaces/design';

const asQuote = (cast: Record<string, unknown>) =>
  cast as unknown as ApiQuoteCastEmbed;

/** The wordless quote as it arrives: no words, and an empty embed payload. */
const thin = asQuote({
  hash: OUTER_HASH,
  threadHash: OUTER_HASH,
  author: { fid: 1, username: 'pk' },
  text: '',
  embeds: {},
  timestamp: 1_700_000_000_000,
});

/** The same cast, hydrated: it says which cast it quotes. */
const hydratedWithInnerQuote = asQuote({
  hash: OUTER_HASH,
  threadHash: OUTER_HASH,
  author: { fid: 1, username: 'pk' },
  text: '',
  embeds: {
    images: [],
    urls: [],
    unknowns: [],
    casts: [
      {
        hash: INNER_HASH,
        threadHash: INNER_HASH,
        author: { fid: 602, username: 'farcaster' },
        text: 'Introducing Farcaster Articles!',
        timestamp: 1_700_000_000_000,
      },
    ],
  },
  timestamp: 1_700_000_000_000,
});

describe('carriesEmbeds', () => {
  it('says yes to a cast that carries the cast it quotes', () => {
    expect(carriesEmbeds(hydratedWithInnerQuote)).toBe(true);
  });

  it('says yes to a cast that carries a space URL', () => {
    expect(
      carriesEmbeds({
        ...thin,
        embeds: { urls: [{ openGraph: { url: SPACE_URL } }] },
      } as never),
    ).toBe(true);
  });

  it('says no to the thin payload, and to nothing at all', () => {
    expect(carriesEmbeds(thin)).toBe(false);
    expect(carriesEmbeds(undefined)).toBe(false);
  });
});

describe('mergeHydratedEmbeds', () => {
  it('gives a wordless quoted cast the inner cast it quotes', () => {
    const merged = mergeHydratedEmbeds({
      cast: thin,
      sourceCast: hydratedWithInnerQuote,
    });

    expect(merged.embeds?.casts?.[0]?.hash).toBe(INNER_HASH);
    expect(merged.embeds?.casts?.[0]?.author?.username).toBe('farcaster');
  });

  it('leaves a quoted cast that has content of its own alone', () => {
    const withText = asQuote({ ...thin, text: 'look at this' });
    const merged = mergeHydratedEmbeds({
      cast: withText,
      sourceCast: hydratedWithInnerQuote,
    });

    expect(merged).toBe(withText);
  });

  it('keeps the bucket the payload already had', () => {
    const withOwnImage = asQuote({
      ...thin,
      embeds: { images: [{ url: 'https://img.test/a.jpg' }] },
    });
    const merged = mergeHydratedEmbeds({
      cast: withOwnImage,
      sourceCast: hydratedWithInnerQuote,
    });

    // Content of its own means no merge at all: what the reader was handed wins.
    expect(merged).toBe(withOwnImage);
  });

  it('does nothing without a source cast, or when the source is empty too', () => {
    const emptySource = asQuote({ ...thin, embeds: {} });

    expect(mergeHydratedEmbeds({ cast: thin, sourceCast: undefined })).toBe(
      thin,
    );
    expect(
      mergeHydratedEmbeds({ cast: thin, sourceCast: emptySource as never }),
    ).toBe(thin);
  });

  it('does not bring back a deleted cast', () => {
    const deleted = asQuote({ ...thin, deleted: true });

    expect(
      mergeHydratedEmbeds({
        cast: deleted,
        sourceCast: hydratedWithInnerQuote,
      }),
    ).toBe(deleted);
  });
});

describe('mergeSpaceUrlEmbeds', () => {
  it('adds the space URL the thin payload lost', () => {
    const merged = mergeSpaceUrlEmbeds({
      cast: thin,
      sourceCast: {
        ...thin,
        embeds: { urls: [{ openGraph: { url: SPACE_URL } }] },
      } as never,
    });

    expect(merged.embeds?.urls?.[0]?.openGraph?.url).toBe(SPACE_URL);
  });

  it('does not add the same space URL twice', () => {
    const already = asQuote({
      ...thin,
      embeds: { urls: [{ openGraph: { url: SPACE_URL } }] },
    });
    const merged = mergeSpaceUrlEmbeds({
      cast: already,
      sourceCast: already as never,
    });

    expect(merged).toBe(already);
  });
});
