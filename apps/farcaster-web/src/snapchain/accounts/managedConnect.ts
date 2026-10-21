/**
 * "Connect your Farcaster account" — one tap, no fee, and no passphrase.
 *
 * WHAT THIS IS
 *
 * A person who already has a Farcaster account can let Fiddy post for them
 * without paying anything and without ever handling a recovery phrase. The
 * browser asks Fiddy's own service for a *posting key* the protocol has been
 * asked to grant; the service answers with a link to open in the Farcaster app;
 * the person approves it there; and from then on Fiddy writes as them — and only
 * for the things they asked it to do. Their account, its custody key and its
 * phrase stay exactly where they were: in their own Farcaster app.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * Nowhere near here. The Neynar key, the app account's signing key and the
 * signer's own identifier are all held by the service
 * (`lib/fiddy-connect.ts` on fiddy.fun's control plane — the same endpoints the
 * plugin's first-run setup uses, so there is one implementation, not two). What
 * this browser holds is an opaque handle inside an **HttpOnly cookie**: no
 * script can read it, and nothing here ever sees a secret.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never reports "connected" from anything but the service's own answer
 *   (`state: 'connected'`), and it reads an answer it does not recognise as
 *   `unknown` rather than as success.
 * - It never posts as one account for another: a write goes through only when
 *   the connected account's FID *is* the signed-in FID.
 * - It never leaves the person with a dead button: every failure names what
 *   happened, in a sentence, and the caller can offer the slower path instead.
 */

/** Where the service lives. Same origin, so the cookie rides along on its own. */
const CONNECT_ENDPOINT = '/api/fiddy/connect';
const WRITE_ENDPOINT = `${CONNECT_ENDPOINT}/write`;

/** How long a remembered answer is trusted before the service is asked again. */
const STATUS_TTL_MS = 30_000;

export type ConnectState =
  | 'none'
  | 'waiting'
  | 'connected'
  | 'revoked'
  | 'unknown';

export interface ConnectStatus {
  state: ConnectState;
  /** The link the person opens in their Farcaster app, while there is one. */
  approvalUrl: string | null;
  /** The account the posting key belongs to, once it has been approved. */
  fid: number | null;
  username: string | null;
}

export const NO_CONNECTION: ConnectStatus = {
  state: 'none',
  approvalUrl: null,
  fid: null,
  username: null,
};

/** What went wrong, in words a screen can show as they are. */
export class ConnectUnavailableError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ConnectUnavailableError';
    this.code = code;
    this.status = status;
  }
}

const UNAVAILABLE_SENTENCE =
  "we couldn't reach the part of Fiddy that sets this up - nothing was connected.";

/**
 * The service's answer, read defensively. An unknown state, a missing field or
 * an answer that is not an object all come back as `unknown`; the one thing this
 * never does is guess "connected".
 */
const readStatus = (payload: unknown): ConnectStatus => {
  if (typeof payload !== 'object' || payload === null) {
    return { ...NO_CONNECTION, state: 'unknown' };
  }
  const raw = payload as Record<string, unknown>;
  const state = raw.state;
  const known: ConnectState[] = ['none', 'waiting', 'connected', 'revoked'];
  return {
    state:
      typeof state === 'string' && (known as string[]).includes(state)
        ? (state as ConnectState)
        : 'unknown',
    approvalUrl:
      typeof raw.approvalUrl === 'string' && raw.approvalUrl.startsWith('http')
        ? raw.approvalUrl
        : null,
    fid: typeof raw.fid === 'number' && raw.fid > 0 ? raw.fid : null,
    username:
      typeof raw.username === 'string' && raw.username.length > 0
        ? raw.username
        : null,
  };
};

const failureFor = (
  status: number,
  payload: unknown,
): ConnectUnavailableError => {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const message =
    typeof raw.message === 'string' && raw.message.trim().length > 0
      ? raw.message
      : UNAVAILABLE_SENTENCE;
  const code = typeof raw.code === 'string' ? raw.code : 'CONNECT_UNAVAILABLE';
  return new ConnectUnavailableError(code, status, message);
};

const postJson = async (
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ status: number; payload: unknown }> => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The handle is in an HttpOnly cookie, so a cross-origin send would drop it.
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
};

// ------------------------------------------------------------------ the states

