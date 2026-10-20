/**
 * Fiddy's front door.
 *
 * This replaces the Farcaster sign-in wall that used to be what an
 * unauthenticated visitor saw at `/`. Signing in is still required to open the
 * client — that has not changed and this page does not pretend otherwise — but
 * it is now the last step of a short, friendly setup instead of the first thing
 * anyone meets. Posting to Farcaster is the opt-in "Go social" action, not the
 * price of entry.
 *
 * One idea per screen, Muse-style: say hi, name your agent, give it a brain,
 * connect the apps you already use, then go. Every step is a real route, so a
 * step can be linked, reloaded and re-entered, and "skip for now" is honest
 * because the answers are kept in `~/lib/fiddySetup`.
 *
 * Voice: no infrastructure words on any of these screens. No node, no protocol,
 * no keys, no scopes. If a sentence needs one of those to be true, the sentence
 * is wrong.
 */

import { KeyRound, MessageCircle, Plug, ShieldCheck } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { AppsSheet, CHANNEL_ROWS } from '~/components/fiddy/AppsSheet';
import { BrainSheet, brainSummary } from '~/components/fiddy/BrainSheet';
import { FiddySheet } from '~/components/fiddy/FiddySheet';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { Link } from '~/components/links/Link';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { useNavigate } from '~/hooks/navigation/useNavigate';
import {
  allowedChannelCount,
  DEFAULT_AGENT_NAME,
  saveFiddySetup,
  useFiddySetup,
} from '~/lib/fiddySetup';

export type OnboardingStep = 'hi' | 'name' | 'brain' | 'apps' | 'ready';

/** The five route names this flow walks through. */
export type OnboardingRouteName =
  | 'fiddyWelcome'
  | 'fiddyWelcomeName'
  | 'fiddyWelcomeBrain'
  | 'fiddyWelcomeApps'
  | 'fiddyWelcomeReady';

export interface FiddyOnboardingPageProps {
  step: OnboardingStep;
}

/** One plain sentence for the brain, for summary lines. */
const stepPosition = (step: OnboardingStep): 1 | 2 | 3 | 4 | null => {
  switch (step) {
    case 'name':
      return 1;
    case 'brain':
      return 2;
    case 'apps':
      return 3;
    case 'ready':
      return 4;
    default:
      return null;
  }
};

