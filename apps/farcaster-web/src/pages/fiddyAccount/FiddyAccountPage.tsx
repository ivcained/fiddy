/**
 * Where a social sign-up lands: the account it just made, in plain words.
 *
 * WHY THIS SCREEN EXISTS AT ALL. A Google or X sign-up makes a real account on
 * this device — a wallet nobody had to think about — but it does not make a
 * Farcaster account, and posting is Farcaster's job. So instead of dropping the
 * person on a screen that complains, this one does three things in order: says
 * who they are now, asks them to back it up (offered, never forced —
 * `~/components/fiddy/seedBackup`), and names the one thing still missing with
 * the two honest ways to get it (already have a Farcaster account: sign in with
 * it; do not: make one here, on this device).
 *
 * WHAT IT REFUSES TO PRETEND. Nothing here says the account can post, and nothing
 * claims the wallet is connected to a Farcaster account — because none of that is
 * true yet. The account is held, selectable, and listed in the switcher the rest
 * of the client already uses; the moment a Farcaster account is attached, the
 * ordinary signed-in flow takes over.
 *
 * WHAT IT DOES NOT DO YET, SAID OUT LOUD. Making a Farcaster account *owned by
 * this wallet* means the chain's registration has to be signed by the held
 * wallet, which lives inside the sign-up provider rather than in this browser's
 * own key store. That wiring is its own piece of work (a separate card), so the
 * two routes offered here are the two that genuinely work today.
 *
 * THE THIRD SHAPE: AN ACCOUNT THAT IS ALREADY A FARCASTER ACCOUNT. A person who
 * signs in with Farcaster from here is not on a screen that needs to say "no
 * Farcaster account yet" — they arrived WITH one. So when the account this
 * screen is showing is such a sign-in (`~/lib/farcasterAccount`), it says where
 * the account came from and that this device holds no key for it, and it offers
 * no backup step: there are no words here, and never were. The one thing it must
 * not do is ask such an account to back anything up, or lose the ask that
 * belongs to the social account still held beside it — see
 * `~/components/fiddy/seedBackup`.
 */

