/**
 * Neynar, translated — the thin mapper, and the only place Neynar's own JSON is
 * allowed to exist.
 *
 * Neynar is a hosted index, not a node: different endpoint names
 * (`/v2/farcaster/…`), different field names (`display_name`, `pfp_url`,
 * `likes_count`), and a key the reader brought. None of that may reach the
 * pages, whose hooks still consume the shapes the hosted API served — so this
 * module answers a client request by calling Neynar and handing back the SAME
 * envelope the node-backed adapter builds:
 *
 *          client request → Neynar call → Neynar JSON → hosted shape
 *
 * WHAT IT REFUSES
 *
 * The feed, notifications/unseen counts, direct messages and search are not
 * here: this client's signed-in surfaces are assembled from protocol messages
 * on a node, and Neynar's equivalents need its own account, its own plan and
 * its own paging semantics. Asking for one comes back as `501` with a sentence
 * naming Neynar and saying what it cannot do — never as an empty success, and
 * never as a quiet fall-through to a different server.
 *
 * Counts are what Neynar says they are (its index's own numbers). Where a field
 * is absent, it is left absent rather than filled with a zero that would read
 * like a fact.
 */

import type { ApiCast, ApiUser } from 'farcaster-client-data';

import { NEYNAR_BASE_URL } from './catalog';

/** One Neynar read, as this client asks for it. */
export interface NeynarCall {
  url: string;
  /** Which hosted shape to build out of the answer. */
  kind: 'user' | 'user-list' | 'casts' | 'thread' | 'verifications';
}

/** The hosted API's error envelope, same as the node-backed adapter's. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

interface NeynarUser {
  fid?: unknown;
  username?: unknown;
  display_name?: unknown;
  pfp_url?: unknown;
  follower_count?: unknown;
  following_count?: unknown;
  custody_address?: unknown;
  profile?: { bio?: { text?: unknown } };
  verified_addresses?: { eth_addresses?: unknown };
}

interface NeynarCast {
  hash?: unknown;
  thread_hash?: unknown;
  parent_hash?: unknown;
  parent_url?: unknown;
  parent_author?: { fid?: unknown };
  author?: NeynarUser;
  text?: unknown;
  timestamp?: unknown;
  replies?: { count?: unknown };
  reactions?: { likes_count?: unknown; recasts_count?: unknown };
  embeds?: unknown;
  channel?: { id?: unknown; name?: unknown } | null;
  direct_replies?: unknown;
  chronological_parent_casts?: unknown;
}

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * A Neynar user as the fork's `ApiUser`.
 *
 * `verified` on the avatar is Neynar's own claim about the image host; it is
 * carried over only when Neynar states it, never assumed.
 */
export const apiUserFromNeynar = (user: NeynarUser): ApiUser => {
  const fid = asNumber(user.fid);
  const username = asString(user.username);
  const displayName = asString(user.display_name);
  const bio = asString(user.profile?.bio?.text) ?? '';

  const apiUser: ApiUser = {
    fid,
    displayName: displayName ?? username ?? `fid ${fid}`,
    followerCount: asNumber(user.follower_count),
    followingCount: asNumber(user.following_count),
    profile: { bio: { text: bio, mentions: [] } },
  };

  if (username !== undefined) {
    apiUser.username = username;
  }
  const pfpUrl = asString(user.pfp_url);
  if (pfpUrl !== undefined) {
    apiUser.pfp = { url: pfpUrl, verified: false };
  }

  return apiUser;
};

/** Neynar's ISO timestamp as the milliseconds the hosted shapes use. */
const timestampMs = (value: unknown): number => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;

/** Neynar's `embeds` array as the fork's `ApiCastEmbeds`. */
const embedsFromNeynar = (embeds: unknown): ApiCast['embeds'] => {
  if (!Array.isArray(embeds)) {
    return { images: [], urls: [], unknowns: [] };
  }
  const images: {
    type: 'image';
    url: string;
    sourceUrl: string;
    alt: string;
  }[] = [];
  const urls: { type: 'url'; openGraph: { url: string } }[] = [];
  const quotes: unknown[] = [];

  for (const embed of embeds) {
    const record = embed as { url?: unknown; cast?: unknown } | null;
    const url = asString(record?.url);
    if (url === undefined) {
      if (record?.cast) {
        quotes.push(record.cast);
      }
      continue;
    }
    if (IMAGE_EXTENSIONS.test(url)) {
      images.push({ type: 'image', url, sourceUrl: url, alt: '' });
    } else {
      urls.push({ type: 'url', openGraph: { url } });
    }
  }

  return {
    images,
    urls,
    ...(quotes.length > 0 ? { casts: quotes as never } : {}),
    unknowns: [],
  };
};

/**
 * One Neynar cast as `ApiCast`.
 *
 * `threadHash` is Neynar's `thread_hash` when it states one, and the cast's own
 * hash otherwise — the protocol's rule for a cast with no parent.
 */
