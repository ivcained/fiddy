/**
 * The reminder to back an account up — offered, never forced.
 *
 * WHAT A PERSON SEES, AND WHY IN THAT ORDER. A notice, in plain words, that says
 * what losing this device would cost and offers a way to be safe. It dismisses
 * ("Not now" is a real answer, and it buys days — see `~/lib/seedBackup`), and it
 * comes back later if it was put off, until the person says it is done.
 *
 * THE WORDS ARE HIDDEN UNTIL ASKED FOR. Opening the panel shows a blurred block
 * — deliberately unreadable at a glance, so nothing sensitive is sitting on a
 * screen someone walks past — and a tap reveals it. Nothing here is a wall: the
 * reveal is one press, and the reveal step is where a person is told plainly that
 * these words are the account, that anyone who reads them owns it, and that
 * writing them down somewhere private is the point.
 *
 * WHAT IT WILL NOT DO. It will not print words this device does not hold. For an
 * account made with Google or X the phrase lives in the sign-up provider's
 * custody, so the panel says so and offers that provider's own secure window
 * (`heldWordsSlot`) rather than showing an address and calling it a backup. It
 * never says "saved" on the person's behalf, either: the confirm step is a press
 * they make, and until they make it the asking resumes.
 */

import { X } from 'lucide-react';
import React, { FC, memo, useCallback, useEffect, useState } from 'react';

import {
  deferBackup,
  initialSeedBackupState,
  loadSeedBackupState,
  markBackupSaved,
  noteBackupAsked,
  saveSeedBackupState,
  type SeedBackupState,
  shouldAskForBackup,
} from '~/lib/seedBackup';
import { SOCIAL_PROVIDERS } from '~/lib/socialSignUp';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

type Step = 'loading' | 'hidden' | 'ask' | 'reveal' | 'done';

type SeedBackupNoticeProps = {
  account: LocalAccount;
  /**
   * The sign-up provider's own secure window, for an account whose words are
   * held for it. Rendered inside the revealed panel; absent when there is none.
   */
  heldWordsSlot?: React.ReactNode;
};

const providerNameFor = (account: LocalAccount): string | undefined =>
  SOCIAL_PROVIDERS.find((provider) => provider.id === account.provider)?.name;