export const FiddyOnboardingPage = ({ step }: FiddyOnboardingPageProps) => {
  useFiddyBrandGround();

  const setup = useFiddySetup();
  const navigate = useNavigate();

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [draftName, setDraftName] = useState(setup.agentName);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Every step is its own screen, so the heading takes focus and a screen
  // reader announces the new idea instead of starting over at the top.
  useEffect(() => {
    titleRef.current?.focus();
  }, [step]);

  // Reaching the last step is what "done" means: the answers are already saved
  // as they were given, and the front door can then offer to continue.
  useEffect(() => {
    if (step === 'ready' && setup.completedAt === null) {
      saveFiddySetup({ completedAt: Date.now() });
    }
  }, [step, setup.completedAt]);

  const position = stepPosition(step);
  const stepMeta = position ? { index: position, total: 4 } : null;
  const go = (to: OnboardingRouteName) =>
    navigate({ to, params: {}, searchParams: {} });

  const commitName = () => {
    const name = draftName.trim().slice(0, 24) || DEFAULT_AGENT_NAME;
    saveFiddySetup({ agentName: name });
    setDraftName(name);
    go('fiddyWelcomeBrain');
  };

  const renderStep = () => {
    switch (step) {
      case 'name':
        return (
          <FiddySheet
            name="name"
            step={stepMeta}
            egg="small"
            title="What should we call your agent?"
            sub="A name you will recognise when it answers you."
            primary={{ label: 'Continue', onClick: commitName }}
            quiet={{ label: 'Back', onClick: () => go('fiddyWelcome') }}
            note="You can rename it any time."
            titleRef={titleRef}
          >
            <label className="fiddy-field">
              <span className="fiddy-field-label">Your agent's name</span>
              <input
                className="fiddy-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                placeholder={DEFAULT_AGENT_NAME}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitName();
                  }
                }}
              />
            </label>
          </FiddySheet>
        );

      case 'brain':
        return (
          <FiddySheet
            name="brain"
            step={stepMeta}
            wide
            title="Give it a brain."
            sub={`Pick what thinks for ${setup.agentName}. You can change this whenever you like.`}
            primary={{
              label: 'Continue',
              onClick: () => go('fiddyWelcomeApps'),
            }}
            quiet={{
              label: 'Skip for now',
              onClick: () => go('fiddyWelcomeApps'),
            }}
            note="Nothing to buy here. Pick what you already have — or bring your own."
            titleRef={titleRef}
          >
            <BrainSheet />
          </FiddySheet>
        );

      case 'apps':
        return (
          <FiddySheet
            name="apps"
            step={stepMeta}
            wide
            title="Connect the apps you already use."
            sub="Turn on what you want your agent to help with. It always asks before it posts."
            primary={{
              label: 'Looks good',
              onClick: () => go('fiddyWelcomeReady'),
            }}
            quiet={{
              label: 'Skip for now',
              onClick: () => go('fiddyWelcomeReady'),
            }}
            note="You can change any of this later, from the Agent screen."
            titleRef={titleRef}
          >
            <AppsSheet />
          </FiddySheet>
        );

      case 'ready':
        return (
          <FiddySheet
            name="ready"
            step={stepMeta}
            egg="small"
            title={`${setup.agentName} is ready.`}
            sub="That is the setup done. Nothing has been posted, and nothing is switched on behind your back."
            primary={{
              label: 'Go social — sign in with Farcaster',
              onClick: () => setIsSigningIn(true),
            }}
            quiet={{
              label: 'Do this later',
              onClick: () => go('fiddyWelcome'),
            }}
            note="Fiddy opens with your Farcaster account — that is the Go social step, and it is the one part we cannot skip yet. Signing in never posts anything by itself."
            titleRef={titleRef}
          >
            <ul className="fiddy-summary">
              <li>
                <MessageCircle aria-hidden="true" />
                <span>
                  <b>{setup.agentName}</b>
                  <small>what you called it</small>
                </span>
              </li>
              <li>
                <Plug aria-hidden="true" />
                <span>
                  <b>{brainSummary(setup)}</b>
                  <small>its brain</small>
                </span>
              </li>
              <li>
                <KeyRound aria-hidden="true" />
                <span>
                  <b>
                    {allowedChannelCount(setup)} of {CHANNEL_ROWS.length} apps
                    allowed
                  </b>
                  <small>
                    {setup.channels.farcaster
                      ? 'Farcaster on, the rest marked soon'
                      : 'nothing allowed yet'}
                  </small>
                </span>
              </li>
              <li>
                <ShieldCheck aria-hidden="true" />
                <span>
                  <b>You approve every action</b>
                  <small>pause it or take it back whenever you like</small>
                </span>
              </li>
            </ul>
          </FiddySheet>
        );

      case 'hi':
      default:
        return (
          <FiddySheet
            name="hi"
            egg="hero"
            title="Meet Fiddy — your agent, living in your pocket."
            sub="Chat like you message a friend. Fiddy does the busywork, and asks before it acts."
            primary={{
              label: setup.completedAt
                ? `Continue as ${setup.agentName}`
                : 'Say hi',
              onClick: () => go('fiddyWelcomeName'),
            }}
            quiet={{
              label: 'Already on Farcaster? Go social',
              onClick: () => setIsSigningIn(true),
            }}
            note="No account needed for this part. Fiddy only asks for Farcaster when you want to post to it."
            titleRef={titleRef}
          >
            <ul className="fiddy-promise">
              <li>Your agent, your choice of brain — no lock-in.</li>
              <li>It connects to the apps you already use.</li>
              <li>You stay in control: it asks first, and you can pause it.</li>
            </ul>
          </FiddySheet>
        );
    }
  };

  return (
    <Page className="fiddy-surface" meta={{ title: 'Fiddy — meet your agent' }}>
      <div data-fiddy="onboarding">
        {renderStep()}

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
          <Link
            to="developers"
            params={{}}
            searchParams={{}}
            title="Developers"
          >
            Developers
          </Link>
        </footer>
      </div>

      {isSigningIn ? (
        <LoginModal onClose={() => setIsSigningIn(false)} />
      ) : null}
    </Page>
  );
};
