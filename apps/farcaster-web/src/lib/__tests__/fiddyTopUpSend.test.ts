// @vitest-environment jsdom
/**
 * The send: one USDC transfer to Fiddy's own address, and a name for every way
 * it can be refused.
 *
 * WHY THESE ASSERTIONS. This is the only file in the client that moves money, so
 * the tests are about the two things that would be worst to get wrong:
 *
 *   1. the transfer is built from the server's own config — USDC's contract on
 *      Base, the treasury address the config named, and exactly the amount the
 *      screen reviewed (`transfer(treasury, 5000000)`, nothing else);
 *   2. a refusal is named: another network, no USDC, no ETH for the fee, or a
 *      person who did not approve it are four different sentences, and a wallet
 *      that is on another network never reaches a broadcast at all.
 *
 * The Farcaster miniapp wallet is measured where it can be: outside a host it
 * must answer "no wallet here" rather than hanging or throwing, which is what
 * lets the screen fall back to a wallet the reader can connect.
 */

import { decodeFunctionData, erc20Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FundingError, parseFundingConfig } from '~/lib/fiddyCredit';
import {
  describeSendFailure,
  readInjectedWallet,
  resolveTopUpWallet,
  sendTopUp,
  walletAccount,
  walletChainId,
} from '~/lib/fiddyTopUpSend';
import type { BaseTransferReader } from '~/utils/baseWalletTransfer';

const TREASURY = '0xe4c848a6fa503762e95ad862cd1e5f7f9f0aab5f';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SENDER = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;

const config = parseFundingConfig({
  ok: true,
  chain: { id: 8453, name: 'Base', caip2: 'eip155:8453' },
  asset: { symbol: 'USDC', address: USDC, decimals: 6 },
  treasury: { address: TREASURY, short: '0xe4c8…ab5f' },
  minimum: { usdc: '1.00', baseUnits: '1000000' },
  confirmations: 5,
  presets: [{ usd: 5, label: 'Top up $5', usdc: '5.00', baseUnits: '5000000' }],
  creditNote: 'A credit.',
});

const reader = (balance = 10_000_000n): BaseTransferReader => ({
  nativeBalance: async () => 10n ** 18n,
  tokenDetails: async () => ({ symbol: 'USDC', decimals: 6, balance }),
  simulateToken: async () => undefined,
  estimateFee: async () => 1000n,
});

type Call = { method: string; params?: unknown };

