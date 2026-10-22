/**
 * Which hosted-API request goes where, once your own node is the data source.
 *
 * The fork's data layer (`farcaster-client-data`) speaks one REST surface:
 * the hosted client API at `/v2/*` and `/v1/*` that `farcaster.xyz` serves to
 * its own web app. A third-party client can never hold the server session that
 * API wants, so those requests fail — which is what the app used to report
 * after a real sign-in.
 *
 * This module is the routing table for the replacement. Every request the
 * signed-in surfaces make is classified into one of three honest answers:
 *
 *   - `node`      — your Snapchain node can answer it. The reader in
 *                   `reads.ts` does, from real protocol messages.
 *   - `local`     — it was never Farcaster's data: it is this device's own
 *                   state (preferences, blocklists) or a protocol constant.
 *                   Answering it locally is the truthful answer.
 *   - `media`     — it is the media pipeline. The hosted API mints a signed
 *                   Cloudflare upload URL here; our own media host
 *                   (`POST /api/fiddy/media`, see `mediaUpload.ts`) takes the
 *                   bytes instead. Nothing is invented: the answer names a real
 *                   endpoint that really stores the file.
 *   - `write`     — it is a write, and a write is a *signed message*: this
 *                   device signs it with the account's own app key and a node
 *                   carries it (`submitMessage`). `nodeWrites.ts` builds it,
 *                   submits it, and reads the resulting state back before it
 *                   answers. Every one of these used to fall through to the
 *                   unknown-path branch below — which is why pressing the heart
 *                   on a cast answered with a sentence about a *reader*.
 *   - `hosted`    — neither the node nor this client can answer it: ranking,
 *                   search, direct messages, channel directories, video
 *                   transcoding and the other indexer features are Warpcast's
 *                   own. The request fails with a message that says so, rather
 *                   than an empty success that would read as "there is nothing
 *                   there".
 *   - `catalog`   — it is the mini-app / frame catalog: the list of apps, the
 *                   apps relevant to you, and app search. A Snapchain node
 *                   keeps no app list at all (an app is a *web page* with an
 *                   `fc:miniapp` meta tag, not a protocol message), so this is
 *                   not a `node` read however much it looks like one. It is
 *                   answered from Neynar's public app catalog instead, which is
 *                   a real index of real apps — never from a list this client
 *                   invented. See `capabilities.ts` for who may answer it.
 *
 * The classification is by path, because that is all a `fetch` sees: the
 * hosted client builds `${baseUrl}${relativeUrl}` itself, so the path is the
 * endpoint. The shapes it gets back are the hosted API's shapes, built from
 * node messages in `fromNode.ts` — that is what keeps the hooks and the pages
 * untouched.
 */

export type HostedRoutePolicy =
  | { kind: 'node'; why: string }
  | { kind: 'local'; why: string }
  | { kind: 'media'; why: string }
  | { kind: 'write'; why: string }
  | { kind: 'catalog'; why: string }
  | { kind: 'hosted'; why: string };

export type HostedRouteMatch = HostedRoutePolicy & {
  /** The path that matched, for logs and evidence. */
  path: string;
  /** `GET` / `POST` — the method the policy was written for. */
  method: string;
};

const NODE_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'POST',
    path: '/v2/feed-items',
    why: 'the feed is assembled from your follow graph (linksByFid → castsByFid)',
  },
  {
    method: 'GET',
    path: '/v2/me',
    why: 'the signed-in account is its own user-data messages on the node',
  },
  {
    method: 'GET',
    path: '/v2/user',
    why: 'a profile is userDataByFid plus its link counts',
  },
  {
    method: 'GET',
    path: '/v2/user-by-fid',
    why: 'a profile is userDataByFid plus its link counts',
  },
  {
    method: 'GET',
    path: '/v2/user-by-username',
    why: 'a username resolves to a FID through userNameProofByName',
  },
  {
    method: 'GET',
    path: '/v2/user-casts',
    why: "one account's casts are castsByFid",
  },
  {
    method: 'GET',
    path: '/v2/thread-casts',
    why: 'a thread is castsByParent (replies) plus castById (ancestors)',
  },
  {
    method: 'GET',
    path: '/v2/cast-recasters',
    why: 'the accounts that recast a cast are its reaction messages, read by reactionsByCast (recast)',
  },
  {
    method: 'GET',
    path: '/v2/cast-likes',
    why: 'the accounts that liked a cast are its reaction messages, read by reactionsByCast (like)',
  },
  {
    method: 'GET',
    path: '/v2/unseen',
    why: 'counts are derived from mentions, reactions and follows since your watermark',
  },
  {
    method: 'GET',
    path: '/v1/notifications-for-tab',
    why: 'notifications are derived from mentions, reactions and follows to your FID',
  },
  {
    method: 'GET',
    path: '/v2/channel',
    why: 'a channel addressed by its parent URL is on the node; see the gap note',
  },
  {
    method: 'GET',
    path: '/v2/verifications',
    why: 'verified addresses are verification messages on the node',
  },
];

