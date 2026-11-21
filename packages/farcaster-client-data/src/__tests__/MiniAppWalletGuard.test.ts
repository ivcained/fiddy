import {
  checkWallet,
  rpcError,
  signInCheck,
} from '../utils/MiniAppWalletGuard';

// Test cases ported from backmeupplz/quilcast (MIT) src/guard.test.ts, commit
// 5efc1efd5c5f ("0.107.1 mini app guard and host security fixes").

// The address the wallet actually signs for.
const me = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const other = '0x0000000000000000000000000000000000000001';
const appHost = 'mini-app.example';

const hexed = (s: string) => {
  let out = '0x';
  for (let i = 0; i < s.length; i += 1) {
    out += s.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
};

const thrower = (method: string, params: unknown[]) => () =>
  checkWallet(appHost, me, method, params);

describe('MiniAppWalletGuard', () => {
  describe('personal_sign refuses Farcaster account signatures', () => {
    // Any message for a Farcaster sign-in / account handover is refused.
    const farcasterMessages = [
      hexed(
        `${appHost} wants you to sign in with your Ethereum account:\n…\n- farcaster://fid/1`,
      ),
      'Direct cast authorization for Farcaster FID 1',
      '{"method":"generateToken","params":{}}',
      hexed('{"method":"generateToken","params":{}}'),
      // Farcaster sites are refused even as a plain SIWE domain.
      'farcaster.xyz wants you to sign in with your Ethereum account:\n…',
      'https://warpcast.com wants you to sign in with your Ethereum account:\n…',
    ];
    it.each(farcasterMessages)('refuses: %p', (msg) => {
      expect(thrower('personal_sign', [msg, me])).toThrow(
        expect.objectContaining({ code: 4100 }),
      );
    });

    it('refuses a Farcaster sign-in message for another site', () => {
      expect(
        thrower('personal_sign', [
          hexed(
            'warpcast.com wants you to sign in with your Ethereum account:\n…\n- farcaster://fid/1',
          ),
          me,
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('allows a non-Farcaster app-host sign-in for the same host', () => {
      expect(
        thrower('personal_sign', [
          hexed(
            `${appHost} wants you to sign in with your Ethereum account:\n…\n- farcaster://fid/1`,
          ),
          me,
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('returns the site for a cross-app sign-in that is not Farcaster', () => {
      const site = signInCheck(
        appHost,
        'other-app.example wants you to sign in with your Ethereum account:\n…',
      );
      expect(site).toBe('other-app.example');
    });

    it('allows a sign-in for the app own host', () => {
      expect(
        signInCheck(
          appHost,
          `${appHost} wants you to sign in with your Ethereum account:\n…`,
        ),
      ).toBeUndefined();
    });

    it('refuses when the signing address is not the connected one', () => {
      expect(thrower('personal_sign', ['just a message', other])).toThrow(
        expect.objectContaining({ code: 4100 }),
      );
    });
  });

  describe('eth_signTypedData_v4 refuses Farcaster typed-data', () => {
    it('refuses a Farcaster KeyGateway domain', () => {
      expect(
        thrower('eth_signTypedData_v4', [
          me,
          JSON.stringify({ domain: { name: 'Farcaster KeyGateway' } }),
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses a Hypersnap onboarding typed-data (new account handover)', () => {
      expect(
        thrower('eth_signTypedData_v4', [
          me,
          {
            domain: {
              name: 'HypersnapNativeOnboard',
              version: '1',
              chainId: 10,
            },
          },
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses the KeyGateway verifyingContract address', () => {
      expect(
        thrower('eth_signTypedData_v4', [
          me,
          {
            domain: {
              name: 'x',
              verifyingContract: '0x00000000FC6C5F01FC30151999387BB99A9F489B',
            },
          },
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses unreadable (non-JSON) typed-data', () => {
      expect(thrower('eth_signTypedData_v4', [me, 'not json'])).toThrow(
        expect.objectContaining({ code: 4100 }),
      );
    });

    it('refuses when the signing address is not the connected one', () => {
      expect(
        thrower('eth_signTypedData_v4', [other, JSON.stringify({})]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });
  });

  describe('eth_sendTransaction refuses Farcaster contract targets', () => {
    it('refuses a transaction to the IdRegistry', () => {
      expect(
        thrower('eth_sendTransaction', [
          { to: '0x00000000fc6c5f01fc30151999387bb99a9f489b' },
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses a transaction from a non-connected address', () => {
      expect(
        thrower('eth_sendTransaction', [
          { from: other, to: '0x1111111111111111111111111111111111111111' },
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses missing transaction', () => {
      expect(thrower('eth_sendTransaction', [])).toThrow(
        expect.objectContaining({ code: 4100 }),
      );
    });
  });

  describe('wallet_sendCalls refuses Farcaster contract targets', () => {
    it('refuses a batch with a KeyGateway call', () => {
      expect(
        thrower('wallet_sendCalls', [
          {
            calls: [
              { to: '0x1111111111111111111111111111111111111111' },
              { to: '0x00000000fc56947c7e7183f8ca4b62398caadf0b' },
            ],
          },
        ]),
      ).toThrow(expect.objectContaining({ code: 4100 }));
    });

    it('refuses a batch from a non-connected address', () => {
      expect(thrower('wallet_sendCalls', [{ from: other, calls: [] }])).toThrow(
        expect.objectContaining({ code: 4100 }),
      );
    });
  });

  describe('wallet requests that are fine get through', () => {
    it('does not throw for benign requests', () => {
      expect(() =>
        checkWallet(appHost, me, 'personal_sign', [hexed('hello'), me]),
      ).not.toThrow();
      expect(() =>
        checkWallet(appHost, me, 'personal_sign', [
          hexed(
            `${appHost} wants you to sign in with your Ethereum account:\n…`,
          ),
          me,
        ]),
      ).not.toThrow();
      expect(() =>
        checkWallet(appHost, me, 'eth_signTypedData_v4', [
          me,
          JSON.stringify({
            domain: {
              name: 'USD Coin',
              verifyingContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            },
          }),
        ]),
      ).not.toThrow();
      expect(() =>
        checkWallet(appHost, me, 'eth_sendTransaction', [
          {
            from: me.toUpperCase().replace('0X', '0x'),
            to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        ]),
      ).not.toThrow();
      expect(() =>
        checkWallet(appHost, me, 'wallet_sendCalls', [
          { calls: [{ to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }] },
        ]),
      ).not.toThrow();
    });
  });

  it('rpcError carries the EIP-1193 code', () => {
    const err = rpcError(4100, 'nope');
    expect(err.code).toBe(4100);
    expect(err.message).toBe('nope');
  });
});
