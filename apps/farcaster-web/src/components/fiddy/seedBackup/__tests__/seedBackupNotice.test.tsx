// @vitest-environment jsdom

/**
 * The backup reminder as a person meets it.
 *
 * Three claims are pinned here rather than left to the browser probe alone: the
 * words are unreadable until asked for, the confirm step is the person's and
 * ends the asking, and a notice never prints words this device does not hold —
 * a Google or X account gets its provider's own window, not an address dressed
 * up as a backup.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import { SeedBackupNotice } from '~/components/fiddy/seedBackup/SeedBackupNotice';
import { DEFER_MS, seedBackupKeyFor } from '~/lib/seedBackup';
import type { LocalAccount } from '~/snapchain/accounts/localAccounts';

const PHRASE =
  'apple banana cherry damson elderberry fig guava hazelnut ivy juniper kiwi lemon';

const heldAccount: LocalAccount = {
  id: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  custodyAddress: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  createdAt: 1_700_000_000_000,
  walletCustody: 'privy',
  provider: 'google',
  email: 'you@gmail.com',
};

const deviceAccount: LocalAccount = {
  id: '0xaaa',
  custodyAddress: '0xaaa',
  phrase: PHRASE,
  fid: 4242,
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  store.clear();
});

describe('an account whose words are held for it', () => {
  it('says so, and offers to write its own copy down', async () => {
    render(
      <SeedBackupNotice
        account={heldAccount}
        heldWordsSlot={
          <button type="button">Open the secure backup window</button>
        }
      />,
    );

    expect(await screen.findByText('Back up your account')).toBeTruthy();
    expect(
      screen.getByText(
        /You signed up with Google, so the words behind this account/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Nobody can give them to you again/)).toBeTruthy();
  });

  it('hides what it shows until asked, and prints no words it does not hold', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    fireEvent.click(await screen.findByText('Show me my backup words'));

    const panel = document.querySelector('[data-fiddy="seed-backup-words"]')!;

    expect(panel.getAttribute('data-hidden')).toBe('true');
    expect((panel as HTMLElement).style.filter).toContain('blur');
    // No word list at all: this device is not holding one.
    expect(panel.querySelectorAll('li').length).toBe(0);
    expect(panel.textContent).toContain(heldAccount.custodyAddress);

    fireEvent.click(screen.getByText('Tap to show the words'));

    await waitFor(() => {
      expect(
        document
          .querySelector('[data-fiddy="seed-backup-words"]')!
          .getAttribute('data-hidden'),
      ).toBe('false');
    });
  });
});

describe('an account whose words live on this device', () => {
  it('shows them blurred, then readable, then asks the person to confirm', async () => {
    render(<SeedBackupNotice account={deviceAccount} />);

    fireEvent.click(await screen.findByText('Show me my backup words'));

    const panel = () =>
      document.querySelector('[data-fiddy="seed-backup-words"]')!;

    expect(panel().getAttribute('data-hidden')).toBe('true');
    expect(panel().querySelectorAll('li').length).toBe(12);
    expect(panel().textContent).toContain('apple');

    fireEvent.click(screen.getByText('Tap to show the words'));

    await waitFor(() =>
      expect(panel().getAttribute('data-hidden')).toBe('false'),
    );

    fireEvent.click(screen.getByText('I have written them down'));

    expect(
      await screen.findByText(/Saved\. Your account is written down/),
    ).toBeTruthy();

    const stored = store.get(seedBackupKeyFor(deviceAccount.id)) as {
      status: string;
      savedAt?: number;
    };

    expect(stored.status).toBe('saved');
    expect(typeof stored.savedAt).toBe('number');
  });
});

describe('the asking can be put off', () => {
  it('buys days, and says nothing about being saved', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    fireEvent.click(await screen.findByText('Not now'));

    await waitFor(() => {
      const stored = store.get(seedBackupKeyFor(heldAccount.id)) as {
        status: string;
        remindAfter: number;
        lastShownAt: number;
      };

      expect(stored.status).toBe('deferred');
      expect(stored.remindAfter - stored.lastShownAt).toBe(DEFER_MS);
    });

    expect(screen.queryByText(/Saved\./)).toBeNull();
    expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
  });

  it('does not come back on the next visit, because it was already asked', async () => {
    render(<SeedBackupNotice account={heldAccount} />);

    // Opens, records the ask, and is closed without any answer given.
    fireEvent.click(await screen.findByText('Show me my backup words'));
    expect(document.querySelector('[data-fiddy="seed-backup"]')).not.toBeNull();

    const asked = store.get(seedBackupKeyFor(heldAccount.id)) as {
      status: string;
      lastShownAt?: number;
    };

    expect(asked.status).toBe('unseen');
    expect(typeof asked.lastShownAt).toBe('number');
  });
});

describe('something that is already saved', () => {
  it('is not asked about again, however the notice is mounted', async () => {
    store.set(seedBackupKeyFor(deviceAccount.id), {
      status: 'saved',
      reminders: 2,
      savedAt: Date.now(),
    });

    render(<SeedBackupNotice account={deviceAccount} />);

    await waitFor(() => {
      expect(document.querySelector('[data-fiddy="seed-backup"]')).toBeNull();
    });
  });
});