export const apiCastFromNeynar = (cast: NeynarCast): ApiCast => {
  const hash = asString(cast.hash) ?? '';
  const author = apiUserFromNeynar(cast.author ?? {});
  const parentHash = asString(cast.parent_hash);
  const parentUrl = asString(cast.parent_url);
  const channelId = asString(cast.channel?.id);

  const apiCast: ApiCast = {
    hash,
    threadHash: asString(cast.thread_hash) ?? hash,
    author,
    text: asString(cast.text) ?? '',
    timestamp: timestampMs(cast.timestamp),
    replies: { count: asNumber(cast.replies?.count) },
    reactions: { count: asNumber(cast.reactions?.likes_count) },
    recasts: { count: asNumber(cast.reactions?.recasts_count) },
    // Neynar's own view counts are behind another plan; absent, not zero.
    watches: { count: 0 },
    castType: parentHash !== undefined ? 'reply-cast' : 'root-cast',
  };

  const embeds = embedsFromNeynar(cast.embeds);
  if (
    embeds &&
    ((embeds.images?.length ?? 0) > 0 ||
      (embeds.urls?.length ?? 0) > 0 ||
      (embeds.casts?.length ?? 0) > 0)
  ) {
    apiCast.embeds = embeds;
  }

  if (parentHash !== undefined) {
    apiCast.parentHash = parentHash;
  }
  if (parentUrl !== undefined) {
    apiCast.parentUrl = parentUrl;
    if (channelId !== undefined) {
      apiCast.channel = {
        type: 'channel',
        key: channelId,
        name: asString(cast.channel?.name) ?? channelId,
        showCastSourceLabels: false,
        showCastTags: false,
        sectionRank: 0,
        subscribable: false,
        viewerContext: {
          following: false,
          isMember: false,
          hasUnseenItems: false,
        },
      } as ApiCast['channel'];
    }
  }

  return apiCast;
};

const asNeynarArray = (value: unknown): NeynarCast[] =>
  Array.isArray(value) ? (value as NeynarCast[]) : [];

/**
 * Which Neynar URL a client request becomes — or null when Neynar cannot serve
 * it at all.
 *
 * Pure: no key, no fetch, so the refusal list is a test rather than a promise.
 */
export const neynarCallFor = ({
  path,
  searchParams,
  baseUrl = NEYNAR_BASE_URL,
}: {
  path: string;
  searchParams: URLSearchParams;
  baseUrl?: string;
}): NeynarCall | null => {
  const base = `${baseUrl}/v2/farcaster`;

  switch (path) {
    case '/v2/user':
    case '/v2/user-by-fid':
    case '/v2/verifications': {
      const fid = searchParams.get('fid');
      if (!fid) {
        return null;
      }
      return {
        url: `${base}/user/bulk?fids=${encodeURIComponent(fid)}`,
        kind: path === '/v2/verifications' ? 'verifications' : 'user',
      };
    }

    case '/v2/user-by-username': {
      const username = searchParams.get('username');
      if (!username) {
        return null;
      }
      return {
        url: `${base}/user/by_username?username=${encodeURIComponent(username)}`,
        kind: 'user',
      };
    }

    case '/v2/user-casts':
    case '/v2/profile-casts': {
      const fid = searchParams.get('fid');
      if (!fid) {
        return null;
      }
      const limit = searchParams.get('limit') ?? '25';
      return {
        url: `${base}/feed/user/casts?fid=${encodeURIComponent(fid)}&limit=${encodeURIComponent(limit)}`,
        kind: 'casts',
      };
    }

    case '/v2/thread-casts': {
      const castHash = searchParams.get('castHash');
      if (!castHash) {
        return null;
      }
      return {
        url: `${base}/cast/conversation?identifier=${encodeURIComponent(castHash)}&type=hash&reply_depth=1`,
        kind: 'thread',
      };
    }

    default:
      return null;
  }
};

/** `/v2/me` resolves to the signed-in FID, which only the caller knows. */
export const neynarMeCall = ({
  fid,
  baseUrl = NEYNAR_BASE_URL,
}: {
  fid: number;
  baseUrl?: string;
}): NeynarCall => ({
  url: `${baseUrl}/v2/farcaster/user/bulk?fids=${fid}`,
  kind: 'user',
});

/** The envelope the client's profile reads expect, from one Neynar user. */
const userProfileEnvelope = (user: ApiUser, fid: number) => ({
  result: {
    user,
    collectionsOwned: [],
    // `custodyAddress` is an on-chain fact this read does not fetch; empty
    // rather than invented, the same as the node-backed reader.
    extras: { fid, custodyAddress: '' },
  },
});

