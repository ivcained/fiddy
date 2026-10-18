/**
 * "Include or exclude casts from other clients" — a *view-layer* preference,
 * never a protocol claim.
 *
 * Farcaster casts carry no client field. What they do carry is the `signer`
 * public key that signed them, and for a gasless key the node knows which app
 * FID requested it (`requestFid` on `GET /v1/signer`). So "which client is
 * this from" is resolved from the node's own signer records:
 *
 *   - `self`    — signed by this client's own app key (requestFid === your FID)
 *   - `known`   — requestFid maps to a name you (or a shared registry) supplied
 *   - `unknown` — an app FID nobody has named yet
 *   - `onchain` — signed by a custody/on-chain key, so no app FID exists
 *
 * Nothing here filters at the protocol level: the messages are all still on
 * your node and still valid. Hiding is a rendering decision the reader owns.
 */

import type { SnapchainNodeClient } from './http';
import type { NodeMessage, NodeSigner } from './types';

export type ClientKind = 'self' | 'known' | 'unknown' | 'onchain';

export interface ClientIdentity {
  /** Stable id used by the filter UI (`self`, `app:9152`, `signer:0x...`). */
  id: string;
  /** Human-readable label. */
  label: string;
  kind: ClientKind;
  /** The app FID that requested the key, when the node reports one. */
  requestFid?: number;
  /** The signer public key this identity was resolved from. */
  signerHex: string;
  /** `SIGNER_SOURCE_ONCHAIN` / `SIGNER_SOURCE_OFFCHAIN` / `unknown`. */
  source: string;
  /** Message scopes the key may sign (gasless keys only). */
  scopes?: string[];
}

/**
 * requestFid -> display name. Deliberately *not* pre-populated: an app FID is
 * only a name if someone vouches for the mapping, and this repo will not invent
 * attributions. Pass your own map (or one shared by a community registry).
 */
export type KnownClients = Record<number, string>;

export interface ResolveIdentityOptions {
  signerHex: string;
  /** The signer record from the node, when it could be fetched. */
  signer?: NodeSigner;
  /** Your FID: a key this FID requested belongs to this client. */
  selfAppFid?: number;
  knownClients?: KnownClients;
}

export const SELF_CLIENT_ID = 'self';

/** Pure: turn a signer record into a client identity. */
export const clientIdentityFor = ({
  signerHex,
  signer,
  selfAppFid,
  knownClients,
}: ResolveIdentityOptions): ClientIdentity => {
  const normalizedSigner = signerHex.toLowerCase();

  if (!signer) {
    return {
      id: `signer:${normalizedSigner}`,
      label: 'Unknown client',
      kind: 'unknown',
      signerHex: normalizedSigner,
      source: 'unknown',
    };
  }

  const source = signer.source;
  const requestFid = signer.requestFid;

  if (typeof selfAppFid === 'number' && requestFid === selfAppFid) {
    return {
      id: SELF_CLIENT_ID,
      label: 'Fiddy (this client)',
      kind: 'self',
      requestFid,
      signerHex: normalizedSigner,
      source,
      scopes: signer.scopes,
    };
  }

  if (typeof requestFid === 'number') {
    const known = knownClients?.[requestFid];
    return {
      id: `app:${requestFid}`,
      label: known ?? `Another client (app fid ${requestFid})`,
      kind: known ? 'known' : 'unknown',
      requestFid,
      signerHex: normalizedSigner,
      source,
      scopes: signer.scopes,
    };
  }

  return {
    id: `signer:${normalizedSigner}`,
    label: 'Direct on-chain signer',
    kind: 'onchain',
    signerHex: normalizedSigner,
    source,
    scopes: signer.scopes,
  };
};

export interface CastClientResolverOptions {
  node: SnapchainNodeClient;
  selfAppFid?: number;
  knownClients?: KnownClients;
  /** Skip `/v1/signer` lookups for these signer keys (they render as unknown). */
  unavailableSigners?: string[];
}

