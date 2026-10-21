/**
 * The providers this build knows, and the order the reader wants them tried in.
 *
 * ORDER RULES (one place, so the picker, the pill and the failover engine can
 * never disagree):
 *
 *   1. the server the reader chose in the node picker, if they chose one —
 *      their own node, or a public one they picked
 *   2. then anything else in their stored list, in the order they put it
 *   3. then Fiddy's public relay (the node this client reads from today)
 *   4. always last: `api.farcaster.xyz`, the safety net. It is read-only here
 *      and cannot report how far behind it is, so it is never a first choice.
 *
 * Neynar sits where the reader puts it: it needs their key, and it is a
 * different kind of server (an index, not a node), so it is only ever in the
 * list when they turned it on.
 */

import { PUBLIC_READ_NODES } from '~/snapchain/nodeChoice';

import {
  FARCASTER_PUBLIC_PROVIDER_ID,
  NEYNAR_PROVIDER_ID,
  type NodeProvider,
  normalizeBaseUrl,
  snapchainProviderId,
} from './providerTypes';

/**
 * Re-exported so a caller that resolves an order can also name a provider in it
 * without importing two modules. `providerTypes` stays the definition.
 */
export { FARCASTER_PUBLIC_PROVIDER_ID, NEYNAR_PROVIDER_ID };

/** Farcaster's own public client API. Documented public reads, no account. */
export const FARCASTER_PUBLIC_BASE_URL = 'https://api.farcaster.xyz';

/** Neynar's hosted index. Reads need the reader's own API key. */
export const NEYNAR_BASE_URL = 'https://api.neynar.com';

/**
 * The public relay this client reads from today, as a provider.
 *
 * `PUBLIC_READ_NODES` is the picker's own list, and every entry on it was
 * measured live before it was added. This builds a provider out of the first
 * entry rather than hard-coding a second copy of the URL — one list, one truth.
 */
export const defaultPublicRelay = (): NodeProvider | null => {
  const first = PUBLIC_READ_NODES[0];
  if (!first) {
    return null;
  }
  return {
    id: snapchainProviderId(first.url),
    kind: 'snapchain',
    source: 'public',
    label: 'Our public node',
    detail: first.note,
    baseUrl: normalizeBaseUrl(first.url),
    readOnly: false,
  };
};

export const ownNodeProvider = (baseUrl: string): NodeProvider => ({
  id: snapchainProviderId(baseUrl),
  kind: 'snapchain',
  source: 'own',
  label: 'The node you run',
  detail: 'Your own machine. Reads and writes both go here.',
  baseUrl: normalizeBaseUrl(baseUrl),
  readOnly: false,
});

export const publicNodeProvider = (baseUrl: string): NodeProvider => ({
  id: snapchainProviderId(baseUrl),
  kind: 'snapchain',
  source: 'public',
  label: 'Another public node',
  detail: 'Somebody else keeps this one open to read from.',
  baseUrl: normalizeBaseUrl(baseUrl),
  readOnly: false,
});

export const neynarProvider = (): NodeProvider => ({
  id: NEYNAR_PROVIDER_ID,
  kind: 'neynar',
  source: 'builtin',
  label: 'Neynar (needs your key)',
  detail:
    'A hosted index with its own limits and its own bill. Reads only for now; your key stays on this device.',
  baseUrl: NEYNAR_BASE_URL,
  readOnly: false,
});

export const farcasterPublicProvider = (): NodeProvider => ({
  id: FARCASTER_PUBLIC_PROVIDER_ID,
  kind: 'farcaster-public',
  source: 'builtin',
  label: "Farcaster's own public server",
  detail:
    'Open to everyone and needs no account — but a web page is not allowed to read it at all (it permits its own origins only), it cannot write, and it cannot say how far behind it is. Fiddy cannot read it from a page, so it never answers here. Listed so you can see what it is.',
  baseUrl: FARCASTER_PUBLIC_BASE_URL,
  readOnly: true,
});

