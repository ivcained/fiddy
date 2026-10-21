/**
 * "Connect your Farcaster account" — one tap, no fee, no passphrase.
 *
 * WHAT THE PERSON SEES, IN ORDER
 *
 *   idle      one sentence about what they are about to allow, and one button
 *   waiting   the link, on a phone a deep link and on a desktop a code to scan;
 *             this screen notices on its own the moment they approve, so nothing
 *             has to be pressed a second time
 *   connected what is now true ("Fiddy can post for you"), and how to undo it
 *   stopped   after they turn it off — from here or in Farcaster
 *   problem   what actually happened, in a sentence, plus the honest fallback
 *
 * WHAT IT WILL NOT DO
 *
 * - It never says "connected" until the service says so.
 * - It never leaves a dead button: a failure replaces the screen with a
 *   sentence and a way forward.
 * - It never uses the words this product bans from its own screens (no
 *   "signer", no "scope", no "TTL", no "gasless") — the thing the person granted
 *   is "a posting key", and what it can do is "post for you".
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { QRCode } from 'react-qrcode-logo';

import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { routes } from '~/constants/routes';
import { getOnboardingStateKey } from '~/constants/storage';
import { useAuth } from '~/contexts/AuthProvider';
import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
} from '~/lib/siwfSession';
import {
  type ConnectStatus,
  connectStatus,
  rememberConnectStatus,
  startConnect,
  stopConnect,
} from '~/snapchain/accounts/managedConnect';
import { setItem } from '~/utils/storageUtils';

/** How often the waiting screen asks the service for news. */
const POLL_MS = 2_500;

/** After this long waiting, the screen says what to check instead of sitting silent. */
const SLOW_HINT_AFTER_MS = 60_000;

/** Past the hint, the asking slows down: it is a person's phone, not a race. */
const SLOW_POLL_MS = 10_000;

type View =
  | { name: 'idle'; notice?: string }
  | { name: 'starting' }
  | { name: 'waiting'; approvalUrl: string }
  | { name: 'connected'; fid: number; username: string | null }
  | { name: 'stopped' }
  | { name: 'problem'; message: string };

export interface ConnectSheetProps {
  /** Called when the sheet is done — the page closes it, a modal dismisses it. */
  onClose?: () => void;
}

const statusToView = (status: ConnectStatus): View => {
  if (status.state === 'connected' && status.fid !== null) {
    return { name: 'connected', fid: status.fid, username: status.username };
  }
  if (status.state === 'waiting' && status.approvalUrl !== null) {
    return { name: 'waiting', approvalUrl: status.approvalUrl };
  }
  if (status.state === 'revoked') {
    return { name: 'stopped' };
  }
  return { name: 'idle' };
};

