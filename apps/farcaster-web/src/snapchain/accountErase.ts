/**
 * Deleting the account, network half: the account's casts, likes, recasts and
 * follows are removed from Farcaster and its profile is emptied — one signed
 * remove message each, through the same provider seam every other write uses
 * (this device's own app key, the live provider's node, the node's own state
 * read back afterwards).
 *
 * Adapted from quilcast's `eraseFarcaster` (backmeupplz/quilcast@8aba47042319,
 * MIT), including its hard-won edges: a rate-limited or busy node is waited
 * out rather than reported lost; a remove the node answers as conflicting with
 * an existing remove counts as done; a follow stamped in the future is removed
 * with a NEWER timestamp than it; and at the end the node's lists are read
 * again — whatever they still hold is `failed`, with the node's reason.
 *
 * What this module deliberately does NOT do: touch the custody key, generate
 * or revoke keys, or sign with anything but the app key this device already
 * holds for the account. With no app key there is no erase — the caller says
 * so in place.
 */

import {
  buildCastRemoveMessage,
  buildLinkRemoveMessage,
  buildReactionRemoveMessage,
  buildUserDataAddMessage,
  hexToBytes,
  isNodeApiError,
  type NodeMessage,
  SnapchainNodeClient,
} from 'farcaster-node-client';

import {
  capabilitiesOf,
  providerPlainName,
} from '~/snapchain/providers/capabilities';
import { NEYNAR_NODE_BASE_URL } from '~/snapchain/providers/catalog';
import { neynarApiKeyFromEnv } from '~/snapchain/providers/preferences';
import type { NodeProvider } from '~/snapchain/providers/providerTypes';
import {
  currentProviderOrder,
  getProviderSnapshot,
} from '~/snapchain/providers/runtime';

export type EraseStep = 'casts' | 'reactions' | 'follows' | 'profile';

export type EraseProgress = (
  step: EraseStep | 'find',
  done: number,
  total: number,
) => void;

export interface Erased {
  casts: number;
  reactions: number;
  follows: number;
  profile: number;
  /** What the node still lists after the removals — said, never hidden. */
  failed: number;
  error?: string;
}

/** The profile fields a node accepts as emptied (the username stays with the account; GitHub cannot be emptied). */
const CLEARABLE_USER_DATA: Readonly<
  Record<
    string,
    'pfp' | 'display' | 'bio' | 'url' | 'location' | 'twitter' | 'banner'
  >
> = {
  USER_DATA_TYPE_PFP: 'pfp',
  USER_DATA_TYPE_DISPLAY: 'display',
  USER_DATA_TYPE_BIO: 'bio',
  USER_DATA_TYPE_URL: 'url',
  USER_DATA_TYPE_LOCATION: 'location',
  USER_DATA_TYPE_TWITTER: 'twitter',
  USER_DATA_TYPE_BANNER: 'banner',
};

/** Seconds from the Farcaster epoch (2021-01-01) until now. */
const farcasterNow = (): number => Math.floor(Date.now() / 1000) - 1609459200;

/** A busy node, a rate limit or a dropped connection is worth waiting out. */
const isRetryable = (error: unknown): boolean => {
  if (
    isNodeApiError(error) &&
    (error.status === 429 || (error.status >= 500 && error.status <= 504))
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|too many|\b(429|50[0-4])\b|timed? ?out|unavailable|busy|network|fetch|aborted|could not reach/i.test(
    message,
  );
};

/** A remove the node calls a conflict with an existing remove is done. */
const isAlreadyRemoved = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /conflict|duplicate|already/i.test(message);
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** About a minute and a half of waiting, at most, per message. */
async function patient<T>(
  f: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  tries = 8,
): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await f();
    } catch (error) {
      if (i >= tries - 1 || !isRetryable(error)) {
        throw error;
      }
      await sleep(Math.min(30_000, 1000 * 2 ** i));
    }
  }
}

/** Every message on one node list, all pages. */
async function everything(
  read: (pageToken?: string) => Promise<{
    messages: NodeMessage[];
    nextPageToken?: string;
  }>,
  sleep: (ms: number) => Promise<void>,
): Promise<NodeMessage[]> {
  const all: NodeMessage[] = [];
  for (let token: string | undefined, page = 0; ; page += 1) {
    if (page >= 1000) {
      throw new Error(
        'This account holds more than this flow can carry. Write to us from the support page and we will finish it by hand.',
      );
    }
    const result = await patient(() => read(token), sleep);
    all.push(...result.messages);
    if (!result.nextPageToken || result.messages.length === 0) {
      return all;
    }
    token = result.nextPageToken;
  }
}

interface ListedAccount {
  casts: string[];
  reactions: NodeMessage[];
  follows: NodeMessage[];
  profile: NodeMessage[];
}

