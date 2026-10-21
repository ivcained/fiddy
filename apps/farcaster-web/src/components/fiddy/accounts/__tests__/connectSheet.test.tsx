// @vitest-environment jsdom
/**
 * The connect sheet as a person meets it: one button, one approval, one honest
 * sentence per outcome.
 *
 * The service is mocked, so what is asserted here is the *screen*: that the
 * approval link is handed over, that the screen notices the approval by itself,
 * that a failure replaces the button with words rather than leaving it dead —
 * and that none of these screens use a word this product bans from its own copy.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectStatus = vi.fn();
const startConnect = vi.fn();
const stopConnect = vi.fn();
const rememberConnectStatus = vi.fn();

// jsdom has no canvas, and the QR is drawn on one: the code itself is a
// library's business (it is the same component the sign-in modal already uses),
// what these tests are about is the screen around it.
vi.mock('react-qrcode-logo', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('~/snapchain/accounts/managedConnect', () => ({
  connectStatus: (...args: unknown[]) => connectStatus(...args),
  startConnect: (...args: unknown[]) => startConnect(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
}));

import { ConnectSheet } from '~/components/fiddy/accounts/ConnectSheet';

const APPROVAL = 'https://warcast.example/~/add-signer?request=abc';

beforeEach(() => {
  connectStatus.mockReset();
  startConnect.mockReset();
  stopConnect.mockReset();
  connectStatus.mockResolvedValue({
    state: 'none',
    approvalUrl: null,
    fid: null,
    username: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ConnectSheet', () => {
  it('opens on one sentence and one button, and says what it is asking for', async () => {
    render(<ConnectSheet />);
    await screen.findByText('Connect your Farcaster account');
    expect(
      screen.getByText(/without a fee and without a passphrase/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    // The honest limit is on the first screen, not buried behind Advanced.
    expect(screen.getByText(/stay where they are/i)).toBeTruthy();
  });

  it('hands over the approval link when the person presses Connect', async () => {
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('One tap in Farcaster to finish');
    const link = document.querySelector(
      '[data-fiddy="connect-approval-link"]',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(APPROVAL);
    expect(document.querySelector('[data-fiddy="connect-qr"]')).toBeTruthy();
  });

  it('notices the approval by itself, and says what is now true', async () => {
    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    connectStatus
      .mockResolvedValueOnce({
        state: 'none',
        approvalUrl: null,
        fid: null,
        username: null,
      })
      .mockResolvedValue({
        state: 'connected',
        approvalUrl: null,
        fid: 4242,
        username: 'someone',
      });

    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('One tap in Farcaster to finish');

    // No second press: the waiting screen asks on its own.
    await screen.findByText('Connected as @someone', undefined, {
      timeout: 6000,
    });
    expect(
      screen.getByText(/Fiddy can post for you — turn it off anytime/i),
    ).toBeTruthy();
  }, 10_000);

  it('never leaves a dead button: a refusal becomes a sentence and a way forward', async () => {
    startConnect.mockRejectedValue(
      Object.assign(
        new Error('connecting an account is not switched on here yet.'),
        { code: 'CONNECT_NOT_SET_UP' },
      ),
    );
    render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByText('That did not go through');
    expect(
      screen.getByText('connecting an account is not switched on here yet.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText(/Nothing changed in your account/i)).toBeTruthy();
  });

  it('shows the way back when the person turns the key off, and calls the service', async () => {
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
    });
    stopConnect.mockResolvedValue({
      state: 'revoked',
      approvalUrl: null,
      fid: null,
      username: null,
    });

    render(<ConnectSheet />);
    await screen.findByText('Connected as @someone');
    fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));

    await screen.findByText("Fiddy's access is off");
    expect(stopConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
  });

  it('keeps the banned words out of every screen it shows', async () => {
    // The product's jargon ban, as a test: these words belong in the design
    // notes and the code, never on a screen.
    const banned = [
      /signer/i,
      /\bscope/i,
      /\bTTL\b/,
      /gasless/i,
      /\bAPI key\b/i,
      /\bnonce\b/i,
      /\bnode\b/i,
    ];

    startConnect.mockResolvedValue({
      status: {
        state: 'waiting',
        approvalUrl: APPROVAL,
        fid: null,
        username: null,
      },
      reused: false,
    });
    const { container } = render(<ConnectSheet />);
    await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('One tap in Farcaster to finish');

    const copy = container.textContent ?? '';
    for (const word of banned) {
      expect(copy).not.toMatch(word);
    }
  });
});