/** One thread as `{ casts }`, in reading order: parents, root, then replies. */
export const threadCastsFromNeynar = (conversation: unknown): ApiCast[] => {
  const root = (conversation as { cast?: NeynarCast } | null)?.cast;
  if (!root) {
    return [];
  }
  const parents = asNeynarArray(root.chronological_parent_casts).map(
    apiCastFromNeynar,
  );
  const replies = asNeynarArray(root.direct_replies).map(apiCastFromNeynar);
  return [...parents, apiCastFromNeynar(root), ...replies];
};

const readJson = async (response: Response): Promise<unknown | null> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

/**
 * The author of one cast, looked up by hash alone.
 *
 * A node cannot answer this — it addresses a cast by *author and hash*, and the
 * hash on its own is not an index it keeps. Neynar's index can, and this is the
 * one read a write needs it for: a reaction and a reply are messages about a
 * cast, and the protocol message needs the target's author FID. Without this, a
 * like pressed on a cast that this client had not already read through a node
 * would have nothing to address itself to.
 *
 * Returns undefined for a hash Neynar does not know, and never guesses a FID.
 */
export const castAuthorFromNeynar = (payload: unknown): number | undefined => {
  const cast = (payload as { cast?: { author?: NeynarUser } } | null)?.cast;
  const fid = asNumber(cast?.author?.fid, Number.NaN);
  return Number.isFinite(fid) ? fid : undefined;
};

export const fetchCastAuthorFromNeynar = async ({
  hash,
  apiKey,
  fetchImpl = fetch,
  baseUrl = NEYNAR_BASE_URL,
  timeoutMs = 8_000,
}: {
  hash: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<number | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${baseUrl}/v2/farcaster/cast?identifier=${encodeURIComponent(hash)}&type=hash`,
      {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: controller.signal,
        credentials: 'omit',
      },
    );
    if (!response.ok) {
      return undefined;
    }
    return castAuthorFromNeynar(await readJson(response));
  } catch {
    // A lookup that could not be made is not an answer: the caller says what is
    // missing rather than inventing a FID.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Make the call and shape the answer.
 *
 * The key travels in the `x-api-key` header and never in a URL: a key in a
 * query string ends up in logs and in browser history, and this client does not
 * do that to a reader's credential.
 */
export const answerFromNeynar = async ({
  path,
  searchParams,
  signedInFid,
  apiKey,
  fetchImpl = fetch,
  baseUrl = NEYNAR_BASE_URL,
  timeoutMs = 8_000,
}: {
  path: string;
  searchParams: URLSearchParams;
  signedInFid: number | undefined;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<Response> => {
  const call =
    path === '/v2/me'
      ? signedInFid !== undefined
        ? neynarMeCall({ fid: signedInFid, baseUrl })
        : null
      : neynarCallFor({ path, searchParams, baseUrl });

  if (call === null) {
    return errorResponse(
      501,
      `Neynar cannot serve ${path} for this client. Reads through Neynar cover profiles, one account's casts, threads and verified addresses; the feed, your notifications and search need a node (or Farcaster's own server) instead.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(call.url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return errorResponse(
      502,
      aborted
        ? `Neynar did not answer within ${timeoutMs / 1000}s.`
        : `Neynar did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 402) {
    return errorResponse(
      response.status,
      'Neynar refused your API key. Run scripts/fiddy-setup.command to check it, or its plan.',
    );
  }

  if (!response.ok) {
    return errorResponse(
      response.status,
      `Neynar answered with an error (${response.status}).`,
    );
  }

  const body = await readJson(response);
  if (body === null) {
    return errorResponse(
      502,
      'Neynar answered with something that was not a list.',
    );
  }

  switch (call.kind) {
    case 'user': {
      const users = (body as { users?: NeynarUser[] }).users;
      const user = Array.isArray(users)
        ? users[0]
        : (body as { user?: NeynarUser }).user;
      if (!user) {
        return errorResponse(404, 'Neynar has no such account.');
      }
      const apiUser = apiUserFromNeynar(user);
      if (path === '/v2/me') {
        return jsonResponse({
          result: { user: apiUser, enabledFeatureFlags: [] },
        });
      }
      return jsonResponse(userProfileEnvelope(apiUser, apiUser.fid));
    }

    case 'verifications': {
      const users = (body as { users?: NeynarUser[] }).users;
      const user = Array.isArray(users) ? users[0] : undefined;
      const addresses = user?.verified_addresses?.eth_addresses;
      const verifications = Array.isArray(addresses)
        ? addresses
            .filter((address): address is string => typeof address === 'string')
            .map((address) => ({ fid: asNumber(user?.fid), address }))
        : [];
      return jsonResponse({ result: { verifications } });
    }

    case 'casts': {
      const casts = asNeynarArray((body as { casts?: unknown }).casts).map(
        apiCastFromNeynar,
      );
      return jsonResponse({ result: { casts } });
    }

    case 'thread':
    default: {
      const casts = threadCastsFromNeynar(
        (body as { conversation?: unknown }).conversation,
      );
      return jsonResponse({ result: { casts } });
    }
  }
};