/** The list a reader starts with: our relay, then the safety net. */
export const defaultProviderOrder = (): NodeProvider[] => {
  const order: NodeProvider[] = [];
  const relay = defaultPublicRelay();
  if (relay) {
    order.push(relay);
  }
  order.push(farcasterPublicProvider());
  return order;
};

/** Every provider this build can offer when nothing has been chosen yet. */
export const availableProviders = ({
  neynarConfigured,
}: {
  neynarConfigured: boolean;
}): NodeProvider[] => {
  const providers = [
    ...PUBLIC_READ_NODES.map((node) => publicNodeProvider(node.url)),
  ];
  providers.push(neynarProvider());
  providers.push(farcasterPublicProvider());
  if (!neynarConfigured) {
    // Still listed — the reader needs to see that it exists and what it wants —
    // but the caller can tell it is not ready to use.
    return providers;
  }
  return providers;
};

export interface ResolveProviderOrderInput {
  /**
   * The server picked in the node picker (its storage lives in
   * `~/snapchain/nodeChoice`), if the reader picked one.
   */
  chosen: { kind: 'public' | 'own'; url: string } | null;
  /** Provider ids the reader arranged, in their order. */
  storedIds: string[];
  /** Is a Neynar key present in this build? Without one it cannot be used. */
  neynarConfigured: boolean;
}

/**
 * The reader's ordered list, as providers.
 *
 * Unknown stored ids are dropped rather than guessed at (a stored order is
 * user-editable and survives upgrades). `farcaster-public` is appended last if
 * the reader's own list left it out, so there is always a safety net — and it
 * is never duplicated.
 */
export const resolveProviderOrder = ({
  chosen,
  storedIds,
  neynarConfigured,
}: ResolveProviderOrderInput): NodeProvider[] => {
  const order: NodeProvider[] = [];
  const seen = new Set<string>();

  const push = (provider: NodeProvider | null): void => {
    if (!provider || seen.has(provider.id)) {
      return;
    }
    seen.add(provider.id);
    order.push(provider);
  };

  if (chosen) {
    push(
      chosen.kind === 'own'
        ? ownNodeProvider(chosen.url)
        : publicNodeProvider(chosen.url),
    );
  }

  for (const id of storedIds) {
    if (id === NEYNAR_PROVIDER_ID) {
      if (neynarConfigured) {
        push(neynarProvider());
      }
      continue;
    }
    if (id === FARCASTER_PUBLIC_PROVIDER_ID) {
      continue; // appended last, always
    }
    const url = id.startsWith('snapchain:')
      ? id.slice('snapchain:'.length)
      : null;
    if (url) {
      push(publicNodeProvider(url));
    }
  }

  if (order.length === 0) {
    const relay = defaultPublicRelay();
    if (relay) {
      push(relay);
    }
  } else {
    // A reader who runs their own node still gets Fiddy's relay behind it, as a
    // real backup. MEASURED (2026-10-20, scripts/verify-provider-picker.mjs):
    // without this, a chosen own node that goes slow leaves the list with only
    // the safety net behind it, and the safety net cannot serve several of the
    // client's reads (`/v2/unseen`, the direct-cast inbox) — so the reader's
    // feed lands on a server that answers the pill's question and not the
    // client's. The relay is a full node; it belongs right behind their choice.
    push(defaultPublicRelay());
  }

  push(farcasterPublicProvider());
  return order;
};

/** The provider a stored id names, when this build can still offer it. */
export const providerForStoredId = ({
  id,
  neynarConfigured,
}: {
  id: string;
  neynarConfigured: boolean;
}): NodeProvider | null => {
  if (id === NEYNAR_PROVIDER_ID) {
    return neynarConfigured ? neynarProvider() : null;
  }
  if (id === FARCASTER_PUBLIC_PROVIDER_ID) {
    return farcasterPublicProvider();
  }
  const url = id.startsWith('snapchain:')
    ? id.slice('snapchain:'.length)
    : null;
  return url && url.length > 0 ? publicNodeProvider(url) : null;
};