import { KeyRound, MessageCircle, ShieldCheck } from 'lucide-react';
import React, { FC, lazy, memo, Suspense, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { SeedBackupNotice } from '~/components/fiddy/seedBackup/SeedBackupNotice';
import { Link } from '~/components/links/Link';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { defaultRoute, routes } from '~/constants/routes';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { isFarcasterSession } from '~/lib/farcasterAccount';
import { SOCIAL_PROVIDERS } from '~/lib/socialSignUp';
import { useLocalAccounts } from '~/snapchain/accounts/session';

/** Privy's own window for words it holds. Loaded only when it is configured. */
const HeldWordsButton = lazy(() =>
  import('~/components/login/SocialSignUpPrivy').then((module) => ({
    default: module.HeldWordsButton,
  })),
);

const FiddyAccountPage: FC = memo(() => {
  const { accounts, current, loading } = useLocalAccounts();
  const [signingIn, setSigningIn] = useState(false);
  const [creating, setCreating] = useState(false);
  const isSignedIn = useIsSignedIn();

  const provider =
    SOCIAL_PROVIDERS.find((candidate) => candidate.id === current?.provider) ??
    undefined;

  // A signed-in session does not belong on this screen either.
  //
  // This is the screen a social sign-up lands on, and its whole subject is the
  // one thing still missing: "No Farcaster account yet", with the two honest
  // ways to get one. MEASURED 2026-10-22, a real Chrome at 390px: signing in
  // with Farcaster from the primary above completes the handshake, saves the
  // proof and reloads this very URL (`postSignInLocation` keeps a deep link in
  // place, and this screen is not one of the setup paths it leaves) — and the
  // person who just attached a Farcaster account was shown a screen telling them
  // they have none, with no way into the client. So a session that arrives here,
  // by that reload or by any other route, goes on to the client — where the
  // switcher lists both accounts, which is the state this screen was pointing at.
  if (isSignedIn) {
    return <Navigate to={defaultRoute.path} replace />;
  }

  if (loading) {
    return (
      <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
        <div data-fiddy="fiddy-account" data-state="loading" />
      </Page>
    );
  }

  if (!current) {
    return (
      <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
        <div data-fiddy="fiddy-account" data-state="none">
          <FiddySheet
            name="account"
            egg="small"
            title="This browser is not holding an account of its own yet."
            sub="Nothing is broken. An account made here lives on this device, and this one has none."
            primary={{
              label: 'Start again',
              onClick: () => {
                window.location.assign(routes.fiddyWelcome.path);
              },
            }}
          >
            <p className="fiddy-sheet-note">
              Signing up with Google or X makes one in one press, and so does
              making one with Farcaster.
            </p>
          </FiddySheet>
        </div>
      </Page>
    );
  }

  const identityLabel =
    current.email ??
    (current.username ? `@${current.username}` : undefined) ??
    (current.fid !== undefined ? `fid ${current.fid}` : undefined);

  // A Farcaster sign-in on this screen: the person already IS the account, so
  // the two things this screen exists to say ("this is the account this device
  // holds" / "here is the Farcaster account it has not got yet") are both wrong
  // for it. What it says instead is where the account came from, that this
  // device holds no key for it, and the way on.
  const session = isFarcasterSession(current);

  return (
    <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
      <div data-fiddy="fiddy-account" data-state="ready">
        <FiddySheet
          name="account"
          egg="small"
          title={identityLabel ?? 'Your account is here.'}
          sub={
            session
              ? 'You signed in with your own Farcaster app. The key that owns this account stays there, so there is nothing on this device to write down.'
              : provider
                ? `You signed up with ${provider.name}. That makes a real account on this device — a key pair held for you, with nothing to write down.`
                : 'This account lives on this device, and the words that own it were written down when it was made.'
          }
          primary={
            session
              ? {
                  label: 'Open Fiddy',
                  onClick: () => {
                    window.location.assign(defaultRoute.path);
                  },
                }
              : {
                  label: 'I already have a Farcaster account — sign in with it',
                  onClick: () => setSigningIn(true),
                }
          }
          quiet={
            session
              ? {
                  label: 'Make an account on this device instead',
                  onClick: () => setCreating(true),
                }
              : {
                  label: 'Make a Farcaster account here instead',
                  onClick: () => setCreating(true),
                }
          }
          note={
            session
              ? 'Your Farcaster account stays yours: this device holds no posting key for it yet, and Fiddy asks before it posts anything.'
              : 'Fiddy posts through Farcaster, so that is the one step left. Either way the account you just made stays on this device and shows up in your account list.'
          }
        >
          <ul className="fiddy-summary">
            <li>
              <KeyRound aria-hidden="true" />
              <span>
                <b>{identityLabel ?? 'Held for you'}</b>
                <small>
                  {session
                    ? 'signed in with your own Farcaster app'
                    : provider
                      ? `your ${provider.name} sign-up`
                      : 'the account this device made'}
                </small>
              </span>
            </li>
            <li>
              <MessageCircle aria-hidden="true" />
              <span>
                <b>
                  {session
                    ? `Farcaster account ${identityLabel ?? `fid ${current.fid}`}`
                    : 'No Farcaster account yet'}
                </b>
                <small>
                  {session
                    ? 'posting happens from your own Farcaster app until a key is granted to this device'
                    : 'posting, the feed and messages need one — that is the step above'}
                </small>
              </span>
            </li>
            <li>
              <ShieldCheck aria-hidden="true" />
              <span>
                <b>
                  {accounts.length > 1
                    ? `${accounts.length} accounts on this device`
                    : 'One account on this device'}
                </b>
                <small>
                  switch between them from the shell once you are in
                </small>
              </span>
            </li>
          </ul>

          {session ? (
            // Nothing to back up, and nothing to offer: this device never held
            // the words that own this account, and the account's own key is in
            // the person's Farcaster app. An ask here would be a nag with
            // nothing behind it — so the screen says what is true and leaves the
            // social account's own ask (stored under its own id, `~/lib/seedBackup`)
            // exactly as it was for the account it is about.
            <p
              className="fiddy-sheet-note"
              data-fiddy="account-nothing-to-back-up"
            >
              Nothing to write down here: this device never held the words that
              own this Farcaster account.
            </p>
          ) : current.walletCustody === 'privy' ? (
            <SeedBackupNotice
              account={current}
              heldWordsSlot={
                <Suspense fallback={null}>
                  <HeldWordsButton address={current.custodyAddress} />
                </Suspense>
              }
            />
          ) : (
            <SeedBackupNotice account={current} />
          )}

          <p className="fiddy-sheet-note">
            {current.provider
              ? 'Your account list shows this one by the name you signed up with.'
              : ''}
          </p>
        </FiddySheet>

        <footer className="fiddy-legal">
          <Link
            to="privacyPolicy"
            params={{}}
            searchParams={{}}
            title="Privacy Policy"
          >
            Privacy
          </Link>
          <Link
            to="termsOfUse"
            params={{}}
            searchParams={{}}
            title="Terms of Use"
          >
            Terms
          </Link>
        </footer>
      </div>

      {signingIn ? <LoginModal onClose={() => setSigningIn(false)} /> : null}

      {creating ? (
        <CreateAccountSheet onClose={() => setCreating(false)} />
      ) : null}
    </Page>
  );
});

FiddyAccountPage.displayName = 'FiddyAccountPage';

export { FiddyAccountPage };
