/**
 * Synchronous local-first facade over the lazy sealed-draft implementation.
 * Composer writes update this memory cache immediately; encryption and sync are
 * trailing work and can never block Cast. Nothing in the eager entry imports
 * Web Crypto, enrollment, or the sync client from this module.
 */

export type SealedCollectionKind = 'node' | 'recovery';
export type SealedValues = Record<string, unknown>;
export type SealedDraftRecord = {
  id: string;
  box: string | null;
  updatedAt: number;
  writerId: string;
};

export type SealedCacheEntry = {
  values: SealedValues;
  records: Record<string, SealedDraftRecord>;
  dirty: Set<string>;
  revision: number;
  ready: Promise<void>;
  lockedCount: number;
};

const caches = new WeakMap<Storage, Map<string, SealedCacheEntry>>();
const writerIds = new WeakMap<Storage, string>();

const collectionKey = (fid: number, kind: SealedCollectionKind) =>
  `${fid}:${kind}`;

export const sealStorageKey = (
  fid: number,
  kind: SealedCollectionKind,
): string => `fiddy:sealed-drafts:v1:${fid}:${kind}`;

export const sealedDraftWriterId = (storage: Storage): string => {
  const existing = writerIds.get(storage);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  writerIds.set(storage, created);
  return created;
};

const emptyEntry = (): SealedCacheEntry => ({
  values: {},
  records: {},
  dirty: new Set(),
  revision: 0,
  ready: Promise.resolve(),
  lockedCount: 0,
});

const entryFor = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
): SealedCacheEntry => {
  let collections = caches.get(storage);
  if (!collections) {
    collections = new Map();
    caches.set(storage, collections);
  }
  const key = collectionKey(fid, kind);
  let entry = collections.get(key);
  if (!entry) {
    entry = emptyEntry();
    collections.set(key, entry);
  }
  return entry;
};

const notify = (fid: number, kind: SealedCollectionKind) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('fiddy:sealed-drafts-changed', { detail: { fid, kind } }),
    );
  }
};

const schedule = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
  entry: SealedCacheEntry,
  hydrate: boolean,
) => {
  const revision = entry.revision;
  const previous = entry.ready;
  entry.ready = previous
    .catch(() => undefined)
    .then(() => import('./store'))
    .then((module) =>
      hydrate
        ? module.hydrateSealedEntry({ storage, fid, kind, entry, revision })
        : module.persistSealedEntry({ storage, fid, kind, entry, revision }),
    )
    .then(() => {
      notify(fid, kind);
    })
    .catch(() => {
      // Storage/crypto failure cannot block the composer. The synchronous
      // memory copy remains usable and legacy storage is left untouched.
    });
};

export const readSealedValues = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
  legacyValues?: SealedValues,
): SealedValues => {
  const entry = entryFor(storage, fid, kind);
  const firstRead =
    entry.revision === 0 && Object.keys(entry.records).length === 0;
  if (firstRead && legacyValues && Object.keys(legacyValues).length > 0) {
    const writerId = sealedDraftWriterId(storage);
    entry.values = { ...legacyValues };
    for (const id of Object.keys(legacyValues)) {
      entry.records[id] = { id, box: '', updatedAt: Date.now(), writerId };
      entry.dirty.add(id);
    }
    entry.revision += 1;
    schedule(storage, fid, kind, entry, false);
  } else if (firstRead) {
    entry.revision += 1;
    schedule(storage, fid, kind, entry, true);
  }
  return entry.values;
};

export const writeSealedValues = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
  values: SealedValues,
): void => {
  const entry = entryFor(storage, fid, kind);
  const writerId = sealedDraftWriterId(storage);
  const now = Date.now();
  for (const id of new Set([
    ...Object.keys(entry.values),
    ...Object.keys(values),
  ])) {
    if (entry.values[id] !== values[id]) {
      entry.dirty.add(id);
      entry.records[id] = {
        id,
        box: id in values ? (entry.records[id]?.box ?? '') : null,
        updatedAt: now,
        writerId,
      };
    }
  }
  entry.values = { ...values };
  entry.revision += 1;
  schedule(storage, fid, kind, entry, false);
};

export const whenSealedValuesReady = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
): Promise<void> => entryFor(storage, fid, kind).ready;

export const sealedCacheEntry = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
): SealedCacheEntry => entryFor(storage, fid, kind);

export const resetSealedDraftRuntimeForTests = (storage?: Storage): void => {
  if (storage) {
    caches.delete(storage);
    writerIds.delete(storage);
  }
};
