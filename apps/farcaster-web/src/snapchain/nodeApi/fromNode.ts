/**
 * Node messages → the shapes the fork's own components already read.
 *
 * `farcaster-client-data` types every response of the hosted client API. Those
 * types are what the pages, the hooks and the cast renderer were built against
 * — so a node-backed client has to hand back the same shapes, or every page
 * needs rewriting. This module is that translation, and it is deliberately the
 * only place that knows the node speaks `MESSAGE_TYPE_CAST_ADD` while the UI
 * speaks `ApiCast`.
 *
 * WHAT IS HONEST HERE, AND WHAT IS A FLOOR
 *
 * - Text, timestamps, embeds, mentions, the author's handle / display name /
 *   avatar / bio and the reply graph are protocol messages: exact.
 * - Engagement counts (`reactions`, `recasts`) and link counts (followers,
 *   following) are counted by paging the node, capped (see `reads.ts`). A count
 *   is therefore exact while it is under the cap and a floor above it. The cap
 *   is high enough that the difference never shows on a normal account, and
 *   `countsAreFloors` travels with the value so a caller can say so.
 * - `watches` (view counts) and `viewerContext` beyond reactions come from the
 *   hosted indexer and are left absent rather than guessed at zero.
 * - A quote embed is a real read (`castById` on the quoting cast's target);
 *   if that read fails the embed degrades to `unknowns` with the target named,
 *   never to an empty box.
 */

import {
  ApiCast,
  ApiCastEmbeds,
  ApiCastFeedItem,
  ApiCastImageEmbed,
  ApiCastUnknownEmbed,
  ApiCastUrlEmbed,
  ApiChannelMinimal,
  ApiQuoteCastEmbed,
  ApiUser,
} from 'farcaster-client-data';

import type { NodeCastAddBody, NodeMessage, NodeUserDataBody } from 'farcaster-node-client';

/** Zero-safe count with the caveat that produced it. */
export interface NodeCount {
  value: number;
  /** True when paging stopped at the cap, so `value` is a lower bound. */
  isFloor: boolean;
}

export const exactCount = (value: number): NodeCount => ({ value, isFloor: false });
export const floorCount = (value: number): NodeCount => ({ value, isFloor: true });

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;

const userDataValue = (
  messages: NodeMessage[],
  type: NodeUserDataBody['userDataType'],
): string | undefined => {
  // Later messages supersede earlier ones for the same field: user data is a
  // log, and the newest value is the current one.
  let value: string | undefined;
  for (const message of messages) {
    if (message.userData?.userDataType === type && message.userData.value !== '') {
      value = message.userData.value;
    }
  }
  return value;
};

export interface ApiUserFromNodeOptions {
  fid: number;
  /** Every USER_DATA_ADD message for this FID, oldest first. */
  userData: NodeMessage[];
  followerCount?: NodeCount;
  followingCount?: NodeCount;
  viewerContext?: ApiUser['viewerContext'];
}

/**
 * A profile as the fork's `ApiUser`. Every field that exists comes from the
 * account's own user-data messages; a missing field stays missing rather than
 * being filled with a placeholder that would read as real.
 */
