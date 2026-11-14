/**
 * What a quoted cast actually is — the thing a card needs before it can say
 * anything honest about it.
 *
 * adapted from quilcast (backmeupplz), MIT: `CastRef`, `quotedOf` and `peekOf`
 * in that project's `src/shared.ts` (`2fcd039`, `e42029a`). Rewritten for this
 * client's shape rather than vendored: quilcast hands these functions a flat
 * list of embed URLs off a hub message, while a cast here arrives with buckets
 * (`embeds.images`, `embeds.videos`, `embeds.urls`, `embeds.casts`). Nothing else
 * in that file — no locales, no styles — is copied.
 *
 * WHY IT EXISTS
 *
 * A quote of a quote is a cast with no words of its own and one `cast_id`
 * embed. The hosted API hands that cast back to its quoter with an empty
 * `embeds`, so the card had nothing to render and fell through to a "Show
 * more..." promise with nothing behind it. The three questions a card actually
 * needs answered are below, in the order they matter:
 *
 *   quotedOf — which cast is the one being quoted (the inner one), when this
 *              cast is itself a quote?
 *   peekOf   — what is the first thing worth showing: an image, a video, a
 *              link, the inner quote, or nothing at all?
 *   castRefOf— is that hash a cast hash at all, and is the fid a real one?
 *
 * A hash that is not forty hex characters and a fid that is not a positive
 * integer are dropped rather than passed on: a wrong fid is a wrong cast on a
 * node, and a malformed one is a link nobody can open.
 */

import type {
  ApiCastImageEmbed,
  ApiCastUrlEmbed,
  ApiCastVideoEmbed,
  ApiQuotedCastEmbed,
} from 'farcaster-client-data';

/** A cast, addressed the way a node addresses one: author + hash. */
export interface CastRef {
  /** Absent when the author is unknown — a hash alone still opens the cast. */
  fid?: number;
  hash: string;
}

/** The shape a hash has to have to be a cast hash, not a string that looks like one. */
const CAST_HASH_RE = /^0x[0-9a-f]{40}$/i;

/**
 * A cast reference from whatever a payload claimed, or `undefined` when the
 * hash is not a cast hash. A fid is kept only when it is a positive integer:
 * a zero or a negative one addresses nobody.
 */
export const castRefOf = ({
  hash,
  fid,
}: {
  hash: string | undefined;
  fid?: number | undefined;
}): CastRef | undefined => {
  if (typeof hash !== 'string' || !CAST_HASH_RE.test(hash)) {
    return undefined;
  }
  if (typeof fid === 'number' && Number.isInteger(fid) && fid > 0) {
    return { fid, hash };
  }
  return { hash };
};

/** The inner cast of a quote, as far as its author and hash go. */
export interface QuotedCastRef extends CastRef {
  /** The handle of whoever wrote the inner cast, when the payload carried it. */
  username?: string;
}

/**
 * The cast this cast quotes, from the first quote embed it has.
 *
 * `undefined` means this cast quotes nobody — which is every cast that is not a
 * quote of a quote, and is why a card can tell the two apart.
 */
export const quotedOf = (cast: {
  embeds?: { casts?: Pick<ApiQuotedCastEmbed, 'hash' | 'author'>[] };
}): QuotedCastRef | undefined => {
  const quoted = cast.embeds?.casts?.[0];
  if (!quoted) {
    return undefined;
  }
  const fid = quoted.author?.fid;
  const ref = castRefOf({ hash: quoted.hash, fid });
  if (!ref) {
    return undefined;
  }
  const username = quoted.author?.username;
  return username ? { ...ref, username } : ref;
};

/**
 * The first thing worth showing for a cast, in one answer.
 *
 * The order is the one a reader would expect — a picture, then a video (a
 * poster, or a stand-in when the video has none), then a link, then the cast it
 * quotes, and `none` when the cast really has nothing of its own. A card reads
 * this instead of re-deriving it from five arrays in a different order in each
 * place.
 */
export type CastPeek =
  | { kind: 'image'; image: ApiCastImageEmbed }
  | { kind: 'video'; video: ApiCastVideoEmbed; poster?: string }
  | { kind: 'link'; url: ApiCastUrlEmbed }
  | { kind: 'quote'; quote: QuotedCastRef }
  | { kind: 'none' };

const HTTP_URL_RE = /^https?:\/\//i;

export const peekOf = (cast: {
  embeds?: {
    images?: ApiCastImageEmbed[];
    videos?: ApiCastVideoEmbed[];
    urls?: ApiCastUrlEmbed[];
    casts?: Pick<ApiQuotedCastEmbed, 'hash' | 'author'>[];
  };
}): CastPeek => {
  const image = cast.embeds?.images?.[0];
  if (image) {
    return { kind: 'image', image };
  }

  const video = cast.embeds?.videos?.[0];
  if (video) {
    const poster =
      typeof video.thumbnailUrl === 'string' && video.thumbnailUrl !== ''
        ? video.thumbnailUrl
        : undefined;
    return poster ? { kind: 'video', video, poster } : { kind: 'video', video };
  }

  const url = cast.embeds?.urls?.[0];
  if (url && HTTP_URL_RE.test(url.openGraph?.url ?? '')) {
    return { kind: 'link', url };
  }

  const quote = quotedOf(cast);
  if (quote) {
    return { kind: 'quote', quote };
  }

  return { kind: 'none' };
};
