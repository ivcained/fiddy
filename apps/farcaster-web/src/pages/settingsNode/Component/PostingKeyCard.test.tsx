// @vitest-environment jsdom
/**
 * The card that is now the primary way to let Fiddy post for you.
 *
 * The screen it replaced is the point: this card's one button used to be "Issue
 * app key", which opened a blocking recovery-phrase prompt
 * (`SeedPhraseWarningModal`). Now the phone approval is the flow a reader meets
 * here — the same sheet `/connect-farcaster` shows — and the phrase prompt lives
 * behind a collapsed disclosure on the page (`SettingsNodePage`).
 *
 * The service is mocked; what is asserted is what the card says and does with
 * its answers, including the ones it does not recognise.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectStatus = vi.fn();
const rememberConnectStatus = vi.fn();
const stopConnect = vi.fn();

vi.mock('react-qrcode-logo', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('~/snapchain/accounts/managedConnect', () => ({
  connectStatus: (...args: unknown[]) => connectStatus(...args),
  rememberConnectStatus: (...args: unknown[]) => rememberConnectStatus(...args),
  stopConnect: (...args: unknown[]) => stopConnect(...args),
}));

import { PostingKeyCard } from './PostingKeyCard';

const NONE = {
  state: 'none' as const,
  approvalUrl: null,
  fid: null,
  username: null,
};

beforeEach(() => {
  connectStatus.mockReset();
  stopConnect.mockReset();
  connectStatus.mockResolvedValue(NONE);
});

afterEach(() => {
  cleanup();
});

describe('the posting key card', () => {
  it('offers the phone approval, and says what it costs (nothing)', async () => {
    render(<PostingKeyCard fid={3} />);

    expect(await screen.findByText(/no fee, no passphrase/i)).toBeTruthy();
    const approve = await screen.findByRole('button', {
      name: 'Approve on my phone',
    });
    // Nothing on this card asks for a phrase: no field to type one into, and no
    // blocking warning in front of it. (The card *says* the phrase stays where
    // it is — that is the promise, not a prompt.)
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/Security warning/i)).toBeNull();
    expect(approve).toBeTruthy();
  });

  it('opens the approval sheet, asking, when the person presses the button', async () => {
    render(<PostingKeyCard fid={3} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve on my phone' }),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="posting-key-sheet"]'),
      ).not.toBeNull(),
    );
  });

  it('says what is true when an account is connected, and can turn it off', async () => {
    connectStatus.mockResolvedValue({
      state: 'connected',
      approvalUrl: null,
      fid: 3,
      username: 'dwr',
    });
    stopConnect.mockResolvedValue({
      state: 'revoked',
      approvalUrl: null,
      fid: 3,
      username: 'dwr',
    });
    render(<PostingKeyCard fid={3} />);

    expect(await screen.findByText(/connected as @dwr/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Turn it off' }));

    await waitFor(() => expect(stopConnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Fiddy’s access is off/i)).toBeTruthy();
  });

  it('says so in one sentence when the service cannot be reached', async () => {
    connectStatus.mockRejectedValue(new Error('nothing was connected.'));
    render(<PostingKeyCard fid={3} />);

    const state = await screen.findByText(/nothing was connected/i);
    expect(state.getAttribute('data-fiddy')).toBe('posting-key-state');
    expect(
      screen.getByText(/post in your Farcaster app as usual/i),
    ).toBeTruthy();
  });

  it('asks the reader to sign in rather than offering a button that cannot work', async () => {
    render(<PostingKeyCard />);
    const button = await screen.findByRole('button', { name: 'Sign in first' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
