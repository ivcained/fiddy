/** Opt-in, same-origin ciphertext sync. No provider or feed request uses this module. */
import { ensureOwnerSession } from '~/lib/fiddyOwnerSession';

import { compareSealedDraftVersions, openSealedDraftBox } from './crypto';
import {
  enrollSealedDraftKey,
  listSealedDraftKeys,
  recoverSealedDraftKey,
} from './keys';
import {
  readSealedValues,
  sealedCacheEntry,
  type SealedDraftRecord,
  sealedDraftWriterId,
  whenSealedValuesReady,
} from './runtime';

const DRAFTS_PATH = '/api/fiddy/drafts';
const syncKey = (fid: number) => `fiddy:sealed-drafts:sync:${fid}`;

export type DraftSyncState = {
  available: boolean;
  enabled: boolean;
  status: 'off' | 'syncing' | 'synced' | 'error';
  lockedCount: number;
};

const states = new Map<number, DraftSyncState>();
const notify = (fid: number) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('fiddy:draft-sync-state', { detail: { fid } }),
    );
  }
};
const setState = (fid: number, state: DraftSyncState) => {
  states.set(fid, state);
  notify(fid);
};

export const hostedDraftSyncAvailable = (): boolean =>
  typeof window !== 'undefined' && window.location.hostname === 'fiddy.fun';

export const draftSyncEnabled = (storage: Storage, fid: number): boolean =>
  hostedDraftSyncAvailable() && storage.getItem(syncKey(fid)) === 'yes';

export const getDraftSyncState = (
  storage: Storage,
  fid: number,
): DraftSyncState =>
  states.get(fid) ?? {
    available: hostedDraftSyncAvailable(),
    enabled: draftSyncEnabled(storage, fid),
    status: draftSyncEnabled(storage, fid) ? 'synced' : 'off',
    lockedCount: sealedCacheEntry(storage, fid, 'node').lockedCount,
  };

const ownerSession = (fid: number) => ensureOwnerSession(fid);