/** What the connection is, asked of the service. */
export const connectStatus = async ({
  fetchImpl = fetch,
}: { fetchImpl?: typeof fetch } = {}): Promise<ConnectStatus> => {
  let response: Response;
  try {
    response = await fetchImpl(CONNECT_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw failureFor(response.status, payload);
  }
  return readStatus(payload);
};

/**
 * One tap: the service creates the posting key and hands back the link the
 * person opens. A second press while a link is still waiting is answered with
 * *that same link* (`reused`) rather than a second, costly request.
 */
export const startConnect = async ({
  fetchImpl = fetch,
}: { fetchImpl?: typeof fetch } = {}): Promise<{
  status: ConnectStatus;
  reused: boolean;
}> => {
  let answered: { status: number; payload: unknown };
  try {
    answered = await postJson(CONNECT_ENDPOINT, {}, fetchImpl);
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw failureFor(answered.status, answered.payload);
  }
  return {
    status: readStatus(answered.payload),
    reused: Boolean(
      (answered.payload as Record<string, unknown> | null)?.reused,
    ),
  };
};

/** Turn it off here: the key is removed, not merely forgotten. */
export const stopConnect = async ({
  fetchImpl = fetch,
}: { fetchImpl?: typeof fetch } = {}): Promise<ConnectStatus> => {
  let response: Response;
  try {
    response = await fetchImpl(CONNECT_ENDPOINT, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  } catch {
    throw new ConnectUnavailableError(
      'CONNECT_UNREACHABLE',
      0,
      UNAVAILABLE_SENTENCE,
    );
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw failureFor(response.status, payload);
  }
  return readStatus(payload);
};

// ------------------------------------------------------- the write path's seam

let remembered: { at: number; status: ConnectStatus } | null = null;

/** The last answer the service gave, if it is still fresh enough to use. */
const freshStatus = (): ConnectStatus | null =>
  remembered !== null && Date.now() - remembered.at < STATUS_TTL_MS
    ? remembered.status
    : null;

const remember = (status: ConnectStatus): ConnectStatus => {
  remembered = { at: Date.now(), status };
  return status;
};

/** Called by the screens whenever they learn a state, so the writer agrees. */
export const rememberConnectStatus = (status: ConnectStatus): void => {
  remember(status);
};

/** Called when the person signs out or switches accounts. */
export const forgetRememberedConnect = (): void => {
  remembered = null;
};

/**
 * May a write for this account go through the granted posting key?
 *
 * Asked once per half-minute at most, and answered *only* for the account the
 * connection belongs to: a connection for one FID is never used to write as
 * another. A service that cannot be reached answers "no" here — the caller then
 * says what is missing rather than pretending the write went somewhere.
 */
export const canWriteThroughConnect = async (
  fid: number | undefined,
): Promise<boolean> => {
  if (fid === undefined) {
    return false;
  }
  try {
    const status = freshStatus() ?? remember(await connectStatus());
    return status.state === 'connected' && status.fid === fid;
  } catch {
    return false;
  }
};

export interface ConnectWrite {
  kind: 'cast' | 'reaction' | 'link';
  text?: string;
  castHash?: string;
  reaction?: 'like' | 'recast';
  add?: boolean;
  targetFid?: number;
  parentHash?: string;
  parentUrl?: string;
  embeds?: string[];
}

export type ConnectWriteAnswer =
  | { ok: true; hash: string | null }
  | { ok: false; status: number; message: string };

/**
 * Hand one write to the service that holds the key. This is the *submit* half
 * only: whether it landed is read back from the node, exactly as a
 * device-signed write is.
 */
export const writeThroughConnect = async (
  write: ConnectWrite,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<ConnectWriteAnswer> => {
  let answered: { status: number; payload: unknown };
  try {
    answered = await postJson(WRITE_ENDPOINT, write, fetchImpl);
  } catch {
    return { ok: false, status: 0, message: UNAVAILABLE_SENTENCE };
  }
  const raw = (answered.payload ?? {}) as Record<string, unknown>;
  if (answered.status < 200 || answered.status >= 300) {
    return {
      ok: false,
      status: answered.status,
      message:
        typeof raw.message === 'string' && raw.message.trim().length > 0
          ? raw.message
          : UNAVAILABLE_SENTENCE,
    };
  }
  return {
    ok: true,
    hash: typeof raw.hash === 'string' && raw.hash.length > 0 ? raw.hash : null,
  };
};

/** The poster `~/snapchain/nodeApi/nodeWrites` uses when a connection exists. */
export const managedPoster = {
  available: canWriteThroughConnect,
  post: writeThroughConnect,
};
