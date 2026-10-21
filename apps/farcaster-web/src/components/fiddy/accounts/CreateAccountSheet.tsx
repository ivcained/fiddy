/**
 * Making an account, on this device, in plain words.
 *
 * The flow is the onboarding's own voice: one idea per screen, no infrastructure
 * words, and nothing that sounds like a promise the client cannot keep. What it
 * does NOT do is soften the two things a person genuinely has to decide:
 *
 *   1. the words are theirs and only theirs — they are shown once, they are
 *      written down by the person, and Fiddy cannot recover them; and
 *   2. it costs a small fee in ETH, paid from the account they are making.
 *
 * Every quantity on these screens is read, never typed in by us: the network
 * price comes from the contract, the balance comes from the account, and the
 * progress list is driven by what has actually finished. A step that failed says
 * which step and why, in the same voice as the rest.
 *
 * The recovery phrase is generated in this component and lives only in memory
 * until the account is saved on the device. It is never rendered into a URL,
 * never logged, and never sent anywhere.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';
import { useAuth } from '~/contexts/AuthProvider';
import { postSignInLocation } from '~/lib/postSignInLanding';
import {
  createAccountOnChain,
  type FundingState,
  readFundingState,
} from '~/snapchain/accounts/createAccount';
import {
  accountIdFor,
  type LocalAccount,
  saveLocalAccount,
} from '~/snapchain/accounts/localAccounts';
import { createNodeAccountOps } from '~/snapchain/accounts/nodeAccountOps';
import {
  DEFAULT_OPTIMISM_RPC_URL,
  ID_GATEWAY_ADDRESS,
} from '~/snapchain/accounts/optimism';
import {
  custodyAccountFromPhrase,
  generateDeviceSigningKey,
  generateRecoveryPhrase,
} from '~/snapchain/accounts/phrase';
import { signInAsLocalAccount } from '~/snapchain/accounts/session';
import {
  checkNameAvailability,
  type NameAvailability,
} from '~/snapchain/accounts/username';
import { useNodeClient } from '~/snapchain/useNodeClient';

/** How often the balance is re-read while somebody is sending funds. */
const FUNDING_POLL_MS = 5_000;

/** How long we wait after a keystroke before asking about a name. */
const NAME_CHECK_DEBOUNCE_MS = 400;

/** The shortest a display name may be; an empty one just uses the handle. */
const displayNameFor = (display: string, username: string): string =>
  display.trim() || username;

const eth = (wei: bigint): string => {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/, '')
    .slice(0, 6);

  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
};

type Step = 'name' | 'phrase' | 'fund' | 'working' | 'done';

const PROGRESS_ROWS = [
  { key: 'registering', label: 'Your account is being made on the network' },
  { key: 'signer', label: 'This device is allowed to post for you' },
  { key: 'name', label: 'Your @name is being claimed' },
  { key: 'profile', label: 'Your profile is being filled in' },
] as const;

export interface CreateAccountSheetProps {
  onClose: () => void;
  /** Called once the account exists on this device, before sign-in. */
  onCreated?: (account: LocalAccount) => void;
}