const SeedBackupNotice: FC<SeedBackupNoticeProps> = memo(
  ({ account, heldWordsSlot }) => {
    const [step, setStep] = useState<Step>('loading');
    const [state, setState] = useState<SeedBackupState>(initialSeedBackupState);
    const [revealed, setRevealed] = useState(false);

    const heldForThem = account.walletCustody === 'privy' || !account.phrase;
    const providerName = providerNameFor(account);

    useEffect(() => {
      let live = true;

      void (async () => {
        const stored = await loadSeedBackupState(account.id);

        if (!live) {
          return;
        }

        const now = Date.now();

        if (!shouldAskForBackup(stored, now)) {
          setState(stored);
          setStep('hidden');
          return;
        }

        // Recorded as asked, so a reload is not a fresh ask. The unread answer
        // stays "unseen", so a later visit does ask again.
        const asked = noteBackupAsked(stored, now);
        await saveSeedBackupState(account.id, asked);

        if (!live) {
          return;
        }

        setState(asked);
        setStep('ask');
      })();

      return () => {
        live = false;
      };
    }, [account.id]);

    const defer = useCallback(async () => {
      const next = deferBackup(state, Date.now());

      setState(next);
      setStep('hidden');
      await saveSeedBackupState(account.id, next);
    }, [account.id, state]);

    const confirmSaved = useCallback(async () => {
      const next = markBackupSaved(state, Date.now());

      setState(next);
      setStep('done');
      await saveSeedBackupState(account.id, next);
    }, [account.id, state]);

    if (step === 'loading' || step === 'hidden') {
      return null;
    }

    if (step === 'done') {
      return (
        <section
          className="fiddy-notice"
          data-fiddy="seed-backup-thanks"
          aria-live="polite"
        >
          <p className="text-sm text-default">
            Saved. Your account is written down, and Fiddy will not ask again.
          </p>
          <button
            type="button"
            className="fiddy-quiet-btn"
            data-fiddy="seed-backup-close"
            onClick={() => setStep('hidden')}
          >
            Close
          </button>
        </section>
      );
    }

    return (
      <section
        className="fiddy-notice"
        data-fiddy="seed-backup"
        data-state={step}
        aria-labelledby="seed-backup-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            className="text-base font-semibold text-default"
            id="seed-backup-title"
          >
            Back up your account
          </h2>
          <button
            type="button"
            className="fiddy-quiet-btn"
            data-fiddy="seed-backup-dismiss"
            aria-label="Not now"
            onClick={() => void defer()}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>

        {step === 'ask' ? (
          <div className="mt-2 space-y-3 text-sm text-default">
            <p>
              {heldForThem
                ? providerName
                  ? `You signed up with ${providerName}, so the words behind this account are being looked after for you. There is nothing you have to write down today.`
                  : 'This device is not holding the words that own this account, so there is nothing to write down here.'
                : 'This account lives in this browser. If you clear the browser or lose this device, the words below are the only way back in.'}
            </p>
            <p className="text-muted">
              Nobody can give them to you again and nobody else can reset them —
              not Fiddy. Taking your own copy now means one bad day is not the
              end of the account.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="fiddy-primary-btn"
                data-fiddy="seed-backup-open"
                onClick={() => setStep('reveal')}
              >
                Show me my backup words
              </button>
              <button
                type="button"
                className="fiddy-quiet-btn"
                data-fiddy="seed-backup-not-now"
                onClick={() => void defer()}
              >
                Not now
              </button>
            </div>
          </div>
        ) : null}

        {step === 'reveal' ? (
          <div className="mt-2 space-y-3 text-sm text-default">
            <p>
              Anyone who reads these words owns this account. Write them down
              somewhere private — on paper, somewhere you would keep a passport.
            </p>

            <div
              className="relative rounded border p-3 border-default"
              data-fiddy="seed-backup-words"
              data-hidden={revealed ? 'false' : 'true'}
              style={revealed ? undefined : { filter: 'blur(6px)' }}
            >
              {account.phrase ? (
                <ol
                  className="font-mono grid grid-cols-3 gap-2 text-xs text-default"
                  aria-hidden={revealed ? undefined : true}
                >
                  {account.phrase.split(/\s+/).map((word, index) => (
                    <li key={`${word}-${index}`}>
                      <span className="text-muted">{index + 1}.</span> {word}
                    </li>
                  ))}
                </ol>
              ) : (
                <div
                  className="space-y-2"
                  aria-hidden={revealed ? undefined : true}
                >
                  <p className="text-xs text-muted">
                    {providerName
                      ? `Your words are held in the ${providerName} sign-up. This is the wallet that owns the account:`
                      : 'This is the wallet that owns the account:'}
                  </p>
                  <p className="font-mono break-all text-xs text-default">
                    {account.custodyAddress}
                  </p>
                  {revealed ? heldWordsSlot : null}
                </div>
              )}
            </div>

            {revealed ? null : (
              <button
                type="button"
                className="fiddy-primary-btn"
                data-fiddy="seed-backup-reveal"
                onClick={() => setRevealed(true)}
              >
                Tap to show the words
              </button>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="fiddy-quiet-btn"
                data-fiddy="seed-backup-saved"
                onClick={() => void confirmSaved()}
              >
                I have written them down
              </button>
              <button
                type="button"
                className="fiddy-quiet-btn"
                data-fiddy="seed-backup-later"
                onClick={() => void defer()}
              >
                Remind me later
              </button>
            </div>
          </div>
        ) : null}
      </section>
    );
  },
);

SeedBackupNotice.displayName = 'SeedBackupNotice';

export { SeedBackupNotice };
export type { SeedBackupNoticeProps };
