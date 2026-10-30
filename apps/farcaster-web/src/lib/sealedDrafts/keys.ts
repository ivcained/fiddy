/** Non-extractable draft keys live in IndexedDB, never in localStorage or requests. */
import { createDraftRecoveryCode, importDraftRecoveryCode } from './crypto';

const DATABASE = 'fiddy-sealed-drafts';
const STORE = 'keys';
const activeKeyId = (fid: number) => `${fid}:active`;
const historyKeyId = (fid: number, index: number) => `${fid}:history:${index}`;

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Draft key storage is blocked'));
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
};

const putKey = (id: string, key: CryptoKey): Promise<IDBValidKey> =>
  withStore('readwrite', (store) => store.put(key, id));

/** Active key first, then every retired key so old remote boxes remain readable. */
export const listSealedDraftKeys = async (
  fid: number,
): Promise<CryptoKey[]> => {
  const active = await withStore<CryptoKey | undefined>('readonly', (store) =>
    store.get(activeKeyId(fid)),
  );
  const keys = active ? [active] : [];
  for (let index = 0; index < 20; index += 1) {
    const retired = await withStore<CryptoKey | undefined>(
      'readonly',
      (store) => store.get(historyKeyId(fid, index)),
    );
    if (!retired) {
      break;
    }
    keys.push(retired);
  }
  return keys;
};

const installKey = async (fid: number, key: CryptoKey): Promise<void> => {
  const [active, ...history] = await listSealedDraftKeys(fid);
  if (active) {
    await putKey(historyKeyId(fid, 0), active);
  }
  for (let index = 0; index < history.length; index += 1) {
    await putKey(historyKeyId(fid, index + 1), history[index]);
  }
  await putKey(activeKeyId(fid), key);
};

/** Local privacy needs no signature and no network. */
export const ensureLocalSealedDraftKey = async (
  fid: number,
): Promise<CryptoKey> => {
  const [active] = await listSealedDraftKeys(fid);
  if (active) {
    return active;
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await installKey(fid, key);
  return key;
};

/** Explicit sync enrollment. The recovery code is shown once, then discarded. */
export const enrollSealedDraftKey = async (
  fid: number,
): Promise<{ recoveryCode: string }> => {
  const enrollmentKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const recoveryCode = await createDraftRecoveryCode(enrollmentKey);
  const browserKey = await importDraftRecoveryCode(recoveryCode);
  await installKey(fid, browserKey);
  return { recoveryCode };
};

export const recoverSealedDraftKey = async (
  fid: number,
  recoveryCode: string,
): Promise<void> => {
  const key = await importDraftRecoveryCode(recoveryCode);
  await installKey(fid, key);
};

export const clearSealedDraftKeys = async (fid: number): Promise<void> => {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.delete(activeKeyId(fid));
      for (let index = 0; index < 20; index += 1) {
        store.delete(historyKeyId(fid, index));
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
};
