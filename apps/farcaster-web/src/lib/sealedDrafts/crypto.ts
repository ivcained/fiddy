/**
 * Browser-only AES-GCM for sealed cast drafts.
 *
 * The box format and the ciphertext-only sync idea come from
 * backmeupplz/quilcast (MIT). The key design deliberately does not: Fiddy uses
 * an explicit, account-independent recovery code instead of signing a fixed
 * message with a custody wallet. Associated data binds every box to its FID
 * and stable draft id, so a server cannot swap ciphertext between owners.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BOX_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const base64UrlDecode = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Malformed sealed draft');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const associatedData = (fid: number, id: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(`fiddy:sealed-draft:v1:${fid}:${id}`);

export const sealDraftValue = async ({
  key,
  fid,
  id,
  value,
}: {
  key: CryptoKey;
  fid: number;
  id: string;
  value: unknown;
}): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = encoder.encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(fid, id) },
    key,
    plaintext,
  );
  return `${BOX_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(sealed))}`;
};

export const openSealedDraftBox = async <T>({
  key,
  fid,
  id,
  box,
}: {
  key: CryptoKey;
  fid: number;
  id: string;
  box: string;
}): Promise<T> => {
  const parts = box.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== BOX_VERSION ||
    !parts[1] ||
    !parts[2]
  ) {
    throw new Error('Malformed sealed draft');
  }
  const iv = base64UrlDecode(parts[1]);
  const ciphertext = base64UrlDecode(parts[2]);
  if (iv.length !== IV_BYTES || ciphertext.length <= 16) {
    throw new Error('Malformed sealed draft');
  }
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(fid, id) },
    key,
    ciphertext,
  );
  return JSON.parse(decoder.decode(opened)) as T;
};

/** Only an enrollment key created extractable for this one operation can be shown. */
export const createDraftRecoveryCode = async (
  enrollmentKey: CryptoKey,
): Promise<string> => {
  const raw = new Uint8Array(
    await crypto.subtle.exportKey('raw', enrollmentKey),
  );
  if (raw.length !== KEY_BYTES) {
    throw new Error('Invalid draft key');
  }
  return base64UrlEncode(raw);
};

/** Recovery always lands as a non-extractable browser key. */
export const importDraftRecoveryCode = async (
  recoveryCode: string,
): Promise<CryptoKey> => {
  const compact = recoveryCode.replaceAll(/\s+/gu, '');
  const raw = base64UrlDecode(compact);
  if (raw.length !== KEY_BYTES) {
    throw new Error('Invalid draft recovery code');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

/**
 * Newest timestamp wins; the lexicographically smaller writer id breaks ties.
 * This is exactly the control plane's order, so a retried stale write converges.
 */
export const compareSealedDraftVersions = (
  left: { updatedAt: number; writerId: string },
  right: { updatedAt: number; writerId: string },
): number => {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  return right.writerId.localeCompare(left.writerId);
};
