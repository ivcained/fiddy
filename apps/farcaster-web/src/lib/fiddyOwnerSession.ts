/**
 * The Farcaster owner session, shared by every feature that talks to
 * fiddy.fun's own `/api/fiddy/*` routes as the account owner (drafts sync,
 * account deletion).
 *
 * One session, one account: the token's claims carry the FID, so a session
 * minted for one account is never presented for another. `existing` answers
 * without minting (a read that may not spend the SIWF proof); `ensure` mints
 * through the saved sign-in proof when nothing valid is held, and clears that
 * proof once it is spent — the same lifecycle the drafts sync has always had.
 */

import {
  type AgentServiceSession,
  DEFAULT_AGENT_SERVICE_URL,
  loadAgentSession,
  saveAgentSession,
} from '~/lib/agentService';
import { openOwnerSession } from '~/lib/fiddyAgentAutopair';
import { loadFiddySetup } from '~/lib/fiddySetup';
import { clearSiwfProof, loadSiwfProof } from '~/lib/siwfSession';

/** The FID a token speaks for, or null when it is expired or unreadable. */
export const ownerSessionFid = (token: string): number | null => {
  try {
    const payload = token.split('.')[1];
    const parsed = JSON.parse(
      atob(payload.replaceAll('-', '+').replaceAll('_', '/')),
    ) as {
      fid?: unknown;
      exp?: unknown;
    };
    return typeof parsed.fid === 'number' &&
      typeof parsed.exp === 'number' &&
      parsed.exp > Date.now()
      ? parsed.fid
      : null;
  } catch {
    return null;
  }
};

/**
 * The session this device already holds for `fid`, or null. Never mints:
 * minting spends the one-time SIWF proof, and a feature that only wants to
 * know "could I call home?" must not consume it.
 */
export const existingOwnerSession = async (
  fid: number,
): Promise<AgentServiceSession | null> => {
  const existing = await loadAgentSession();
  if (
    existing?.baseUrl === DEFAULT_AGENT_SERVICE_URL &&
    ownerSessionFid(existing.token) === fid
  ) {
    return existing;
  }
  return null;
};

/**
 * A valid session for `fid`, minting one from the saved sign-in proof when
 * needed. Throws with a sentence a person can act on when no proof is held.
 */
export const ensureOwnerSession = async (
  fid: number,
): Promise<AgentServiceSession> => {
  const existing = await existingOwnerSession(fid);
  if (existing) {
    return existing;
  }
  const outcome = await openOwnerSession({
    proof: loadSiwfProof(),
    setup: loadFiddySetup(),
  });
  if (!outcome.ok || ownerSessionFid(outcome.session.token) !== fid) {
    throw new Error(
      outcome.ok
        ? 'Sign in again before this device can prove it is you.'
        : outcome.sentence,
    );
  }
  const session = {
    baseUrl: DEFAULT_AGENT_SERVICE_URL,
    token: outcome.session.token,
  };
  await saveAgentSession(session);
  clearSiwfProof();
  return session;
};
