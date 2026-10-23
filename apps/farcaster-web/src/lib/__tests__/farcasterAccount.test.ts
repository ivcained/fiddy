/**
 * What a Farcaster sign-in leaves in the account book, and what it may never
 * claim.
 *
 * The tests that matter are the ones about NOT holding anybody's key: a row
 * built here must carry no phrase and no custody address, because the key that
 * owns the account is in the person's own Farcaster app. The rest are about
 * naming: the row is keyed by the number, named by the handle, and a handshake
 * that carried no usable number writes nothing at all.
 */

import { describe, expect, it } from 'vitest';

import {
  buildFarcasterSessionRecord,
  FARCASTER_ACCOUNT_ID_PREFIX,
  farcasterAccountIdFor,
  farcasterSessionNote,
  type FarcasterSessionRecord,
  isFarcasterAccountId,
  isFarcasterSession,
} from '~/lib/farcasterAccount';
import {
  describeLocalAccount,
  FARCASTER_SESSION_WALLET_CUSTODY,
  type LocalAccount,
} from '~/snapchain/accounts/localAccounts';

/** The row a real handshake leaves, or a test that fails loudly instead. */
const session = (
  overrides: Parameters<typeof buildFarcasterSessionRecord>[0] = { fid: 3 },
): FarcasterSessionRecord => {
  const record = buildFarcasterSessionRecord(overrides);

  if (!record) {
    throw new Error('this handshake should have produced a row');
  }

  return record;
};

describe('the row a Farcaster sign-in leaves', () => {
  it('is keyed by the number it proved, not by an address', () => {
    expect(session({ fid: 3, username: 'dwr' }).id).toBe(
      farcasterAccountIdFor(3),
    );
    expect(session({ fid: 3 }).id).toBe('farcaster:3');
    expect(
      farcasterAccountIdFor(3).startsWith(FARCASTER_ACCOUNT_ID_PREFIX),
    ).toBe(true);
  });

  it('holds no phrase and no address, because this device holds neither', () => {
    const record = session({ fid: 3, username: 'dwr' });

    expect(record.phrase).toBeUndefined();
    expect(record.custodyAddress).toBeUndefined();
  });

  it('does not claim a signing key was installed here', () => {
    // `signedInAt` means "a posting key for this device was installed for this
    // account"; a sign-in installs nothing, and a row that said otherwise would
    // carry the wrong promise into the switcher.
    expect(session({ fid: 3, username: 'dwr' }).signedInAt).toBeUndefined();
  });

  it('keeps the handle and the name the handshake gave, and invents neither', () => {
    expect(session({ fid: 3, username: 'dwr' })).toMatchObject({
      fid: 3,
      username: 'dwr',
      displayName: 'dwr',
    });

    expect(
      session({ fid: 3, username: 'dwr', displayName: 'Dan Romero' }),
    ).toMatchObject({ displayName: 'Dan Romero' });

    const nameless = session({ fid: 3 });
    expect(nameless.username).toBeUndefined();
    expect(nameless.displayName).toBeUndefined();

    expect(session({ fid: 3, username: '   ' }).username).toBeUndefined();
  });

  it('writes nothing at all when the handshake carried no usable number', () => {
    expect(buildFarcasterSessionRecord({ fid: 0 })).toBeUndefined();
    expect(buildFarcasterSessionRecord({ fid: -1 })).toBeUndefined();
    expect(buildFarcasterSessionRecord({ fid: 1.5 })).toBeUndefined();
    expect(buildFarcasterSessionRecord({ fid: Number.NaN })).toBeUndefined();
  });

  it('is marked as a sign-in rather than an account made here', () => {
    const record = session({ fid: 3, username: 'dwr' });

    expect(record.walletCustody).toBe(FARCASTER_SESSION_WALLET_CUSTODY);
    expect(isFarcasterSession(record)).toBe(true);
  });

  it('is not confused with the accounts this device made or signed up for', () => {
    const deviceAccount: LocalAccount = {
      id: '0xaaa',
      custodyAddress: '0xaaa',
      phrase: 'apple banana',
      createdAt: 1,
    };
    const socialAccount: LocalAccount = {
      id: '0xbbb',
      custodyAddress: '0xbbb',
      walletCustody: 'privy',
      provider: 'google',
      createdAt: 1,
    };

    expect(isFarcasterSession(deviceAccount)).toBe(false);
    expect(isFarcasterSession(socialAccount)).toBe(false);
    expect(isFarcasterSession(undefined)).toBe(false);
  });

  it('names itself on screen by the handle the handshake proved', () => {
    expect(describeLocalAccount(session({ fid: 3, username: 'dwr' }))).toBe(
      '@dwr',
    );
    // With no handle from the relay, the number is what is left — never an
    // address it does not have.
    expect(describeLocalAccount(session({ fid: 3 }))).toBe('account 3');
  });

  it('knows its own id shape', () => {
    expect(isFarcasterAccountId('farcaster:3')).toBe(true);
    expect(
      isFarcasterAccountId('0x8f3cf7ad23cd3cadbd9735aff958023239c6a063'),
    ).toBe(false);
  });
});

describe('what the switcher says about such a row', () => {
  it('says where the sign-in came from, and whether this device can post', () => {
    const noKey = farcasterSessionNote({ canPost: false });

    expect(noKey).toMatch(/your own farcaster app/i);
    expect(noKey).toMatch(/no posting key on this device yet/i);

    const withKey = farcasterSessionNote({ canPost: true });

    expect(withKey).toMatch(/your own farcaster app/i);
    expect(withKey).toMatch(/this device can post/i);
  });
});