const request = async <T>(
  session: { token: string },
  method: 'GET' | 'PUT' | 'DELETE',
  body?: SealedDraftRecord,
): Promise<T> => {
  const response = await fetch(DRAFTS_PATH, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${session.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Draft sync failed (${response.status})`);
  }
  return (await response.json()) as T;
};

const kindFor = (id: string): 'node' | 'recovery' | null =>
  id.startsWith('s_') || id.startsWith('c_')
    ? 'node'
    : id.startsWith('r_')
      ? 'recovery'
      : null;

const queues = new Map<string, Promise<void>>();

export const syncDraftsNow = async (
  storage: Storage,
  fid: number,
): Promise<void> => {
  if (!draftSyncEnabled(storage, fid)) {
    return;
  }
  setState(fid, {
    available: true,
    enabled: true,
    status: 'syncing',
    lockedCount: sealedCacheEntry(storage, fid, 'node').lockedCount,
  });
  try {
    const session = await ownerSession(fid);
    const payload = await request<{ drafts?: SealedDraftRecord[] }>(
      session,
      'GET',
    );
    const remote = Array.isArray(payload.drafts) ? payload.drafts : [];
    for (const kind of ['node', 'recovery'] as const) {
      readSealedValues(storage, fid, kind);
      await whenSealedValuesReady(storage, fid, kind);
      const entry = sealedCacheEntry(storage, fid, kind);
      for (const record of remote) {
        if (kindFor(record.id) !== kind) {
          continue;
        }
        const local = entry.records[record.id];
        if (!local || compareSealedDraftVersions(record, local) > 0) {
          entry.records[record.id] = { ...record };
          delete entry.values[record.id];
          entry.dirty.add(record.id);
        }
      }
      const local = Object.values(entry.records);
      for (const record of local) {
        const other = remote.find((candidate) => candidate.id === record.id);
        if (!other || compareSealedDraftVersions(record, other) > 0) {
          const answer = await request<{ draft?: SealedDraftRecord }>(
            session,
            'PUT',
            record,
          );
          if (answer.draft) {
            entry.records[record.id] = answer.draft;
          }
        }
      }
      entry.revision += 1;
      const { persistSealedEntry } = await import('./store');
      await persistSealedEntry({
        storage,
        fid,
        kind,
        entry,
        revision: entry.revision,
        fromSync: true,
      });
    }
    setState(fid, {
      available: true,
      enabled: true,
      status: 'synced',
      lockedCount:
        sealedCacheEntry(storage, fid, 'node').lockedCount +
        sealedCacheEntry(storage, fid, 'recovery').lockedCount,
    });
  } catch (error) {
    setState(fid, {
      available: true,
      enabled: true,
      status: 'error',
      lockedCount: sealedCacheEntry(storage, fid, 'node').lockedCount,
    });
    throw error;
  }
};

export const scheduleDraftSync = (storage: Storage, fid: number): void => {
  if (!draftSyncEnabled(storage, fid)) {
    return;
  }
  const key = `${fid}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => syncDraftsNow(storage, fid))
    .catch(() => undefined);
  queues.set(key, next);
};

const reencryptLocalDrafts = async (storage: Storage, fid: number) => {
  const { persistSealedEntry } = await import('./store');
  const keys = await listSealedDraftKeys(fid);
  for (const kind of ['node', 'recovery'] as const) {
    readSealedValues(storage, fid, kind);
    await whenSealedValuesReady(storage, fid, kind);
    const entry = sealedCacheEntry(storage, fid, kind);
    for (const [id, record] of Object.entries(entry.records)) {
      if (!(id in entry.values) && record.box !== null) {
        // A recovery code can arrive after this device called the box locked.
        // Try the newly installed key history before deciding it stays locked.
        for (const key of keys) {
          try {
            entry.values[id] = await openSealedDraftBox({
              key,
              fid,
              id,
              box: record.box,
            });
            break;
          } catch {
            // Try the next enrolled or retired key.
          }
        }
      }
      if (id in entry.values && record.box !== null) {
        record.box = '';
        entry.dirty.add(id);
      }
    }
    entry.revision += 1;
    await persistSealedEntry({
      storage,
      fid,
      kind,
      entry,
      revision: entry.revision,
      fromSync: true,
    });
  }
};

export const enableDraftSync = async (
  storage: Storage,
  fid: number,
): Promise<{ recoveryCode: string }> => {
  if (!hostedDraftSyncAvailable()) {
    throw new Error('Drafts stay on this device. Sync is not available here.');
  }
  const [{ recoveryCode }] = await Promise.all([
    enrollSealedDraftKey(fid),
    ownerSession(fid),
  ]);
  storage.setItem(syncKey(fid), 'yes');
  await reencryptLocalDrafts(storage, fid);
  scheduleDraftSync(storage, fid);
  return { recoveryCode };
};

export const recoverDraftSync = async (
  storage: Storage,
  fid: number,
  recoveryCode: string,
): Promise<void> => {
  if (!hostedDraftSyncAvailable()) {
    throw new Error('Drafts stay on this device. Sync is not available here.');
  }
  await recoverSealedDraftKey(fid, recoveryCode);
  await ownerSession(fid);
  storage.setItem(syncKey(fid), 'yes');
  await reencryptLocalDrafts(storage, fid);
  await syncDraftsNow(storage, fid);
};

export const disableDraftSync = (storage: Storage, fid: number): void => {
  storage.removeItem(syncKey(fid));
  setState(fid, {
    available: hostedDraftSyncAvailable(),
    enabled: false,
    status: 'off',
    lockedCount: 0,
  });
};

/** Account removal: ciphertext and tombstones are deleted server-side. */
export const deleteSyncedDrafts = async (
  storage: Storage,
  fid: number,
): Promise<void> => {
  const session = await ownerSession(fid);
  await request(session, 'DELETE');
  disableDraftSync(storage, fid);
};

export const currentWriterId = (storage: Storage): string =>
  sealedDraftWriterId(storage);