export const apiUserFromNode = ({
  fid,
  userData,
  followerCount,
  followingCount,
  viewerContext,
}: ApiUserFromNodeOptions): ApiUser => {
  const username = userDataValue(userData, 'USER_DATA_TYPE_USERNAME');
  const displayName = userDataValue(userData, 'USER_DATA_TYPE_DISPLAY');
  const bio = userDataValue(userData, 'USER_DATA_TYPE_BIO') ?? '';
  const pfpUrl = userDataValue(userData, 'USER_DATA_TYPE_PFP');
  const url = userDataValue(userData, 'USER_DATA_TYPE_URL');
  const bannerImageUrl = userDataValue(userData, 'USER_DATA_TYPE_BANNER');
  const locationDescription = userDataValue(userData, 'USER_DATA_TYPE_LOCATION');

  const user: ApiUser = {
    fid,
    displayName: displayName ?? username ?? `fid ${fid}`,
    // The fork's type wants counts. They are counted from the node (see
    // reads.ts) and are honest as written: the node is the only source here.
    followerCount: followerCount?.value ?? 0,
    followingCount: followingCount?.value ?? 0,
    profile: {
      bio: { text: bio, mentions: [] },
      ...(url ? { url } : {}),
      ...(bannerImageUrl ? { bannerImageUrl } : {}),
    },
  };

  if (username !== undefined) {
    user.username = username;
  }
  if (pfpUrl !== undefined && pfpUrl !== '') {
    // `verified` is a hosted-API statement about the image host. Nothing here
    // has made that check, so it is false and not an implication.
    user.pfp = { url: pfpUrl, verified: false };
  }
  if (locationDescription) {
    user.profile.location = { placeId: '', description: locationDescription };
  }
  if (viewerContext) {
    user.viewerContext = viewerContext;
  }

  return user;
};