const LOCAL_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'GET',
    path: '/v2/user-app-context',
    why: 'client capabilities and protocol limits, not server data',
  },
  {
    method: 'GET',
    path: '/v2/user-preferences',
    why: 'email preferences this device has none of; nothing to claim',
  },
  {
    method: 'GET',
    path: '/v2/snap/blocklist',
    why: 'nothing is blocked locally, and a blocklist is local state',
  },
  {
    method: 'GET',
    path: '/v2/frame-blocklist',
    why: 'nothing is blocked locally, and a blocklist is local state',
  },
  {
    method: 'POST',
    path: '/v2/mark-all-notifications-read',
    why: 'what you have seen is this device’s own bookmark, kept locally',
  },
  {
    method: 'POST',
    path: '/v2/mark-tab-notifications-seen',
    why: 'what you have seen is this device’s own bookmark, kept locally',
  },
  {
    method: 'POST',
    path: '/v2/feed-seen',
    why: 'what you have seen is this device’s own bookmark, kept locally',
  },
  // ── drafts: DECIDED (t_44070b80), and the reason is written down here on
  // purpose. A draft is what this device typed and has not sent, not a
  // Farcaster object: Warpcast keeps its own copy on its own servers so drafts
  // follow you between Warpcast apps, and a third-party client holding no
  // Warpcast session cannot have that. So the store is real and it is here
  // (`localDrafts.ts`, one list per signed-in FID in this browser's storage).
  // Answering "saved" while storing nothing — or refusing the write with a
  // 501 — would both be worse than owning the state: the second one is what
  // made every Cast attempt stop before it could even try to post.
  // `DELETE /v2/draft-casts` is in this list for the same reason: the composer
  // discards the pre-publish draft after a successful cast, and a 501 there
  // would leave a stale draft on the device for ever.
  {
    method: 'GET',
    path: '/v2/draft-caststorms',
    why: 'a draft is this device’s own state, kept in localDrafts.ts, not a server’s',
  },
  {
    method: 'POST',
    path: '/v2/draft-caststorms',
    why: 'a draft is this device’s own state, kept in localDrafts.ts, not a server’s',
  },
  {
    method: 'GET',
    path: '/v2/draft-casts',
    why: 'a draft is this device’s own state, kept in localDrafts.ts, not a server’s',
  },
  {
    method: 'POST',
    path: '/v2/draft-casts',
    why: 'a draft is this device’s own state, kept in localDrafts.ts, not a server’s',
  },
  {
    method: 'DELETE',
    path: '/v2/draft-casts',
    why: 'a draft is this device’s own state, kept in localDrafts.ts, not a server’s',
  },
];

const MEDIA_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'POST',
    path: '/v1/generate-image-upload-url',
    why: 'the media pipeline is ours now: the bytes go to POST /api/fiddy/media, not to Warpcast’s CDN',
  },
];

/**
 * The app catalog: the four reads the mini-app surfaces make.
 *
 * An app on Farcaster is not a protocol object — it is a web page that carries
 * an `fc:miniapp` meta tag, and a Snapchain node stores no list of them. So a
 * node cannot answer these however many of them there are, and the honest
 * answer is not "no reader has been written": it is Neynar's own app catalog,
 * which this client asks for in the reader's name (`neynarMap.ts`). The `why`
 * text is what a human is shown when nothing can answer them, so it names the
 * real source and the real limitation.
 *
 * What is deliberately NOT here: the writes around favorites (adding or
 * removing an app from your list) and the per-app admin/notification calls.
 * Those are account state on a server this client has no session for, and they
 * stay `hosted` — refused in words, never faked.
 */
