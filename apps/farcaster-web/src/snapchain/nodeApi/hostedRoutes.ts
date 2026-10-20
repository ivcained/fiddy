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
 *   - `hosted`    — your node cannot answer it: ranking, search, direct
 *                   messages, channel directories and the other indexer
 *                   features are Warpcast's own. The request fails with a
 *                   message that says so, rather than an empty success that
 *                   would read as "there is nothing there". The one write in
 *                   this list is `POST /v2/casts`: sending a cast is the
 *                   client's own job, but it needs a signed message, and this
 *                   device holds no app key to sign with yet — so it is named
 *                   here, refused in plain words, and shown to the person who
 *                   pressed Cast.
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

const HOSTED_ROUTES: { method: string; path: string; why: string }[] = [
  {
    method: 'POST',
    path: '/v2/casts',
    why: 'sending a cast means signing it with an app key and handing it to a node — this device has no app key yet, so nothing was signed and nothing was sent',
  },
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
    path: '/v1/search-miniapps',
    why: 'a read node keeps no search index',
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
    why: 'no node-backed reader has been written for this endpoint yet',
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
export const hostedOnlyRoutes = HOSTED_ROUTES.map(
  (entry) => `${entry.method} ${entry.path}`,
);
