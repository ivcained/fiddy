/**
 * Putting a thin quoted cast back together.
 *
 * A cast handed back *inside* another cast's quote embed arrives stripped: its
 * pictures, videos, links and — the one that matters for a quote of a quote —
 * the cast it quotes are all gone. `useHydratedQuoteCast` fetches the real cast
 * for exactly that case; the pure half of the job lives here, so what the fetch
 * result is allowed to restore is testable without a React tree.
 *
 * The rules, in order:
 *
 *   - a cast that already has content of its own is left alone, whatever the
 *     fetch returned: the payload the reader is looking at wins;
 *   - a bucket the thin payload already had wins over the fetched one, so a
 *     merge never overwrites what was really there;
 *   - a source copy is only worth merging from when it carries something a thin
 *     payload would not — a space URL, or the cast it quotes.
 */

import type {
  ApiCast,
  ApiQuoteCastEmbed,
  ApiQuotedCastEmbed,
} from 'farcaster-client-data';

/** Either shape a cast can arrive in: the fully typed one, or a quote's thin payload. */
export type HydratedQuoteCast = ApiCast | ApiQuoteCastEmbed;

const SPACE_URL_RE =
  /^https?:\/\/(?:www\.)?(?:warpcast\.com|farcaster\.xyz)\/~\/spaces\/[\w-]+\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/;

export const quoteCastHasContent = (cast: HydratedQuoteCast | undefined) => {
  if (!cast) {
    return false;
  }

  if (cast.text.length > 0) {
    return true;
  }

  return Object.values(cast.embeds ?? {}).some(
    (embedBucket) => Array.isArray(embedBucket) && embedBucket.length > 0,
  );
};

export const getSpaceUrlEmbeds = (cast: HydratedQuoteCast | undefined) =>
  cast?.embeds?.urls?.filter(({ openGraph }) =>
    SPACE_URL_RE.test(openGraph.url),
  ) ?? [];

/**
 * Does this copy of a cast carry anything a thin quote payload would not?
 *
 * Two reasons the hydration fetch exists: to recover a space URL, and to recover
 * the cast this one quotes. Either is enough to be worth merging from.
 */
export const carriesEmbeds = (cast: HydratedQuoteCast | undefined): boolean =>
  getSpaceUrlEmbeds(cast).length > 0 || (cast?.embeds?.casts?.length ?? 0) > 0;

/**
 * Add the space URL embeds a thin payload lost, without duplicating a URL the
 * payload already has.
 */
export const mergeSpaceUrlEmbeds = ({
  cast,
  sourceCast,
}: {
  cast: ApiQuoteCastEmbed;
  sourceCast: HydratedQuoteCast | undefined;
}) => {
  if (cast.deleted) {
    return cast;
  }

  const existingUrls = new Set(
    cast.embeds?.urls?.map(({ openGraph }) => openGraph.url) ?? [],
  );
  const missingSpaceUrlEmbeds = getSpaceUrlEmbeds(sourceCast).filter(
    ({ openGraph }) => !existingUrls.has(openGraph.url),
  );

  if (missingSpaceUrlEmbeds.length === 0) {
    return cast;
  }

  return {
    ...cast,
    embeds: {
      ...cast.embeds,
      urls: [...(cast.embeds?.urls ?? []), ...missingSpaceUrlEmbeds],
    },
  };
};

/**
 * Give a wordless quoted cast back what the fetch found — including, for a quote
 * of a quote, the cast it quotes.
 *
 * Without this, a quote of a quote is a card with no words and nothing inside it
 * to open: the inner cast is exactly the content the payload dropped.
 */
export const mergeHydratedEmbeds = ({
  cast,
  sourceCast,
}: {
  cast: ApiQuoteCastEmbed;
  sourceCast: HydratedQuoteCast | undefined;
}): ApiQuoteCastEmbed => {
  if (cast.deleted || quoteCastHasContent(cast) || !sourceCast) {
    return cast;
  }
  if (!quoteCastHasContent(sourceCast)) {
    return cast;
  }

  const carried = sourceCast.embeds;
  const own = cast.embeds;
  const bucket = <T>(fromCast: T[] | undefined, fromSource: T[] | undefined) =>
    fromCast?.length ? fromCast : fromSource?.length ? fromSource : undefined;

  const videos = bucket(own?.videos, carried?.videos);
  const casts = bucket(
    own?.casts as ApiQuotedCastEmbed[] | undefined,
    carried?.casts as ApiQuotedCastEmbed[] | undefined,
  );
  const snap = bucket(own?.snap, carried?.snap);
  const groupInvites = bucket(own?.groupInvites, carried?.groupInvites);
  const transactions = bucket(own?.transactions, carried?.transactions);

  return {
    ...(cast as ApiQuoteCastEmbed),
    embeds: {
      ...own,
      images: bucket(own?.images, carried?.images) ?? [],
      urls: bucket(own?.urls, carried?.urls) ?? [],
      unknowns: bucket(own?.unknowns, carried?.unknowns) ?? [],
      ...(videos ? { videos } : {}),
      // The bucket this whole file exists for: the cast this one quotes.
      ...(casts ? { casts } : {}),
      ...(snap ? { snap } : {}),
      ...(groupInvites ? { groupInvites } : {}),
      ...(transactions ? { transactions } : {}),
    },
  };
};
