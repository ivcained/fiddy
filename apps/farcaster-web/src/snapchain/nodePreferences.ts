/**
 * View-layer preferences for the node-backed surfaces, stored per FID.
 *
 * Two things live here, and neither is a protocol claim:
 *
 *   - the include/exclude client filter policy (which clients' casts to show),
 *   - the labels you give other clients, keyed by the app FID that requested
 *     their key. Labels are yours: this client never invents a name for an app
 *     FID, because an app FID is only a name if someone vouches for the mapping.
 */

import type { ClientFilterPolicy } from 'farcaster-node-client';

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

const FILTER_POLICY_NAMESPACE = 'snapchain_filter_policy';
const CLIENT_LABELS_NAMESPACE = 'snapchain_client_labels';

const policyKey = (fid: number): string => `${FILTER_POLICY_NAMESPACE}_${fid}`;
const labelsKey = (fid: number): string => `${CLIENT_LABELS_NAMESPACE}_${fid}`;

export const DEFAULT_FILTER_POLICY: ClientFilterPolicy = {
  mode: 'all',
  clientIds: [],
};

const isPolicy = (value: unknown): value is ClientFilterPolicy => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ClientFilterPolicy>;
  return (
    (candidate.mode === 'all' ||
      candidate.mode === 'only' ||
      candidate.mode === 'exclude') &&
    Array.isArray(candidate.clientIds) &&
    candidate.clientIds.every((id) => typeof id === 'string')
  );
};

export const loadFilterPolicy = async (
  fid: number,
): Promise<ClientFilterPolicy> => {
  const stored = await getItem<ClientFilterPolicy | null>({
    key: policyKey(fid),
    fallback: null,
  });
  // Storage is user-editable and survives upgrades: validate before trusting.
  return isPolicy(stored) ? stored : DEFAULT_FILTER_POLICY;
};

export const saveFilterPolicy = async (
  fid: number,
  policy: ClientFilterPolicy,
): Promise<void> => {
  await setItem({ key: policyKey(fid), value: policy });
};

export const clearFilterPolicy = (fid: number): Promise<void> =>
  deleteItem(policyKey(fid));

const isLabels = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every(
    (label) => typeof label === 'string',
  );

/** Labels keyed by app FID as a string (storage round-trips JSON keys as strings). */
export type ClientLabels = Record<string, string>;

export const loadClientLabels = async (fid: number): Promise<ClientLabels> => {
  const stored = await getItem<ClientLabels | null>({
    key: labelsKey(fid),
    fallback: null,
  });
  return isLabels(stored) ? stored : {};
};

export const saveClientLabels = async (
  fid: number,
  labels: ClientLabels,
): Promise<void> => {
  await setItem({ key: labelsKey(fid), value: labels });
};

/**
 * The client-id form the filter UI uses (`self`, `app:9152`, `signer:0x...`).
 * Only `app:<fid>` ids can carry a label — a signer id has no app FID to name.
 */
export const requestFidFromClientId = (clientId: string): number | null => {
  const match = /^app:(\d+)$/.exec(clientId);
  if (!match) {
    return null;
  }
  const fid = Number(match[1]);
  return Number.isSafeInteger(fid) ? fid : null;
};

/** Set or clear one label; an empty label removes the entry. */
export const withClientLabel = (
  labels: ClientLabels,
  clientId: string,
  label: string,
): ClientLabels => {
  const requestFid = requestFidFromClientId(clientId);
  if (requestFid === null) {
    return labels;
  }
  const next = { ...labels };
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    delete next[String(requestFid)];
  } else {
    next[String(requestFid)] = trimmed;
  }
  return next;
};

/** Storage shape -> the `knownClients` map the resolver takes (numeric keys). */
export const toKnownClients = (
  labels: ClientLabels,
): Record<number, string> => {
  const known: Record<number, string> = {};
  for (const [key, label] of Object.entries(labels)) {
    const fid = Number(key);
    if (Number.isSafeInteger(fid) && label.trim().length > 0) {
      known[fid] = label;
    }
  }
  return known;
};