export const ConnectSheet = memo<ConnectSheetProps>(({ onClose }) => {
  const { authToken, signIn } = useAuth();
  const [view, setView] = useState<View>({ name: 'idle' });
  const [slow, setSlow] = useState(false);
  const [working, setWorking] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * What is already true, asked once when the sheet opens: somebody who approved
   * a minute ago and navigated back must not be shown the first screen again.
   * A service we cannot reach leaves the first screen up (the button retries and
   * says what happened); it never becomes a scary screen of its own.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const status = await connectStatus();
        rememberConnectStatus(status);
        if (live && mounted.current) {
          setView(statusToView(status));
        }
      } catch {
        // Stay on the first screen; pressing the button asks again and reports.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /** While a link is waiting, watch for the approval — nobody presses twice. */
  const waitingUrl = view.name === 'waiting' ? view.approvalUrl : null;
  useEffect(() => {
    if (waitingUrl === null) {
      return undefined;
    }
    let live = true;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    const ask = async () => {
      try {
        const status = await connectStatus();
        rememberConnectStatus(status);
        if (!live || !mounted.current) {
          return;
        }
        const next = statusToView(status);
        if (next.name !== 'waiting') {
          setView(next);
          return;
        }
      } catch {
        // A blip is not news: keep the screen as it is and ask again.
      }
      if (!live || !mounted.current) {
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_HINT_AFTER_MS) {
        setSlow(true);
      }
      timer = setTimeout(
        ask,
        elapsed > SLOW_HINT_AFTER_MS ? SLOW_POLL_MS : POLL_MS,
      );
    };

    timer = setTimeout(ask, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waitingUrl]);

  const begin = useCallback(async () => {
    setWorking(true);
    setSlow(false);
    try {
      const { status } = await startConnect();
      rememberConnectStatus(status);
      if (!mounted.current) {
        return;
      }
      setView(statusToView(status));
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      setView({ name: 'problem', message: (error as Error).message });
    } finally {
      if (mounted.current) {
        setWorking(false);
      }
    }
  }, []);

  const turnOff = useCallback(async () => {
    setWorking(true);
    try {
      const status = await stopConnect();
      rememberConnectStatus(status);
      if (mounted.current) {
        setView({ name: 'stopped' });
      }
    } catch (error) {
      if (mounted.current) {
        setView({ name: 'problem', message: (error as Error).message });
      }
    } finally {
      if (mounted.current) {
        setWorking(false);
      }
    }
  }, []);

  /**
   * Sign in as the account that just approved Fiddy, using the same
   * device-only session the Farcaster sign-in produces — this person has just
   * proven, in their own Farcaster app, that the account is theirs.
   */
  const continueAs = useCallback(
    async (fid: number, username: string | null) => {
      setWorking(true);
      try {
        const token = buildLocalAuthToken({ fid });
        const onboardingState = buildLocalOnboardingState({
          fid,
          ...(username === null ? {} : { username }),
        });
        await setItem({
          key: await getOnboardingStateKey(token.secret),
          value: onboardingState,
        });
        await signIn({ authToken: token });
        window.location.replace(routes.homeFeed.path);
      } catch (error) {
        if (mounted.current) {
          setView({ name: 'problem', message: (error as Error).message });
        }
      } finally {
        if (mounted.current) {
          setWorking(false);
        }
      }
    },
    [signIn],
  );

  if (view.name === 'starting') {
    return (
      <FiddySheet
        name="connect-starting"
        title="Setting it up…"
        sub="One moment while we ask Farcaster for a posting key for you."
        egg="small"
      />
    );
  }

  if (view.name === 'waiting') {
    return (
      <FiddySheet
        name="connect-waiting"
        title="One tap in Farcaster to finish"
        sub="Open this in the Farcaster app on your phone and approve Fiddy. This screen notices by itself — you can leave it open."
        egg="small"
        primary={{
          label: 'Open Farcaster',
          onClick: () => window.open(view.approvalUrl, '_blank', 'noopener'),
        }}
        quiet={{ label: 'Not now', onClick: () => onClose?.() }}
        note={
          slow
            ? 'Still waiting. If nothing happened on your phone, open the link again from this screen.'
            : 'The link below is the request; approving it costs you nothing.'
        }
      >
        <div className="fiddy-connect-qr" data-fiddy="connect-qr">
          <QRCode
            bgColor="#161715"
            ecLevel="M"
            eyeRadius={0}
            fgColor="#eef0e8"
            size={196}
            value={view.approvalUrl}
          />
        </div>
        <a
          className="fiddy-connect-link"
          data-fiddy="connect-approval-link"
          href={view.approvalUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          Open the approval page in Farcaster
        </a>
      </FiddySheet>
    );
  }

  if (view.name === 'connected') {
    const handle = view.username === null ? null : `@${view.username}`;
    return (
      <FiddySheet
        name="connect-connected"
        title={handle === null ? 'Connected' : `Connected as ${handle}`}
        sub="Fiddy can post for you — turn it off anytime."
        egg="small"
        primary={
          authToken === undefined
            ? {
                label: 'Continue',
                onClick: () => void continueAs(view.fid, view.username),
                disabled: working,
              }
            : { label: 'Done', onClick: () => onClose?.() }
        }
        quiet={{
          label: 'Turn it off',
          onClick: () => void turnOff(),
          disabled: working,
        }}
        note="Your account stays yours: Fiddy holds a posting key you granted, and you can take it back here or in your Farcaster app's settings."
      >
        <p className="fiddy-connect-body" data-fiddy="connect-promise">
          You will not be asked for a passphrase, and you were not charged
          anything.
        </p>
      </FiddySheet>
    );
  }

  if (view.name === 'stopped') {
    return (
      <FiddySheet
        name="connect-stopped"
        title="Fiddy's access is off"
        sub="Your posting key is gone. Fiddy cannot post for you until you connect again."
        egg="small"
        primary={{
          label: 'Connect again',
          onClick: () => void begin(),
          disabled: working,
        }}
        quiet={{ label: 'Done', onClick: () => onClose?.() }}
      />
    );
  }

  if (view.name === 'problem') {
    return (
      <FiddySheet
        name="connect-problem"
        title="That did not go through"
        sub={view.message}
        egg="small"
        primary={{
          label: 'Try again',
          onClick: () => void begin(),
          disabled: working,
        }}
        quiet={{ label: 'Close', onClick: () => onClose?.() }}
        note="Nothing changed in your account. You can keep reading Farcaster here, and post in your Farcaster app as usual."
      />
    );
  }

  return (
    <FiddySheet
      name="connect-idle"
      title="Connect your Farcaster account"
      sub="Let Fiddy post for you — your posts, your replies, your likes — without a fee and without a passphrase."
      egg="hero"
      primary={{
        label: 'Connect',
        onClick: () => void begin(),
        disabled: working,
      }}
      quiet={{ label: 'Not now', onClick: () => onClose?.() }}
      note={
        view.notice ??
        'Fiddy asks your Farcaster app for a posting key. Your account, its key and its recovery phrase stay where they are.'
      }
    />
  );
});

ConnectSheet.displayName = 'ConnectSheet';