/** What the node lists for the account right now. */
async function listAccount(
  node: SnapchainNodeClient,
  fid: number,
  sleep: (ms: number) => Promise<void>,
): Promise<ListedAccount> {
  const [casts, likes, recasts, follows, profile] = await Promise.all([
    everything(
      (pageToken) => node.castsByFid({ fid, pageSize: 1000, pageToken }),
      sleep,
    ),
    everything(
      (pageToken) =>
        node.reactionsByFid({
          fid,
          reactionType: 'Like',
          pageSize: 1000,
          pageToken,
        }),
      sleep,
    ),
    everything(
      (pageToken) =>
        node.reactionsByFid({
          fid,
          reactionType: 'Recast',
          pageSize: 1000,
          pageToken,
        }),
      sleep,
    ),
    everything(
      (pageToken) =>
        node.linksByFid({ fid, linkType: 'follow', pageSize: 1000, pageToken }),
      sleep,
    ),
    patient(() => node.userDataByFid({ fid, pageSize: 1000 }), sleep).then(
      (page) => page.messages,
    ),
  ]);
  return {
    casts: casts.map((message) => message.hash),
    reactions: [...likes, ...recasts].filter((message) => message.reaction),
    follows: follows.filter(
      (message) => typeof message.link?.targetFid === 'number',
    ),
    profile: profile.filter(
      (message) =>
        message.userData &&
        message.userData.value.length > 0 &&
        CLEARABLE_USER_DATA[message.userData.userDataType] !== undefined,
    ),
  };
}

export interface EraseOptions {
  fid: number;
  /** This device's app key for the account, as 0x-hex. */
  appKeyHex: string;
  /** The node to read and submit through. */
  node: SnapchainNodeClient;
  onProgress?: EraseProgress;
  /** Test seam: no real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** How long between the "is it gone yet" passes. */
  settleMs?: number;
}

/**
 * Remove the account's casts, reactions, follows and profile fields, a few at
 * a time; then read the node's lists again so anything still there is counted
 * as failed rather than claimed gone. Running it again only goes after what is
 * left.
 */
export const eraseFarcasterAccount = async ({
  fid,
  appKeyHex,
  node,
  onProgress = () => {},
  sleep = defaultSleep,
  settleMs = 3000,
}: EraseOptions): Promise<Erased> => {
  const signerPrivateKey = hexToBytes(appKeyHex);
  onProgress('find', 0, 0);
  const listed = await listAccount(node, fid, sleep);

  const out: Erased = {
    casts: 0,
    reactions: 0,
    follows: 0,
    profile: 0,
    failed: 0,
  };

  const submit = (bytes: Uint8Array) => node.submitMessage(bytes);

  // A like, follow or profile field is whatever its NEWEST message says, so a
  // remove must be newer than what it removes — including a message stamped in
  // the future by a clock running ahead.
  const newerThan = (timestamp: number): number =>
    Math.max(farcasterNow(), timestamp + 1);

  const run = async <T>(
    step: EraseStep,
    items: T[],
    remove: (item: T) => Promise<unknown>,
  ): Promise<void> => {
    let done = 0;
    onProgress(step, 0, items.length);
    const queue = items.values();
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        for (const item of queue) {
          await patient(() => remove(item), sleep).then(
            () => {
              out[step] += 1;
            },
            (error: unknown) => {
              if (step === 'casts' && isAlreadyRemoved(error)) {
                out[step] += 1;
              } else if (!out.error) {
                out.error =
                  error instanceof Error ? error.message : String(error);
              }
            },
          );
          done += 1;
          onProgress(step, done, items.length);
        }
      }),
    );
  };

  await run('casts', listed.casts, async (hash) => {
    const built = await buildCastRemoveMessage({
      fid,
      signerPrivateKey,
      targetHash: hash,
    });
    await submit(built.bytes);
  });

  await run('reactions', listed.reactions, async (message) => {
    const reaction = message.reaction;
    if (!reaction) {
      return;
    }
    const built = await buildReactionRemoveMessage({
      fid,
      signerPrivateKey,
      reactionType:
        reaction.reactionType === 'REACTION_TYPE_RECAST' ? 'recast' : 'like',
      ...(reaction.targetCastId
        ? {
            targetCastId: {
              fid: reaction.targetCastId.fid,
              hash: reaction.targetCastId.hash,
            },
          }
        : {}),
      ...(reaction.targetUrl ? { targetUrl: reaction.targetUrl } : {}),
      timestamp: newerThan(message.timestamp),
    });
    await submit(built.bytes);
  });

  await run('follows', listed.follows, async (message) => {
    const targetFid = message.link?.targetFid;
    if (typeof targetFid !== 'number') {
      return;
    }
    const built = await buildLinkRemoveMessage({
      fid,
      signerPrivateKey,
      targetFid,
      linkType: 'follow',
      timestamp: newerThan(message.timestamp),
    });
    await submit(built.bytes);
  });

  await run('profile', listed.profile, async (message) => {
    const userData = message.userData;
    const type = userData
      ? CLEARABLE_USER_DATA[userData.userDataType]
      : undefined;
    if (!userData || type === undefined) {
      return;
    }
    // There is no USER_DATA_REMOVE in the protocol: a field is cleared by
    // adding an empty value for it.
    const built = await buildUserDataAddMessage({
      fid,
      signerPrivateKey,
      userDataType: type,
      value: '',
      timestamp: newerThan(message.timestamp),
    });
    await submit(built.bytes);
  });

  // The node takes a message before its lists show it, so "is it gone?" is
  // asked a few times before anything counts as failed.
  for (let pass = 0; pass < 4; pass += 1) {
    if (pass > 0) {
      await sleep(settleMs);
    }
    const left = await listAccount(node, fid, sleep);
    out.failed =
      left.casts.length +
      left.reactions.length +
      left.follows.length +
      left.profile.length;
    if (out.failed === 0) {
      delete out.error;
      return out;
    }
  }
  if (!out.error) {
    out.error = 'The server that carries Farcaster still lists some of them.';
  }
  return out;
};