const CATALOG_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'GET',
    path: '/v1/top-mini-apps',
    why: 'the list of mini apps comes from Neynar’s public app catalog — a node keeps no list of apps',
  },
  {
    method: 'GET',
    path: '/v1/new-frameapps',
    why: 'the list of mini apps comes from Neynar’s public app catalog — a node keeps no list of apps',
  },
  {
    method: 'GET',
    path: '/v1/favorite-frames',
    why: 'the mini apps relevant to you come from Neynar’s index — a node keeps neither an app list nor favourites',
  },
  {
    method: 'GET',
    path: '/v1/search-miniapps',
    why: 'searching mini apps goes through Neynar’s index — a node keeps no search index',
  },
];

/**
 * The writes this client can really make, one row per request the fork's data
 * layer sends when somebody presses something.
 *
 * Every one of these is a message this device signs with the account's own app
 * key and hands to a node — the same three builders the Advanced screen's own
 * composer has used since before this file existed
 * (`~/snapchain/nodeApi/nodeWrites` maps the path to the builder). The `why`
 * text is what a person reading a debug overlay (or a failing probe) is told
 * about where the write went.
 *
 * The ones that are NOT here stay `hosted`: deleting a cast, editing a profile,
 * mutes, blocks, bookmarks and the rest of the fork's write surface have no
 * builder wired up in this client yet, and the honest answer to those is the
 * unknown-path sentence below rather than a guess at a message type.
 */
const WRITE_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'PUT',
    path: '/v2/cast-likes',
    why: 'the heart pressed on a cast — signed here as REACTION_ADD and handed to your node, which gossips it',
  },
  {
    method: 'DELETE',
    path: '/v2/cast-likes',
    why: 'the heart pressed again — signed here as REACTION_REMOVE and handed to your node',
  },
  {
    method: 'PUT',
    path: '/v2/recasts',
    why: 'the recast action — signed here as REACTION_ADD (recast) and handed to your node',
  },
  {
    method: 'DELETE',
    path: '/v2/recasts',
    why: 'undo a recast — signed here as REACTION_REMOVE and handed to your node',
  },
  {
    method: 'PUT',
    path: '/v2/follows',
    why: 'the Follow button — signed here as LINK_ADD and handed to your node',
  },
  {
    method: 'DELETE',
    path: '/v2/follows',
    why: 'the Unfollow button — signed here as LINK_REMOVE and handed to your node',
  },
  {
    method: 'POST',
    path: '/v2/casts',
    why: 'pressing Cast — the text is signed here as CAST_ADD with the app key this device holds, handed to your node, and read back to prove it was stored',
  },
];

const HOSTED_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'GET',
    path: '/v2/feeds',
    why: 'feed summaries are the hosted indexer’s own lists',
  },
  {
    method: 'PUT',
    path: '/v2/cast-attachments',
    why: 'attachments are resolved by the hosted indexer (image sizes, link previews)',
  },
  {
    method: 'POST',
    path: '/v1/prepare-video-upload',
    why: 'a clip needs Warpcast’s own transcoding pipeline; we host images and raw clips only',
  },
  {
    method: 'POST',
    path: '/v1/upload-video-with-tus',
    why: 'that resumable protocol speaks to Warpcast’s Cloudflare bucket, not to ours',
  },
  {
    method: 'GET',
    path: '/v1/uploaded-video',
    why: 'the state of a video lives in Warpcast’s pipeline',
  },
  {
    method: 'DELETE',
    path: '/v1/uploaded-video',
    why: 'abandoning a video is a call to Warpcast’s pipeline',
  },
  {
    method: 'GET',
    path: '/v2/explore-feed',
    why: 'explore is a ranking, and ranking is an indexer’s job',
  },
  {
    method: 'GET',
    path: '/v2/highlighted-channels',
    why: 'the channel directory is Warpcast’s, not the protocol’s',
  },
  {
    method: 'GET',
    path: '/v2/user-following-channels',
    why: 'the channel directory is Warpcast’s, not the protocol’s',
  },
  {
    method: 'GET',
    path: '/v2/channel-streaks',
    why: 'channel streaks are a hosted feature, not protocol messages',
  },
  {
    method: 'GET',
    path: '/v2/direct-cast-inbox',
    why: 'direct messages are not on a read node’s public API yet',
  },
  {
    method: 'GET',
    path: '/v1/get-trending-topics',
    why: 'trending topics are a hosted ranking',
  },
  {
    method: 'GET',
    path: '/v1/audio-rooms',
    why: 'audio rooms are a hosted product, not protocol messages',
  },
  {
    method: 'GET',
    path: '/v1/favorite-frames',
    why: 'favorite mini apps are hosted account state',
  },
  {
    method: 'GET',
    path: '/v2/search-casts',
    why: 'a read node keeps no search index',
  },
  {
    method: 'GET',
    path: '/v2/cast-quotes',
    why: 'quotes of a cast are an indexer’s reverse index — a node keeps no list of the casts that embed one',
  },
  {
    method: 'GET',
    path: '/v2/user-cast',
    why: 'a cast-hash prefix is an indexer’s lookup — your node addresses a cast by its author and its full hash',
  },
];

