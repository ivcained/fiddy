import { openSealedDraftBox, sealDraftValue } from './crypto';
import { ensureLocalSealedDraftKey, listSealedDraftKeys } from './keys';
import {
  type SealedCacheEntry,
  type SealedCollectionKind,
  type SealedDraftRecord,
  sealStorageKey,
} from './runtime';

const isRecord = (value: unknown): value is SealedDraftRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<SealedDraftRecord>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 80 &&
    (typeof record.box === 'string' || record.box === null) &&
    typeof record.updatedAt === 'number' &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt > 0 &&
    typeof record.writerId === 'string'
  );
};

const readRecords = (
  storage: Storage,
  fid: number,
  kind: SealedCollectionKind,
): SealedDraftRecord[] => {
  try {
    const raw = storage.getItem(sealStorageKey(fid, kind));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as { records?: unknown };
    return Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [];
  } catch {
    return [];
  }
};

export const hydrateSealedEntry = async ({
  storage,
  fid,
  kind,
  entry,
  revision,
}: {
  storage: Storage;
  fid: number;
  kind: SealedCollectionKind;
  entry: SealedCacheEntry;
  revision: number;
}): Promise<void> => {
  const records = readRecords(storage, fid, kind);
  const keys = await listSealedDraftKeys(fid);
  const values: Record<string, unknown> = {};
  const recordsById: Record<string, SealedDraftRecord> = {};
  let lockedCount = 0;
  for (const record of records) {
    recordsById[record.id] = record;
    if (record.box === null) {
      continue;
    }
    let opened = false;
    for (const key of keys) {
      try {
        values[record.id] = await openSealedDraftBox({
          key,
          fid,
          id: record.id,
          box: record.box,
        });
        opened = true;
        break;
      } catch {
        // Try a retired key before calling this honestly locked.
      }
    }
    if (!opened) {
      lockedCount += 1;
    }
  }
  if (entry.revision === revision) {
    entry.values = values;
    entry.records = recordsById;
    entry.lockedCount = lockedCount;
  }
};

export const persistSealedEntry = async ({
  storage,
  fid,
  kind,
  entry,
  revision,
  fromSync = false,
}: {
  storage: Storage;
  fid: number;
  kind: SealedCollectionKind;
  entry: SealedCacheEntry;
  revision: number;
  fromSync?: boolean;
}): Promise<void> => {
  if (entry.dirty.size === 0) {
    return;
  }
  const key = await ensureLocalSealedDraftKey(fid);
  const records = { ...entry.records };
  const dirty = new Set(entry.dirty);
  for (const id of dirty) {
    const record = records[id];
    if (!record) {
      continue;
    }
    if (id in entry.values) {
      record.box = await sealDraftValue({
        key,
        fid,
        id,
        value: entry.values[id],
      });
    } else if (record.box) {
      // A newer remote box won the conflict merge. Open it for this device if
      // one of our keys can; otherwise keep the ciphertext and its locked state.
      const keys = await listSealedDraftKeys(fid);
      for (const candidate of keys) {
        try {
          entry.values[id] = await openSealedDraftBox({
            key: candidate,
            fid,
            id,
            box: record.box,
          });
          break;
        } catch {
          // Another key wrote it. It stays visible as locked, never disappears.
        }
      }
    } else {
      record.box = null;
    }
  }
  if (entry.revision !== revision) {
    return;
  }
  entry.records = records;
  entry.lockedCount = Object.values(records).filter(
    (record) => record.box !== null && !(record.id in entry.values),
  ).length;
  for (const id of dirty) {
    entry.dirty.delete(id);
  }
  const active = Object.values(records).filter((record) => record.box !== null);
  const tombstones = Object.values(records)
    .filter((record) => record.box === null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 200);
  const kept = [...active, ...tombstones];
  storage.setItem(
    sealStorageKey(fid, kind),
    JSON.stringify({ version: 1, records: kept }),
  );
  if (kind === 'node') {
    storage.removeItem(`fiddy:node-drafts:${fid}`);
  }
  if (kind === 'recovery') {
    storage.removeItem('local-caststorm-draft');
    storage.removeItem('local-caststorm-drafts-by-key');
  }
  if (!fromSync) {
    void import('./sync').then((module) =>
      module.scheduleDraftSync(storage, fid),
    );
  }
};
