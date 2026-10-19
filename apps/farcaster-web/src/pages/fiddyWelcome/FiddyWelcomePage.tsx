/**
 * The Fiddy welcome — what an unauthenticated visitor sees at `/`.
 *
 * This replaces the fork's landing page ("Build. Share. Grow." over a phone
 * video of the Warpcast app) with ours: the Fiddy lockup, the tagline, and the
 * four things this client actually does differently. The sign-in action is
 * unchanged — the same Farcaster login modal the fork wires up, opened from our
 * button — so nothing about the auth flow is reimplemented here.
 *
 * Honesty rule from the design brief: the card says what is live and what is
 * not. There is no claim that hatching an agent works today.
 */

import { KeyRound, Plug, Server, Users } from 'lucide-react';
import React, { useState } from 'react';

import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { ExternalLink } from '~/components/links/ExternalLink';
import { Link } from '~/components/links/Link';
import { LoginMagicLinkModal } from '~/components/modals/LoginMagicLinkModal';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';

const VALUES = [
  {
    icon: <Server aria-hidden="true" />,
    title: 'Reads through your own node',
    detail:
      'Feed, follows and casts come from the Snapchain node you run. The pill in the corner tells you when it answered and when it did not.',
  },
  {
    icon: <Plug aria-hidden="true" />,
    title: 'Your own agent, with its own fid',
    detail:
      'Hatch an always-on agent that reads your feed and drafts replies in your voice — and never posts without your approval.',
  },
  {
    icon: <KeyRound aria-hidden="true" />,
    title: 'App keys in plain words',
    detail:
      'Scopes, created date, a TTL you can see slide, and a revoke that is not three submenus deep.',
  },
  {
    icon: <Users aria-hidden="true" />,
    title: 'A client filter that means it',
    detail:
      'Keep or hide casts by which client wrote them. Noise is a provenance problem, not a content problem.',
  },
];

export function FiddyWelcomePage() {
  useFiddyBrandGround();
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggingInWithMagicLink, setIsLoggingInWithMagicLink] =
    useState(false);

  return (
    <Page className="fiddy-welcome fiddy-surface" meta={{ title: 'Fiddy' }}>
      <div className="fiddy-welcome-inner">
        <header className="flex items-center justify-between gap-4">
          <img
            src="/brand/fiddy-logo-dark.png"
            alt="fiddy"
            className="h-8 w-auto"
            width={1600}
            height={439}
          />
          <span className="fiddy-pill-dim">v0.1 · mainnet</span>
        </header>

        <div className="fiddy-welcome-grid">
          <div className="fiddy-welcome-head">
            <p className="fiddy-welcome-tagline">
              the agentic farcaster client
            </p>
            <h1 className="fiddy-welcome-title">
              Your feed. Your node.
              <br />
              Your agent.
            </h1>
            <p className="fiddy-welcome-lede">
              Fiddy is a Farcaster client for people who run their own
              infrastructure and want an agent that works the feed with them —
              not another timeline you scroll alone.
            </p>
          </div>

          <ul className="fiddy-value-list">
            {VALUES.map((value) => (
              <li key={value.title}>
                {value.icon}
                <span>
                  {value.title}
                  <small>{value.detail}</small>
                </span>
              </li>
            ))}
          </ul>

          <div className="fiddy-signin-card">
            <h2>Sign in</h2>
            <p className="fiddy-honest-note">
              <Server aria-hidden="true" />
              <span>
                Signing in uses your Farcaster account. Once you are in, every
                read and write can go through the node in your .env — nothing
                here needs a Fiddy account.
              </span>
            </p>
            <button
              type="button"
              className="fiddy-primary-btn"
              onClick={() => setIsLoggingIn(true)}
            >
              Sign in with Farcaster
            </button>
            <button
              type="button"
              className="fiddy-secondary-btn"
              onClick={() => setIsLoggingInWithMagicLink(true)}
            >
              Or sign in with an email link
            </button>
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
              <Link
                to="developers"
                params={{}}
                searchParams={{}}
                title="Developers"
                className="fiddy-honest-note hover:underline"
              >
                Developers
              </Link>
              <Link
                to="support"
                params={{}}
                searchParams={{}}
                title="Support"
                className="fiddy-honest-note hover:underline"
              >
                Support
              </Link>
              <Link
                to="privacyPolicy"
                params={{}}
                searchParams={{}}
                title="Privacy Policy"
                className="fiddy-honest-note hover:underline"
              >
                Privacy
              </Link>
              <Link
                to="termsOfUse"
                params={{}}
                searchParams={{}}
                title="Terms of Use"
                className="fiddy-honest-note hover:underline"
              >
                Terms
              </Link>
            </div>
            <p className="fiddy-honest-note">
              <Plug aria-hidden="true" />
              <span>
                Hatching inside Fiddy is not open yet. Pairing an agent you
                already run is — from the agent surface, after you sign in.
              </span>
            </p>
            <ExternalLink
              href="https://farcaster.xyz"
              title="About Farcaster"
              className="fiddy-honest-note hover:underline"
            >
              Farcaster is the protocol underneath — you own your identity.
            </ExternalLink>
          </div>
        </div>
      </div>

      {isLoggingIn && <LoginModal onClose={() => setIsLoggingIn(false)} />}
      {isLoggingInWithMagicLink && (
        <LoginMagicLinkModal
          onClose={() => setIsLoggingInWithMagicLink(false)}
        />
      )}
    </Page>
  );
}
