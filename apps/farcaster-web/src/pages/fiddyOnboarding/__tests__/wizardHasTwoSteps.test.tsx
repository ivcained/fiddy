// @vitest-environment jsdom

/**
 * The way in, measured as a walk rather than as prose: two numbered steps, and
 * the apps screen is not one of them.
 *
 * WHY THIS FILE EXISTS
 * The flow used to be four numbered steps (`name` → `brain` → `apps` → `ready`)
 * and the third one asked an unauthenticated visitor to allow six apps, five of
 * them dead "soon" switches, before they had seen the app or said one word to
 * their agent. The two assertions that matter are therefore:
 *
 *   1. naming and picking a brain are ONE screen (step 1), and the step can be
 *      finished with a single press — Fiddy's own brain is already picked;
 *   2. nothing on the way in renders the apps sheet, and `/welcome/apps` is not
 *      a dead address — it lands on the last step of the flow that does exist.
 *
 * The apps sheet itself is not deleted: it is what `/~/agent/apps` renders for
 * a signed-in owner (`deviceOnlySession.test.tsx` holds that door open) and what
 * `AppsSheet.test.tsx` still measures row by row.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAIN_CARDS } from '~/components/fiddy/BrainSheet';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { loadFiddySetup, resetFiddySetup } from '~/lib/fiddySetup';

const state = vi.hoisted(() => ({ signedIn: false }));

vi.mock('~/hooks/data/useIsSignedIn', () => ({
  useIsSignedIn: () => state.signedIn,
}));

// There is no agent service to talk to in a test, and this screen does not ask
// it anything until a card is opened.
vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: 'unpaired',
    session: null,
    pair: vi.fn(),
    forget: vi.fn(),
  }),
}));

vi.mock('~/lib/agentService', () => ({
  AgentServiceError: class AgentServiceError extends Error {
    code: string;

    status: number;

    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  },
  probeBrain: vi.fn(),
  applyBrain: vi.fn(),
  listAgents: vi.fn().mockResolvedValue([]),
}));

// The page chrome and the brand plumbing are not what this file measures.
vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { FiddyOnboardingPage } =
  await import('~/pages/fiddyOnboarding/FiddyOnboardingPage');

/**
 * The wizard exactly as the router wires it: one element per step, and the two
 * addresses that lead into step 1.
 */
const renderWizard = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/welcome" element={<FiddyOnboardingPage step="hi" />} />
        <Route
          path="/welcome/name"
          element={<FiddyOnboardingPage step="setup" />}
        />
        <Route
          path="/welcome/brain"
          element={<FiddyOnboardingPage step="setup" />}
        />
        <Route
          path="/welcome/apps"
          element={<FiddyOnboardingPage step="apps" />}
        />
        <Route
          path="/welcome/ready"
          element={<FiddyOnboardingPage step="ready" />}
        />
        <Route path="/" element={<div>the client</div>} />
      </Routes>
    </MemoryRouter>,
  );

const stepCount = () =>
  document.querySelector('[data-fiddy="step-count"]')?.textContent ?? '';

describe('the way in, as a two-step walk', () => {
  beforeEach(() => {
    state.signedIn = false;
    installFakeStorage();
  });

  afterEach(() => {
    cleanup();
    resetFiddySetup();
  });

  it('does the naming and the brain on one screen, as Step 1 of 2', () => {
    renderWizard('/welcome/name');

    expect(document.querySelector('[data-fiddy-step="setup"]')).toBeTruthy();
    expect(stepCount()).toBe('Step 1 of 2');

    // Both halves of the decision, on this one screen.
    expect(screen.getByLabelText("Your agent's name")).toBeTruthy();
    expect(document.querySelector('[data-fiddy="brains"]')).toBeTruthy();
    for (const card of BRAIN_CARDS) {
      expect(
        document.querySelector(`[data-fiddy-brain="${card.id}"]`),
      ).toBeTruthy();
    }

    // And the built-in brain is already picked, which is what makes the step
    // finishable in one press.
    const builtIn = document.querySelector('[data-fiddy-brain="fiddy"]');
    expect(builtIn?.getAttribute('data-state')).toBe('selected');
    expect(loadFiddySetup().brain).toBe('fiddy');
  });

  it('is finished in one press: Continue lands on Step 2 of 2, and it is last', () => {
    renderWizard('/welcome/name');

    fireEvent.change(screen.getByLabelText("Your agent's name"), {
      target: { value: 'Pip' },
    });
    fireEvent.click(screen.getByText('Continue'));

    expect(stepCount()).toBe('Step 2 of 2');
    expect(screen.getByText('Pip is ready.')).toBeTruthy();
    const saved = loadFiddySetup();
    expect(saved.agentName).toBe('Pip');
    expect(saved.brain).toBe('fiddy');
    expect(saved.completedAt).not.toBeNull();
  });

  it('keeps the default name when it is left alone', () => {
    renderWizard('/welcome/name');

    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByText('Fiddy is ready.')).toBeTruthy();
  });

  it('never renders the apps sheet on the way in', () => {
    for (const entry of [
      '/welcome',
      '/welcome/name',
      '/welcome/brain',
      '/welcome/ready',
    ]) {
      const { unmount } = renderWizard(entry);
      expect(document.querySelector('[data-fiddy="apps"]')).toBeNull();
      unmount();
    }
  });

  it('turns /welcome/apps into the last step instead of a dead screen', () => {
    renderWizard('/welcome/apps');

    expect(stepCount()).toBe('Step 2 of 2');
    expect(screen.getByText(/is ready\./)).toBeTruthy();
    expect(document.querySelector('[data-fiddy="apps"]')).toBeNull();
  });

  it('lands an older /welcome/brain link on step 1, not on a removed screen', () => {
    renderWizard('/welcome/brain');

    expect(stepCount()).toBe('Step 1 of 2');
    expect(document.querySelector('[data-fiddy="brains"]')).toBeTruthy();
    expect(screen.getByLabelText("Your agent's name")).toBeTruthy();
  });

  it('still opens the front door for someone who is not signed in', () => {
    renderWizard('/welcome');

    expect(screen.getByText(/Meet Fiddy/)).toBeTruthy();
    expect(stepCount()).toBe('');
  });
});
