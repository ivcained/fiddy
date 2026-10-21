/**
 * What each server in the catalog can actually do — one matrix, three users.
 *
 * The reader asked for this in as many words: the picker must label every option
 * with what it is for ("reads + posts" / "reads only"), and the default
 * signed-in experience must run on a server that takes BOTH. A capability is not
 * a marketing word here; it is derived from what the client can really do
 * through that server, and the same answer is used by three callers so they can
 * never disagree:
 *
 *   the picker   (`~/pages/settingsNode/Component/ProviderListCard`)
 *                renders `label` and `writeDetail` next to each server
 *   the seam     (`providerFetch.ts`) decides which server can answer a request
 *                at all — see `providerCanServe`
 *   the pill     (`pill.ts`) can say why a write went where it went
 *
 * WHY A WRITE IS DIFFERENT FROM A READ, IN ONE SENTENCE
 *
 * A read asks a server a question; a write makes *this device* sign a message
 * and hands it to a server to carry. So a server can be perfectly good at reads
 * and still have nothing to carry a message with — that is `farcaster-public`,
 * whose own public API documents reads and takes no writes from a third-party
 * client at all. Both catalog servers that CAN carry a write do it the same way:
 * `POST /v1/submitMessage` with the bytes, one of them (Neynar's own node) also
 * wanting the reader's key in a header.
 *
 * MEASURED (2026-10-21, live, with the key this build was given):
 *
 *   GET  https://api.neynar.com/v2/farcaster/user/bulk?fids=1   → 200 (reads)
 *   GET  https://snapchain-api.neynar.com/v1/info               → 200 (a node)
 *   GET  https://hub-api.neynar.com/v1/info                     → 200 (a node)
 *
 * both Neynar node addresses answering real shard info with `x-api-key` — which
 * is what makes "Neynar = reads + posts" a fact rather than a hope.
 */

import {
  FARCASTER_PUBLIC_PROVIDER_ID,
  NEYNAR_PROVIDER_ID,
  type NodeProvider,
} from './providerTypes';

/** Plain words for a server, used by the sentences a failed write is phrased in. */
export const providerPlainName = (provider: NodeProvider): string => {
  switch (provider.kind) {
    case 'neynar':
      return 'Neynar';
    case 'farcaster-public':
      return "Farcaster's own public server";
    case 'snapchain':
    default:
      return provider.source === 'own' ? 'Your node' : 'The public relay';
  }
};

export interface ProviderCapability {
  /** Can this server answer the client's reads (feed, profile, thread, …)? */
  reads: boolean;
  /** Can it carry a message this device signed? */
  writes: boolean;
  /** Plain words for a picker row: "reads + posts" or "reads only". */
  label: string;
  /** One honest sentence about what a write through it really is. */
  writeDetail: string;
  /** What a reader loses by using it, if anything. */
  limit: string;
}

const SNAPCHAIN: ProviderCapability = {
  reads: true,
  writes: true,
  label: 'reads + posts',
  writeDetail:
    'Writes are signed on this device and handed to the node, which passes them to the network.',
  limit: 'Ranked feeds, search and direct messages are not on a node.',
};

const NEYNAR: ProviderCapability = {
  reads: true,
  writes: true,
  label: 'reads + posts',
  writeDetail:
    'Reads come from Neynar’s index; writes are signed on this device with your own key and handed to Neynar’s node.',
  limit:
    'The follow-graph feed, unseen counts and notifications still come from a node, and Neynar bills your own key.',
};

const FARCASTER_PUBLIC: ProviderCapability = {
  reads: true,
  writes: false,
  label: 'reads only',
  writeDetail:
    'It takes no writes at all: liking, posting and following cannot go through it.',
  limit: 'Read-only, and it cannot say how far behind the network it is.',
};

/** The capability of one server, in plain words. */
export const capabilitiesOf = (provider: NodeProvider): ProviderCapability => {
  switch (provider.kind) {
    case 'neynar':
      return NEYNAR;
    case 'farcaster-public':
      return FARCASTER_PUBLIC;
    case 'snapchain':
    default:
      return SNAPCHAIN;
  }
};

/**
 * Which route a request was classified into — the only thing that decides
 * whether it is a write.
 *
 * Deliberately NOT the HTTP method: the fork's data layer asks for the feed with
 * `POST /v2/feed-items` (a read with a body), so "POST means write" would have
 * sent the signed-in feed to Neynar's index, which has no feed at all. The
 * classification in `~/snapchain/nodeApi/hostedRoutes` is the one place that
 * knows what a request *is*; this matrix reads it.
 */
export type ServeableRouteKind =
  | 'write'
  | 'node'
  | 'local'
  | 'media'
  | 'hosted';

/**
 * Can this server answer this request?
 *
 * The honest answer for a read: a node answers everything this client asks of a
 * data source; Neynar answers the handful of reads its index really has (a
 * profile, one account's casts, a thread, verifications) and nothing else;
 * Farcaster's own public server answers the reads it documents.
 *
 * The honest answer for a write: only a server that can carry a signed message.
 * And a write is never *rerouted* — see the seam: if the server the reader is on
 * cannot write, the write is refused and the refusal says which server it is,
 * because a write commits something under the reader's name and moving it to
 * another machine behind their back is not this client's decision to make.
 */
export const providerCanServe = ({
  provider,
  kind,
  path,
}: {
  provider: NodeProvider;
  kind: ServeableRouteKind;
  path: string;
}): ServeDecision => {
  const capability = capabilitiesOf(provider);

  if (kind === 'write') {
    if (capability.writes) {
      return { can: true };
    }
    return {
      can: false,
      why: `${provider.label} is read-only: ${capability.writeDetail}`,
    };
  }

  if (provider.kind === 'neynar' && !NEYNAR_READ_PATHS.includes(path)) {
    return {
      can: false,
      why: `Neynar’s index does not serve ${path} for this client.`,
    };
  }

  return { can: true };
};

/**
 * Paths a Neynar key can answer, as this client asks for them.
 *
 * Kept here rather than imported from the mapper so the matrix has no cycle and
 * the picker can explain a server without building a Neynar URL to do it. It is
 * the same list `neynarMap.ts` serves — a test pins the two together.
 */
export const NEYNAR_READ_PATHS: readonly string[] = [
  '/v2/me',
  '/v2/user',
  '/v2/user-by-fid',
  '/v2/user-by-username',
  '/v2/user-casts',
  '/v2/profile-casts',
  '/v2/thread-casts',
  '/v2/verifications',
];

export interface ServeDecision {
  can: boolean;
  /** Why not, in plain words — the sentence a person would be shown. */
  why?: string;
}

/** Is this provider one of the two built-ins, or one the reader pointed at? */
export const isBuiltinProvider = (provider: NodeProvider): boolean =>
  provider.id === NEYNAR_PROVIDER_ID ||
  provider.id === FARCASTER_PUBLIC_PROVIDER_ID;
