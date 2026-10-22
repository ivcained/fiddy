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
    current.email ?? (current.username ? `@${current.username}` : undefined);

  return (
    <Page className="fiddy-surface" meta={{ title: 'Fiddy — your account' }}>
      <div data-fiddy="fiddy-account" data-state="ready">
        <FiddySheet
          name="account"
          egg="small"
          title={identityLabel ?? 'Your account is here.'}
          sub={
            provider
              ? `You signed up with ${provider.name}. That makes a real account on this device — a key pair held for you, with nothing to write down.`
              : 'This account lives on this device, and the words that own it were written down when it was made.'
          }
          primary={{
            label: 'I already have a Farcaster account — sign in with it',
            onClick: () => setSigningIn(true),
          }}
          quiet={{
            label: 'Make a Farcaster account here instead',
            onClick: () => setCreating(true),
          }}
          note="Fiddy posts through Farcaster, so that is the one step left. Either way the account you just made stays on this device and shows up in your account list."
        >
          <ul className="fiddy-summary">
            <li>
              <KeyRound aria-hidden="true" />
              <span>
                <b>{identityLabel ?? 'Held for you'}</b>
                <small>
                  {provider
                    ? `your ${provider.name} sign-up`
                    : 'the account this device made'}
                </small>
              </span>
            </li>
            <li>
              <MessageCircle aria-hidden="true" />
              <span>
                <b>No Farcaster account yet</b>
                <small>
                  posting, the feed and messages need one — that is the step
                  above
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

          {current.walletCustody === 'privy' ? (
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