/**
 * Resolves the client behind each cast by looking up its signer on your node,
 * caching per signer key so a feed of 50 casts from 5 keys costs 5 reads.
 */
export class CastClientResolver {
  private readonly cache = new Map<string, ClientIdentity>();
  private readonly node: SnapchainNodeClient;
  private readonly selfAppFid?: number;
  private readonly knownClients?: KnownClients;

  constructor(options: CastClientResolverOptions) {
    this.node = options.node;
    this.selfAppFid = options.selfAppFid;
    this.knownClients = options.knownClients;
  }

  clear(): void {
    this.cache.clear();
  }

  async resolve(
    cast: Pick<NodeMessage, 'fid' | 'signer'>,
  ): Promise<ClientIdentity> {
    const key = cast.signer.toLowerCase();
    const cacheKey = `${cast.fid}:${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let signer: NodeSigner | undefined;
    try {
      signer = await this.node.signer({ fid: cast.fid, signer: key });
    } catch {
      signer = undefined;
    }

    const identity = clientIdentityFor({
      signerHex: key,
      signer,
      selfAppFid: this.selfAppFid,
      knownClients: this.knownClients,
    });
    this.cache.set(cacheKey, identity);
    return identity;
  }

  /**
   * Resolve clients for a page of casts, de-duplicating signer lookups. Casts
   * whose signer cannot be resolved come back as "unknown" rather than failing
   * the whole feed.
   */
  async resolveAll(
    casts: Pick<NodeMessage, 'fid' | 'signer'>[],
  ): Promise<Map<string, ClientIdentity>> {
    const unique = new Map<string, Pick<NodeMessage, 'fid' | 'signer'>>();
    for (const cast of casts) {
      const key = cast.signer.toLowerCase();
      if (!unique.has(key)) {
        unique.set(key, cast);
      }
    }
    const entries = await Promise.all(
      [...unique.values()].map(
        async (cast) =>
          [cast.signer.toLowerCase(), await this.resolve(cast)] as const,
      ),
    );
    return new Map(entries);
  }
}

export type ClientFilterMode = 'all' | 'only' | 'exclude';

export interface ClientFilterPolicy {
  /** `all` shows everything; `only` keeps listed clients; `exclude` hides them. */
  mode: ClientFilterMode;
  /** Client ids from {@link ClientIdentity.id} (`self`, `app:9152`, ...). */
  clientIds: string[];
}

export const defaultClientFilterPolicy: ClientFilterPolicy = {
  mode: 'all',
  clientIds: [],
};

export interface FilterByClientOptions {
  messages: NodeMessage[];
  /** Resolved identities keyed by lowercased signer hex. */
  clients: Map<string, ClientIdentity>;
  policy: ClientFilterPolicy;
  /** What to do when a cast's client is unknown: keep it (default) or hide it. */
  unknownClientBehavior?: 'keep' | 'hide';
}

/**
 * Pure view-layer filter.
 *
 * Two behaviours worth stating because they are asymmetric on purpose:
 *
 *   - `only` means *only*: a cast whose client could not be resolved is not one
 *     of the listed clients, so it is hidden. Narrowing to one client is an
 *     explicit request and honouring it half-way would be a bug.
 *   - `exclude` names clients to drop, so an unresolved client is kept (unless
 *     the caller passes `hide`) — hiding a stranger's cast because a lookup
 *     failed is worse than showing one you meant to filter.
 */
export const filterCastsByClient = ({
  messages,
  clients,
  policy,
  unknownClientBehavior = 'keep',
}: FilterByClientOptions): NodeMessage[] => {
  if (policy.mode === 'all' || policy.clientIds.length === 0) {
    return messages;
  }
  const listed = new Set(policy.clientIds);
  const keepListed = policy.mode === 'only';

  return messages.filter((message) => {
    const identity = clients.get(message.signer.toLowerCase());
    if (keepListed) {
      return identity ? listed.has(identity.id) : false;
    }
    if (!identity) {
      return unknownClientBehavior === 'keep';
    }
    return !listed.has(identity.id);
  });
};