const fakeProvider = ({
  chainId = 8453,
  accounts = [SENDER],
  record,
}: {
  chainId?: number;
  accounts?: string[];
  record: Call[];
}) => ({
  request: async (args: Call): Promise<unknown> => {
    record.push(args);
    switch (args.method) {
      case 'eth_chainId':
        return `0x${chainId.toString(16)}`;
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return accounts;
      case 'eth_sendTransaction':
        return HASH;
      default:
        throw new Error(`unexpected ${args.method}`);
    }
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one transfer, built from the server’s config', () => {
  it('sends USDC on Base to the treasury, for the amount that was reviewed', async () => {
    const calls: Call[] = [];
    const hash = await sendTopUp({
      reader: reader(),
      config,
      usd: '5.00',
      wallet: {
        source: 'wallet',
        address: SENDER,
        provider: fakeProvider({ record: calls }),
        label: 'MetaMask',
      },
    });

    expect(hash).toBe(HASH);
    const sent = calls.find((call) => call.method === 'eth_sendTransaction');
    expect(sent).toBeDefined();
    const [transaction] = sent?.params as [
      { to: string; data: string; value: string; from: string },
    ];
    expect(transaction.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(transaction.from.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(transaction.value).toBe('0x0');
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: transaction.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args[0]?.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(decoded.args[1]).toBe(5000000n);
  });

  it('refuses another network before anything is broadcast', async () => {
    const calls: Call[] = [];
    await expect(
      sendTopUp({
        reader: reader(),
        config,
        usd: '5.00',
        wallet: {
          source: 'wallet',
          address: SENDER,
          provider: fakeProvider({ chainId: 1, record: calls }),
          label: 'MetaMask',
        },
      }),
    ).rejects.toMatchObject({ code: 'WRONG_NETWORK' });

    expect(calls.some((call) => call.method === 'eth_sendTransaction')).toBe(
      false,
    );
  });

  it('names a wallet that will not say which account it is', async () => {
    const calls: Call[] = [];
    await expect(
      sendTopUp({
        reader: reader(),
        config,
        usd: '5.00',
        wallet: {
          source: 'wallet',
          address: SENDER,
          provider: fakeProvider({ accounts: [], record: calls }),
          label: 'MetaMask',
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('refuses a wallet with no USDC, and says so in words', async () => {
    const calls: Call[] = [];
    try {
      await sendTopUp({
        reader: reader(0n),
        config,
        usd: '5.00',
        wallet: {
          source: 'wallet',
          address: SENDER,
          provider: fakeProvider({ record: calls }),
          label: 'MetaMask',
        },
      });
      throw new Error('expected the send to be refused');
    } catch (error) {
      expect((error as FundingError).code).toBe('NOT_ENOUGH_USDC');
      expect((error as FundingError).ownerLine).toContain(
        'does not have that much USDC',
      );
    }
    expect(calls.some((call) => call.method === 'eth_sendTransaction')).toBe(
      false,
    );
  });
});

describe('every refusal has a name', () => {
  it('reads a person’s own refusal as a decision, not an error', () => {
    expect(describeSendFailure({ code: 4001 }).code).toBe('DECLINED');
    expect(
      describeSendFailure(new Error('User rejected the request')).code,
    ).toBe('DECLINED');
  });

  it('reads a disconnected wallet and a wrong network apart', () => {
    expect(describeSendFailure({ code: 4900 }).code).toBe('NOT_CONNECTED');
    expect(
      describeSendFailure(
        new Error('Wallet is not on Base. No transaction was submitted.'),
      ).code,
    ).toBe('WRONG_NETWORK');
  });

  it('reads the transfer builder’s own sentences', () => {
    expect(
      describeSendFailure(
        new Error('Not enough ETH on Base for this send and estimated gas.'),
      ).code,
    ).toBe('NOT_ENOUGH_GAS');
    expect(describeSendFailure(new Error('something else entirely')).code).toBe(
      'SEND_FAILED',
    );
  });

  it('never wraps a FundingError in another one', () => {
    const original = new FundingError('DECLINED');
    expect(describeSendFailure(original)).toBe(original);
  });
});

describe('wallet resolution priority', () => {
  it('keeps the Farcaster host ahead of connected and injected wallets', async () => {
    const host = fakeProvider({ record: [] });
    const resolved = await resolveTopUpWallet({
      source: 'farcaster',
      openHost: async () => ({ address: SENDER, provider: host }),
      connected: {
        address: SENDER,
        provider: fakeProvider({ record: [] }),
        label: 'Connected',
      },
      readFallback: async () => {
        throw new Error('the injected fallback must not be asked');
      },
    });

    expect(resolved).toMatchObject({
      source: 'farcaster',
      address: SENDER,
      provider: host,
      label: 'your Farcaster wallet',
    });
  });

  it('keeps the connected wallet ahead of injected discovery', async () => {
    const connected = fakeProvider({ record: [] });
    const resolved = await resolveTopUpWallet({
      source: 'wallet',
      openHost: async () => {
        throw new Error('the host must not be asked');
      },
      connected: {
        address: SENDER,
        provider: connected,
        label: 'Connected',
      },
      readFallback: async () => {
        throw new Error('the injected fallback must not be asked');
      },
    });

    expect(resolved).toMatchObject({
      source: 'wallet',
      address: SENDER,
      provider: connected,
      label: 'Connected',
    });
  });
});

describe('the wallets this client can reach', () => {
  it('reads a provider that injected itself, and nothing when there is none', async () => {
    await expect(readInjectedWallet()).resolves.toBeNull();

    vi.stubGlobal('ethereum', {
      request: async () => [],
      isMetaMask: true,
    });

    const injected = await readInjectedWallet();
    expect(injected?.label).toBe('MetaMask');
    expect(injected?.source).toBe('wallet');
  });

  it('prefers a live announced wallet over a global that never answers', async () => {
    const stale = { request: () => new Promise(() => {}) };
    const live = fakeProvider({ record: [] });
    vi.stubGlobal('ethereum', stale);
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { name: 'Rabby', rdns: 'io.rabby' },
            provider: live,
          },
        }),
      );
    };
    window.addEventListener('eip6963:requestProvider', announce, {
      once: true,
    });

    try {
      const injected = await readInjectedWallet();
      expect(injected?.provider).toBe(live);
      expect(injected?.label).toBe('Rabby');
    } finally {
      window.removeEventListener('eip6963:requestProvider', announce);
    }
  });

  it('dedupes announcements and keeps the chosen provider through submission', async () => {
    const firstCalls: Call[] = [];
    const chosenCalls: Call[] = [];
    const first = fakeProvider({ record: firstCalls });
    const chosen = fakeProvider({ record: chosenCalls });
    vi.stubGlobal('ethereum', chosen);
    const announce = () => {
      for (const [name, rdns, provider] of [
        ['Rabby', 'io.rabby', first],
        ['MetaMask', 'io.metamask', chosen],
        ['Rabby again', 'io.rabby', first],
      ] as const) {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: { info: { name, rdns }, provider },
          }),
        );
      }
    };
    window.addEventListener('eip6963:requestProvider', announce, {
      once: true,
    });

    try {
      const wallet = await readInjectedWallet();
      expect(wallet?.provider).toBe(chosen);
      expect(wallet?.label).toBe('MetaMask');
      expect(
        await sendTopUp({
          reader: reader(),
          config,
          usd: '5.00',
          wallet: wallet!,
        }),
      ).toBe(HASH);
      expect(
        chosenCalls.some((call) => call.method === 'eth_sendTransaction'),
      ).toBe(true);
      expect(firstCalls).toEqual([]);
    } finally {
      window.removeEventListener('eip6963:requestProvider', announce);
    }
  });

  it('gives a dead fallback wallet a bounded, named refusal', async () => {
    const dead = { request: () => new Promise(() => {}) };
    await expect(
      sendTopUp({
        reader: reader(),
        config,
        usd: '5.00',
        walletTimeoutMs: 1,
        wallet: {
          source: 'wallet',
          address: SENDER,
          provider: dead,
          label: 'your browser wallet',
        },
      }),
    ).rejects.toMatchObject({
      code: 'WALLET_UNRESPONSIVE',
      ownerLine:
        'Your browser wallet is not answering. Reconnect it or choose another wallet.',
    });
  });

  it('asks the wallet which chain it is on, and survives one that will not say', async () => {
    expect(await walletChainId({ request: async () => '0x2105' })).toBe(8453);
    expect(
      await walletChainId({
        request: async () => {
          throw new Error('nope');
        },
      }),
    ).toBeNull();
  });

  it('takes the account from the wallet rather than assuming one', async () => {
    expect(await walletAccount({ request: async () => [SENDER] })).toBe(SENDER);
    expect(
      await walletAccount({ request: async () => ['not-an-address'] }),
    ).toBeNull();
  });
});

describe('the Farcaster miniapp wallet', () => {
  it('answers "no wallet here" outside a miniapp instead of hanging', async () => {
    vi.doMock('@farcaster/miniapp-sdk', () => ({
      default: {
        isInMiniApp: async () => false,
        wallet: {
          getEthereumProvider: async () => {
            throw new Error('should not be asked');
          },
        },
      },
    }));
    const { inFarcasterMiniapp, openMiniappWallet } =
      await import('~/lib/farcasterWallet');

    expect(await inFarcasterMiniapp()).toBe(false);
    expect(await openMiniappWallet()).toBeNull();
  });
});