/** The hosted API's error envelope, so the client turns this into a HandledFetchError. */
export interface HostedApiErrorEnvelope {
  errors: { message: string }[];
}

const find = (
  table: { method: string; path: string; why: string }[],
  method: string,
  path: string,
) => table.find((entry) => entry.method === method && entry.path === path);

/**
 * The endpoint path inside a hosted-API URL.
 *
 * The client builds `${baseUrl}${relativeUrl}`, and `baseUrl` differs by build:
 * `https://farcaster.xyz/~api` in dev, the same-origin relay `/~api` when the
 * app is built, and `http://localhost:8080` for the mock API. The endpoint is
 * therefore the tail that starts at `/v1/` or `/v2/`, whatever prefix the build
 * put in front of it.
 */
export const hostedApiPath = (pathname: string): string => {
  const index = pathname.search(/\/v[12]\/[A-Za-z0-9]/);
  return index === -1 ? pathname : pathname.slice(index);
};

/**
 * Classify one request. Unknown paths are `hosted` — deliberately: the safe
 * default is to say "your node cannot answer this", never to invent a payload
 * for an endpoint whose shape we have not read.
 */
export const classifyHostedRequest = ({
  method,
  path,
}: {
  method: string;
  path: string;
}): HostedRouteMatch => {
  const normalizedMethod = method.toUpperCase();
  const endpoint = hostedApiPath(path);

  const node = find(NODE_ROUTES, normalizedMethod, endpoint);
  if (node) {
    return {
      kind: 'node',
      path: endpoint,
      method: normalizedMethod,
      why: node.why,
    };
  }

  const local = find(LOCAL_ROUTES, normalizedMethod, endpoint);
  if (local) {
    return {
      kind: 'local',
      path: endpoint,
      method: normalizedMethod,
      why: local.why,
    };
  }

  const media = find(MEDIA_ROUTES, normalizedMethod, endpoint);
  if (media) {
    return {
      kind: 'media',
      path: endpoint,
      method: normalizedMethod,
      why: media.why,
    };
  }

  const catalog = find(CATALOG_ROUTES, normalizedMethod, endpoint);
  if (catalog) {
    return {
      kind: 'catalog',
      path: endpoint,
      method: normalizedMethod,
      why: catalog.why,
    };
  }

  const write = find(WRITE_ROUTES, normalizedMethod, endpoint);
  if (write) {
    return {
      kind: 'write',
      path: endpoint,
      method: normalizedMethod,
      why: write.why,
    };
  }

  const hosted = find(HOSTED_ROUTES, normalizedMethod, endpoint);
  if (hosted) {
    return {
      kind: 'hosted',
      path: endpoint,
      method: normalizedMethod,
      why: hosted.why,
    };
  }

  // Paths we know are search reads (/v1/search-*, /v2/search-*) and anything
  // else we have not classified.
  if (/\/v[12]\/search/.test(endpoint)) {
    return {
      kind: 'hosted',
      path: endpoint,
      method: normalizedMethod,
      why: 'a read node keeps no search index',
    };
  }

  return {
    kind: 'hosted',
    path: endpoint,
    method: normalizedMethod,
    why:
      normalizedMethod === 'GET' || normalizedMethod === 'HEAD'
        ? 'no node-backed reader has been written for this endpoint yet'
        : `no node-backed writer has been written for ${normalizedMethod} ${endpoint} yet, so nothing was signed and nothing was sent`,
  };
};

export const nodeBackedRoutes = NODE_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
export const localRoutes = LOCAL_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
export const mediaRoutes = MEDIA_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
export const catalogRoutes = CATALOG_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
export const writeRoutes = WRITE_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
export const hostedOnlyRoutes = HOSTED_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
