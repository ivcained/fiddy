/**
 * The "let Fiddy post as you" offer, as the shell sees it: one decision, one
 * setup, and the states in between.
 *
 * The decision itself is pure and lives in `./postForYouOffer` — this file only
 * makes the observations (is this a device session, is the node adapter on and
 * a server named, does this device already hold a pass, did the reader already
 * say not now) and runs the setup the Advanced screen uses.
 *
 * Session identity is read from the CACHED onboarding state, never from the
 * network, for the same reason `useDeviceOnlySession` does: this is asked on
 * every authed shell mount, including the ones where a read is exactly what is
 * broken, so it must not be able to fail or suspend.
 */

import { useCachedOnboardingState } from 'farcaster-client-hooks';
import type { IssueAppKeyStep } from 'farcaster-node-client';
import { useCallback, useEffect, useState } from 'react';

import { localApiEnabled } from '~/constants/api';
import { useAuth } from '~/contexts/AuthProvider';
import { isLocalSessionToken } from '~/lib/siwfSession';
import { isNodeBackedClientEnabled } from '~/snapchain/nodeApi/nodeBackedClientFlag';
import { isNodeConfigured } from '~/snapchain/nodeChoice';
import { useNodeClient } from '~/snapchain/useNodeClient';

import {
  decidePostForYou,
  describeSetupFailure,
  type PassState,
  type PostForYouDecision,
  readPassState,
  readSaidNotNow,
  rememberSaidNotNow,
  setUpPostingForYou,
} from './postForYouOffer';

/** How long the "done" line stays up before the card takes itself away. */
const DONE_LINGER_MS = 4000;

type PostForYouPhase =
  | 'idle'
  | 'asking-for-phrase'
  | 'setting-up'
  | 'done'
  | 'failed';

interface PostForYou {
  decision: PostForYouDecision;
  phase: PostForYouPhase;
  /** Which step of the setup is running, in the protocol's words (mapped to plain words by the card). */
  step: IssueAppKeyStep | null;
  error: string | null;
  /** Open the blocking warning + phrase step. */
  offer: () => void;
  /** Close the phrase step without setting up (the account is untouched). */
  closePhraseStep: () => void;
  /** "Not now" — remembered on this device, so the offer is made once. */
  sayNotNow: () => void;
  setUp: (mnemonic: string) => Promise<void>;
}

const usePostForYou = (): PostForYou => {
  const { authToken } = useAuth();
  const user = useCachedOnboardingState().result.state.user;
  const node = useNodeClient();

  const fid = user?.fid;

  const [passState, setPassState] = useState<PassState>('unknown');
  const [saidNotNow, setSaidNotNow] = useState<boolean | undefined>(undefined);
  const [phase, setPhase] = useState<PostForYouPhase>('idle');
  const [step, setStep] = useState<IssueAppKeyStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Whether this device already holds a pass for the account. Storage is async,
  // so the offer waits for the answer instead of flashing and retracting.
  useEffect(() => {
    if (fid === undefined) {
      setPassState('unknown');
      return undefined;
    }
    let alive = true;
    readPassState(fid).then((state) => {
      if (alive) {
        setPassState(state);
      }
    });
    return () => {
      alive = false;
    };
  }, [fid]);

  useEffect(() => {
    if (fid === undefined) {
      setSaidNotNow(undefined);
      return undefined;
    }
    let alive = true;
    readSaidNotNow(fid).then((said) => {
      if (alive) {
        setSaidNotNow(said);
      }
    });
    return () => {
      alive = false;
    };
  }, [fid]);

  const decision = decidePostForYou({
    // The marker for "this device signed in and holds no server-side token",
    // read the same way `useDeviceOnlySession` reads it: a local token, in a
    // build where the mock API is not the thing serving the shell.
    isLocalDeviceSession:
      isLocalSessionToken(authToken) === true && !localApiEnabled,
    adapterEnabled: isNodeBackedClientEnabled(),
    nodeConfigured: isNodeConfigured(),
    fid,
    passState,
    saidNotNow,
  });

  const offer = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('asking-for-phrase');
  }, []);

  const closePhraseStep = useCallback(() => {
    setError(null);
    setStep(null);
    setPhase('idle');
  }, []);

  const sayNotNow = useCallback(() => {
    setPhase('idle');
    setSaidNotNow(true);
    if (fid !== undefined) {
      void rememberSaidNotNow(fid);
    }
  }, [fid]);

  const setUp = useCallback(
    async (mnemonic: string) => {
      if (fid === undefined || node === undefined) {
        setError(
          'This device has no account to set this up for yet — sign in again.',
        );
        setPhase('failed');
        return;
      }

      setPhase('setting-up');
      setError(null);

      try {
        await setUpPostingForYou({
          node,
          fid,
          mnemonic,
          onStep: (nextStep) => setStep(nextStep),
        });
        setStep(null);
        setPassState('present');
        setPhase('done');
      } catch (err) {
        setStep(null);
        setError(
          describeSetupFailure(
            err instanceof Error ? err.message : String(err),
          ),
        );
        setPhase('failed');
      }
    },
    [fid, node],
  );

  // The done line is the last thing this card says; it takes itself away.
  useEffect(() => {
    if (phase !== 'done') {
      return undefined;
    }
    const timer = setTimeout(() => setPhase('idle'), DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return {
    decision,
    phase,
    step,
    error,
    offer,
    closePhraseStep,
    sayNotNow,
    setUp,
  };
};

export { usePostForYou };
export type { PostForYou, PostForYouPhase };