export const CreateAccountSheet = memo<CreateAccountSheetProps>(
  ({ onClose, onCreated }) => {
    const node = useNodeClient();
    const { signIn } = useAuth();

    const [step, setStep] = useState<Step>('name');
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [availability, setAvailability] = useState<
      NameAvailability | 'checking'
    >('invalid');
    const [phrase] = useState(() => generateRecoveryPhrase());
    const [saved, setSaved] = useState(false);
    const [funding, setFunding] = useState<FundingState | undefined>();
    const [progressIndex, setProgressIndex] = useState(-1);
    const [error, setError] = useState<string | undefined>();
    const [created, setCreated] = useState<LocalAccount | undefined>();

    const custody = useMemo(() => custodyAccountFromPhrase(phrase), [phrase]);
    const rpcUrl = DEFAULT_OPTIMISM_RPC_URL;
    const createAccountRef = useRef(createAccountOnChain);
    createAccountRef.current = createAccountOnChain;

    // Ask the name registry, but not on every keystroke.
    useEffect(() => {
      if (step !== 'name') {
        return undefined;
      }

      let live = true;
      setAvailability('checking');
      const timer = setTimeout(async () => {
        const answer = await checkNameAvailability({ name: username });

        if (live) {
          setAvailability(answer);
        }
      }, NAME_CHECK_DEBOUNCE_MS);

      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [username, step]);

    // While the funding screen is up, read the account back every few seconds.
    // Nothing here writes: the screen is honest about what has arrived.
    useEffect(() => {
      if (step !== 'fund') {
        return undefined;
      }

      let live = true;

      const read = async () => {
        const state = await readFundingState({
          rpcUrl,
          address: custody.address,
        });

        if (live) {
          setFunding(state);
        }
      };

      void read();
      const timer = setInterval(() => void read(), FUNDING_POLL_MS);

      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [step, custody.address, rpcUrl]);

    const start = useCallback(async () => {
      setStep('working');
      setError(undefined);
      setProgressIndex(0);

      if (!node) {
        setError(
          'Fiddy needs a server to read Farcaster from, and none is set up yet - open Advanced and pick one, then try again',
        );
        return;
      }

      try {
        const signingKeyHex = await generateDeviceSigningKey();
        const ops = createNodeAccountOps({
          node,
          onStep: (issueStep) => setProgressIndex(issueStep === 'done' ? 2 : 1),
        });

        const { result } = await createAccountRef.current({
          rpcUrl,
          custody,
          node: ops,
          signingKeyHex,
          username,
          displayName: displayNameFor(displayName, username),
        });

        const account: LocalAccount = {
          id: accountIdFor(custody.address),
          custodyAddress: custody.address,
          phrase,
          fid: result.fid,
          username,
          displayName: displayNameFor(displayName, username),
          createdAt: Date.now(),
          signedInAt: Date.now(),
        };

        await saveLocalAccount(account);
        onCreated?.(account);
        setCreated(account);
        setProgressIndex(PROGRESS_ROWS.length);
        setError(result.warning);
        setStep('done');
      } catch (thrown) {
        setError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : 'that did not finish - nothing was lost, and you can try the last step again',
        );
      }
    }, [node, rpcUrl, custody, username, displayName, phrase, onCreated]);

    // Registration starts by itself as soon as the fee has arrived: the person
    // who just sent the money should not have to also press the button.
    useEffect(() => {
      if (step !== 'fund' || !funding || funding.kind !== 'ready') {
        return;
      }

      if (funding.fid > 0) {
        void start();
        return;
      }

      if (funding.enough) {
        void start();
      }
    }, [step, funding, start]);

    const openFiddy = useCallback(async () => {
      if (!created) {
        return;
      }

      try {
        await signInAsLocalAccount({ account: created, signIn });
      } catch (thrown) {
        setError(
          thrown instanceof Error && thrown.message
            ? thrown.message
            : "we couldn't sign you in - try opening Fiddy again",
        );
        return;
      }

      window.location.replace(
        postSignInLocation({
          pathname: window.location.pathname,
          href: window.location.href,
        }),
      );
    }, [created, signIn]);

    const copy = (value: string) => {
      void navigator.clipboard?.writeText(value);
    };

    const availabilityLine = () => {
      if (username.length === 0) {
        return 'Lowercase letters, numbers and dashes. This is the name people will type to find you.';
      }

      switch (availability) {
        case 'checking':
          return 'Checking…';
        case 'free':
          return `@${username} is free.`;
        case 'taken':
          return `@${username} is already taken - try another.`;
        case 'invalid':
          return 'Use lowercase letters, numbers and dashes, starting with a letter or number.';
        default:
          return "We couldn't reach the name list just now - you can carry on and claim it later.";
      }
    };

    const renderStep = () => {
      if (step === 'name') {
        return (
          <FiddySheet
            name="create-name"
            egg="small"
            title="Pick your name"
            sub="This is the @name people will see. You can change it later."
            primary={{
              label: 'Continue',
              onClick: () => setStep('phrase'),
              disabled: availability !== 'free',
            }}
            quiet={{ label: 'Back', onClick: onClose }}
            note="Nothing is bought or posted on this screen."
          >
            <label className="fiddy-field">
              <span className="fiddy-field-label">Your @name</span>
              <input
                className="fiddy-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                placeholder="yourname"
                value={username}
                onChange={(event) =>
                  setUsername(
                    event.target.value.toLowerCase().replace(/[^0-9a-z-]/g, ''),
                  )
                }
              />
              <small data-fiddy="name-availability">{availabilityLine()}</small>
            </label>

            <label className="fiddy-field">
              <span className="fiddy-field-label">Your display name</span>
              <input
                className="fiddy-input"
                type="text"
                autoComplete="off"
                maxLength={32}
                placeholder="Your Name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          </FiddySheet>
        );
      }

      if (step === 'phrase') {
        return (
          <FiddySheet
            name="create-phrase"
            egg="small"
            title="Write these twelve words down"
            sub="They are the only way back into this account. Fiddy never keeps a copy, and neither does anyone else."
            primary={{
              label: 'I saved them - continue',
              onClick: () => setStep('fund'),
              disabled: !saved,
            }}
            quiet={{ label: 'Back', onClick: () => setStep('name') }}
            note="Anyone who has these words owns the account. Keep them somewhere private."
          >
            <code className="fiddy-phrase" data-fiddy="recovery-phrase">
              {phrase}
            </code>
            <button
              type="button"
              className="fiddy-quiet-btn"
              onClick={() => copy(phrase)}
            >
              Copy the words
            </button>
            <label className="fiddy-check">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have written them down somewhere safe
            </label>
          </FiddySheet>
        );
      }

      if (step === 'fund') {
        const ready = funding?.kind === 'ready' ? funding : undefined;

        return (
          <FiddySheet
            name="create-fund"
            egg="small"
            title={`Fund @${username}`}
            sub="Making the account costs a small fee in ETH, paid on the network it lives on. Send it from any wallet or exchange that supports Optimism."
            primary={{
              label: ready?.enough ? 'Start now' : 'Waiting for the ETH…',
              onClick: () => void start(),
              disabled: !ready?.enough,
            }}
            quiet={{ label: 'Back', onClick: () => setStep('phrase') }}
            note="Fiddy never holds your money: the fee goes straight from you to the network."
          >
            <div className="fiddy-kv">
              <span>Amount</span>
              <b>{ready ? `${eth(ready.needed)} ETH` : '…'}</b>
              {ready ? (
                <button
                  type="button"
                  className="fiddy-quiet-btn"
                  onClick={() => copy(eth(ready.needed))}
                >
                  Copy
                </button>
              ) : null}
            </div>
            <div className="fiddy-kv">
              <span>Send to</span>
              <code data-fiddy="custody-address">{custody.address}</code>
              <button
                type="button"
                className="fiddy-quiet-btn"
                onClick={() => copy(custody.address)}
              >
                Copy
              </button>
            </div>
            <a
              className="fiddy-quiet-btn"
              href={`ethereum:${custody.address}@10?value=${
                ready ? ready.needed : 0n
              }`}
            >
              Open in a wallet app
            </a>
            <p className="fiddy-waiting" data-fiddy="funding-state">
              {funding === undefined
                ? 'Checking the account…'
                : funding.kind === 'wrong-chain'
                  ? `That endpoint is on a different network (${funding.chainId}) - open Advanced and pick one for Optimism.`
                  : funding.kind === 'unavailable'
                    ? funding.reason
                    : `In the account: ${eth(funding.balance)} ETH. ${
                        funding.enough
                          ? 'That is enough - starting.'
                          : 'Waiting for funds…'
                      }`}
            </p>
            {ready ? (
              <p className="fiddy-sheet-note">
                The fee today is {eth(ready.price)} ETH, read from the network a
                moment ago.
              </p>
            ) : null}
          </FiddySheet>
        );
      }

      if (step === 'working') {
        return (
          <FiddySheet
            name="create-working"
            egg="small"
            title={`Setting up @${username}`}
            sub="This usually takes under a minute. Keep this tab open, or come back later and Fiddy picks up where it stopped."
            note="Nothing is posted yet."
          >
            <ol className="fiddy-steps" data-fiddy="create-progress">
              {PROGRESS_ROWS.map((row, index) => (
                <li
                  key={row.key}
                  className={
                    index < progressIndex
                      ? 'done'
                      : index === progressIndex
                        ? 'now'
                        : ''
                  }
                >
                  {row.label}
                </li>
              ))}
            </ol>
            {error ? <p className="fiddy-error">{error}</p> : null}
            {error ? (
              <button
                type="button"
                className="fiddy-primary-btn"
                onClick={() => void start()}
              >
                Try the last step again
              </button>
            ) : null}
          </FiddySheet>
        );
      }

      return (
        <FiddySheet
          name="create-done"
          egg="small"
          title={`You're in as @${created?.username ?? username}`}
          sub="Your account exists and this device can post for you. Now go and say hello."
          primary={{ label: 'Open Fiddy', onClick: () => void openFiddy() }}
          quiet={{ label: 'Later', onClick: onClose }}
          note="Posting to the network is the next step - Fiddy always asks first."
        >
          {error ? <p className="fiddy-error">{error}</p> : null}
          <p className="fiddy-sheet-note">
            Your words are saved on this device only. If you lose them, this
            account cannot be recovered by Fiddy.
          </p>
        </FiddySheet>
      );
    };

    return (
      <Modal>
        <DefaultModalContainer onClose={() => onClose()}>
          <div className="flex size-full flex-col items-center justify-center p-4">
            <div
              className="relative flex w-full max-w-md flex-col items-start justify-center rounded-[12px] p-4"
              data-fiddy="create-account"
              onClick={(event) => event.stopPropagation()}
            >
              {renderStep()}
            </div>
          </div>
        </DefaultModalContainer>
      </Modal>
    );
  },
);

CreateAccountSheet.displayName = 'CreateAccountSheet';

/** The registrar the sheet signs against, exported for the doc and for tests. */
export { ID_GATEWAY_ADDRESS };