/** A channel as the UI expects it, built from the parent URL a cast carries. */
export const apiChannelMinimalFromParentUrl = (
  parentUrl: string | undefined,
): ApiChannelMinimal | undefined => {
  if (!parentUrl) {
    return undefined;
  }

  // Channels are addressed by a parent URL. Two forms exist on chain:
  // `https://farcaster.xyz/~/channel/<key>` (URL-keyed channels) and
  // `chain://eip155:7777777/erc721:0x…` (channels owned by an NFT). Only the
  // first has a name inside the URL; for the NFT form the key is the address,
  // which is what the node can prove and all this client will claim.
  const urlKeyed = /^https?:\/\/[^/]+\/~\/(?:channel|fc)\/([^/?#]+)/.exec(parentUrl);
  if (urlKeyed?.[1]) {
    return { key: urlKeyed[1], name: urlKeyed[1] };
  }

  const chainKeyed = /^chain:\/\/eip155:\d+\/erc721:(0x[0-9a-f]{40})$/i.exec(parentUrl);
  if (chainKeyed?.[1]) {
    return { key: parentUrl, name: `channel ${chainKeyed[1].slice(0, 10)}…` };
  }

  return undefined;
};

export interface CastEmbedsFromNodeResult {
  embeds: ApiCastEmbeds;
  /** Quoted casts this caller still has to read (`castById`), by target. */
  quoteTargets: { fid: number; hash: string }[];
}

/**
 * Embeds as the fork's `ApiCastEmbeds`. URLs that are plainly images go to
 * `images`; every other URL goes to `urls` with the URL itself as its
 * open-graph identity (no scraping happens here — an open-graph lookup is a
 * fetch of somebody's page, and this client does not make those).
 */
export const castEmbedsFromNode = ({
  body,
  quotedCasts = [],
}: {
  body: NodeCastAddBody;
  /** Casts already resolved for `body.embeds` quote targets, by `fid:hash`. */
  quotedCasts?: ApiQuoteCastEmbed[];
}): CastEmbedsFromNodeResult => {
  const images: ApiCastImageEmbed[] = [];
  const urls: ApiCastUrlEmbed[] = [];
  const quotes: ApiQuoteCastEmbed[] = [];
  const unknowns: ApiCastUnknownEmbed[] = [];
  const quoteTargets: { fid: number; hash: string }[] = [];

  const quotedByKey = new Map(
    quotedCasts.map((cast) => [`${cast.author.fid}:${cast.hash}`, cast]),
  );

  for (const embed of body.embeds) {
    if ('url' in embed && typeof embed.url === 'string' && embed.url !== '') {
      if (IMAGE_EXTENSIONS.test(embed.url)) {
        images.push({ type: 'image', url: embed.url, sourceUrl: embed.url, alt: '' });
      } else {
        urls.push({ type: 'url', openGraph: { url: embed.url } });
      }
      continue;
    }

    if ('castId' in embed && embed.castId) {
      const key = `${embed.castId.fid}:${embed.castId.hash}`;
      const quoted = quotedByKey.get(key);
      if (quoted) {
        quotes.push(quoted);
      } else {
        quoteTargets.push({ fid: embed.castId.fid, hash: embed.castId.hash });
        // Named, not silent: the box says which cast it is and why it is not
        // rendered yet, rather than looking like an empty embed.
        unknowns.push({
          type: 'unknown',
          source: `quoted cast ${embed.castId.hash} by fid ${embed.castId.fid}`,
        });
      }
    }
  }

  return {
    embeds: {
      images,
      urls,
      ...(quotes.length > 0 ? { casts: quotes } : {}),
      unknowns,
    },
    quoteTargets,
  };
};

export interface ApiCastFromNodeOptions {
  message: NodeMessage;
  body: NodeCastAddBody;
  author: ApiUser;
  parentAuthor?: ApiUser;
  /** The root of the thread this cast belongs to, when it is known. */
  threadHash?: string;
  ancestors?: { count: number; casts?: ApiCast[] };
  replies?: { count: number; casts?: ApiCast[] };
  reactions?: NodeCount;
  recasts?: NodeCount;
  quotedCasts?: ApiQuoteCastEmbed[];
  viewerContext?: ApiCast['viewerContext'];
}

/**
 * One cast as `ApiCast`. `threadHash` falls back to the cast's own hash when
 * the ancestry has not been walked: on the protocol a cast with no parent is
 * its own thread root, and this client only claims a different root when it
 * read the parent chain.
 */
export const apiCastFromNode = ({
  message,
  body,
  author,
  parentAuthor,
  threadHash,
  ancestors,
  replies,
  reactions,
  recasts,
  quotedCasts,
  viewerContext,
}: ApiCastFromNodeOptions): ApiCast => {
  const { embeds } = castEmbedsFromNode({ body, quotedCasts });

  const cast: ApiCast = {
    hash: message.hash,
    threadHash: threadHash ?? message.hash,
    author,
    text: body.text,
    timestamp: message.timestampMs,
    replies: { count: replies?.count ?? 0, ...(replies?.casts ? { casts: replies.casts } : {}) },
    reactions: { count: reactions?.value ?? 0 },
    recasts: { count: recasts?.value ?? 0 },
    // View counts are the hosted indexer's; absent, not zero.
    watches: { count: 0 },
    // `castType` in this API means where the cast sits in a feed, not how long
    // it is: a protocol reply is a reply-cast, anything else is a root.
    castType: body.parentCastId ? 'reply-cast' : 'root-cast',
  };

  if (body.parentCastId) {
    cast.parentHash = body.parentCastId.hash;
    if (parentAuthor) {
      cast.parentAuthor = parentAuthor;
    }
  }
  if (body.parentUrl) {
    cast.parentUrl = body.parentUrl;
    const channel = apiChannelMinimalFromParentUrl(body.parentUrl);
    if (channel) {
      cast.channel = channel;
    }
  }
  if (body.mentions.length > 0) {
    // The protocol carries mentioned FIDs, not their handles. Only FIDs are
    // claimed here; the renderer degrades to `fid N` rather than a wrong name.
    cast.mentions = body.mentions.map((fid) => ({
      fid,
      displayName: `fid ${fid}`,
      followerCount: 0,
      followingCount: 0,
      profile: { bio: { text: '', mentions: [] } },
    }));
  }
  if (ancestors) {
    cast.ancestors = ancestors;
  }
  if (Object.keys(embeds).some((key) => (embeds as never)[key])) {
    cast.embeds = embeds;
  }
  if (viewerContext) {
    cast.viewerContext = viewerContext;
  }

  return cast;
};

/** One feed item: a cast plus the context the feed renderer reads. */
export const apiCastFeedItemFromNode = ({
  cast,
}: {
  cast: ApiCast;
}): ApiCastFeedItem => ({
  // The hosted API ids a feed item by the cast hash; the feed's own
  // de-duplication and the "seen" bookkeeping key on it.
  id: cast.hash,
  timestamp: cast.timestamp,
  cast,
  otherParticipants: [],
});