// ---------------------------------------------------------------------------
// which node carries it

export interface EraseNodeTarget {
  baseUrl: string;
  /** Plain words for the sentences a person reads ("Neynar", "Your node"). */
  label: string;
  headers?: Record<string, string>;
}

export const ERASE_NEEDS_A_WRITE_NODE =
  'The server you read Farcaster from cannot carry removals, so nothing was sent. Pick a server that can post under Settings → Your own setup, then try again.';

/**
 * The node an erase reads and submits through: the reader's own provider
 * order, the live one first, exactly as every other write chooses. A
 * reads-only provider is an honest refusal, never a silent fallback to a
 * server the reader did not choose.
 */
export const resolveEraseNode = (): EraseNodeTarget | { refusal: string } => {
  const order = currentProviderOrder();
  const health = getProviderSnapshot().health;
  const writable = order.filter(
    (provider: NodeProvider) => capabilitiesOf(provider).writes,
  );
  const chosen =
    writable.find((provider) => health[provider.id]?.status === 'live') ??
    writable[0];
  if (!chosen) {
    return { refusal: ERASE_NEEDS_A_WRITE_NODE };
  }
  if (chosen.kind === 'neynar') {
    const key = neynarApiKeyFromEnv();
    if (!key) {
      return { refusal: ERASE_NEEDS_A_WRITE_NODE };
    }
    return {
      baseUrl: NEYNAR_NODE_BASE_URL,
      label: providerPlainName(chosen),
      headers: { 'x-api-key': key },
    };
  }
  return { baseUrl: chosen.baseUrl, label: providerPlainName(chosen) };
};

export const eraseNodeClient = (target: EraseNodeTarget): SnapchainNodeClient =>
  new SnapchainNodeClient({
    baseUrl: target.baseUrl,
    ...(target.headers ? { headers: target.headers } : {}),
  });

// ---------------------------------------------------------------------------
// the server half: what fiddy.fun itself holds

export interface ServerPurgeResult {
  drafts: number;
  media: number;
  mediaKept: number;
  connect: number;
  connectFailed: number;
  fundingKept: boolean;
}

/** The hosted purge exists only where the control plane exists. */
export const serverPurgeAvailable = (): boolean =>
  typeof window !== 'undefined' && window.location.hostname === 'fiddy.fun';

/**
 * Ask fiddy.fun to forget the account (drafts, media, granted posting keys).
 * The service runs the purge as a background job — a big account outlives any
 * single request — so this asks, with the same run id, until it answers done.
 * Run BEFORE the network half: the service reads the casts to find the
 * account's media, so they must still be there when it looks.
 */
export const deleteServerData = async ({
  token,
  fetchImpl = fetch,
  sleep = defaultSleep,
}: {
  /** The account's fid — the session already names it; kept in the call so a
   *  caller cannot purge "whatever the token says" without saying for whom. */
  fid: number;
  /** The owner-session token for this account. */
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ServerPurgeResult> => {
  const run = crypto.randomUUID();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetchImpl(`/api/fiddy/account?run=${run}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    const body = (await response.json().catch(() => null)) as
      | ({
          ok?: boolean;
          state?: string;
          code?: string;
        } & Partial<ServerPurgeResult>)
      | null;
    if (!response.ok) {
      throw new Error(
        body?.code === 'RATE_LIMITED'
          ? 'Too many tries just now. Wait a little and try again.'
          : `Fiddy could not delete its side of the account (${body?.code ?? response.status}).`,
      );
    }
    if (body?.state === 'done') {
      return {
        drafts: body.drafts ?? 0,
        media: body.media ?? 0,
        mediaKept: body.mediaKept ?? 0,
        connect: body.connect ?? 0,
        connectFailed: body.connectFailed ?? 0,
        fundingKept: body.fundingKept === true,
      };
    }
    await sleep(1000);
  }
  throw new Error(
    'Fiddy is still deleting its side of the account. Try again in a few minutes.',
  );
};
