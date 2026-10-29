import '~/index.css';

import React from 'react';
import { createRoot } from 'react-dom/client';

import { parseFundingConfig } from '~/lib/fiddyCredit';
import {
  readInjectedWallet,
  resolveTopUpWallet,
  sendTopUp,
} from '~/lib/fiddyTopUpSend';

const config = parseFundingConfig({
  ok: true,
  chain: { id: 8453, name: 'Base', caip2: 'eip155:8453' },
  asset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  treasury: {
    address: '0xe4c848a6fa503762e95ad862cd1e5f7f9f0aab5f',
    short: '0xe4c8…ab5f',
  },
  minimum: { usdc: '1.00', baseUnits: '1000000' },
  confirmations: 5,
  presets: [{ usd: 5, label: 'Top up $5', usdc: '5.00', baseUnits: '5000000' }],
  creditNote: 'A credit.',
});

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';

const deadProvider = () => ({
  request: () => new Promise(() => undefined),
});

const liveProvider = (name: string, record: string[]) => ({
  request: async ({ method }: { method: string }) => {
    record.push(method);
    if (method === 'eth_chainId') {
      return '0x2105';
    }
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
      return [SENDER];
    }
    if (method === 'eth_sendTransaction') {
      return `0x${'cd'.repeat(32)}`;
    }
    throw new Error(`${name} refuses ${method}`);
  },
});

const reader = () => ({
  nativeBalance: async () => 1_000_000_000_000_000_000n,
  tokenDetails: async () => ({
    symbol: 'USDC',
    decimals: 6,
    balance: 10_000_000n,
  }),
  simulateToken: async () => undefined,
  estimateFee: async () => 1000n,
});

const announce = (info: { name: string; rdns: string }, provider: unknown) => {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({
        info: {
          ...info,
          uuid: `00000000-0000-4000-8000-${info.rdns}`,
          icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        },
        provider,
      }),
    }),
  );
};

const outcomes: Record<string, unknown> = {};

const listenForProviders = (callback: () => void) => {
  window.addEventListener('eip6963:requestProvider', callback);
  return () => window.removeEventListener('eip6963:requestProvider', callback);
};

const run = async () => {
  {
    const liveWalletCalls: string[] = [];
    const liveWallet = liveProvider('Live Wallet', liveWalletCalls);
    (window as unknown as { ethereum?: unknown }).ethereum = deadProvider();
    const stop = listenForProviders(() => {
      announce({ name: 'Live Wallet', rdns: 'io.live' }, liveWallet);
    });
    const wallet = await readInjectedWallet();
    stop();
    outcomes.staleGlobalWithAnnounced = {
      label: wallet?.label,
      discoveryMethods: [...liveWalletCalls],
      hash: await sendTopUp({
        reader: reader(),
        config,
        usd: '5.00',
        wallet: wallet!,
      }),
      methods: liveWalletCalls,
    };
  }

  {
    const firstCalls: string[] = [];
    const chosenCalls: string[] = [];
    const first = liveProvider('Other Wallet', firstCalls);
    const chosen = liveProvider('Matching Wallet', chosenCalls);
    const ethereum = chosen;
    (window as unknown as { ethereum?: unknown }).ethereum = ethereum;
    const stop = listenForProviders(() => {
      announce({ name: 'Other Wallet', rdns: 'io.other' }, first);
      announce({ name: 'Matching Wallet', rdns: 'io.matching' }, chosen);
      announce({ name: 'Other Wallet', rdns: 'io.other' }, first);
    });
    const wallet = await readInjectedWallet();
    stop();
    outcomes.twoAnnounced = {
      label: wallet?.label,
      hash: await sendTopUp({
        reader: reader(),
        config,
        usd: '5.00',
        wallet: wallet!,
      }),
      firstMethods: firstCalls,
      discoveryMethods: [...chosenCalls],
      methods: chosenCalls,
    };
  }

  {
    (window as unknown as { ethereum?: unknown }).ethereum = deadProvider();
    outcomes.deadGlobalNoAnnounced = await sendTopUp({
      reader: reader(),
      config,
      usd: '5.00',
      wallet: {
        source: 'wallet',
        address: RECIPIENT,
        provider: deadProvider(),
        label: 'your browser wallet',
      },
      walletTimeoutMs: 1,
    }).catch((error: { code?: string; ownerLine?: string }) => ({
      code: error.code,
      ownerLine: error.ownerLine,
    }));
  }

  {
    const hostCalls: string[] = [];
    const host = liveProvider('Host Wallet', hostCalls);
    const connectedCalls: string[] = [];
    outcomes.hostAheadOfConnected = await resolveTopUpWallet({
      source: 'farcaster',
      openHost: async () => ({ address: RECIPIENT, provider: host }),
      connected: {
        address: RECIPIENT,
        provider: liveProvider('Connected Wallet', connectedCalls),
        label: 'Connected Wallet',
      },
      readFallback: async () => {
        throw new Error('fallback must not be asked');
      },
    }).then((wallet) => ({
      label: wallet?.label,
      hostCalls,
      connectedCalls,
    }));
    outcomes.connectedAheadOfAnnounced = await resolveTopUpWallet({
      source: 'wallet',
      openHost: async () => {
        throw new Error('host must not be asked');
      },
      connected: {
        address: RECIPIENT,
        provider: liveProvider('Connected Wallet', connectedCalls),
        label: 'Connected Wallet',
      },
      readFallback: async () => {
        throw new Error('fallback must not be asked');
      },
    }).then((wallet) => ({ label: wallet?.label }));
  }

  return outcomes;
};

const finish = (result: unknown) => {
  const root = document.getElementById('root')!;
  root.innerHTML = '';
  const outcome = document.createElement('pre');
  outcome.id = 'wallet-fallback-result';
  outcome.textContent = JSON.stringify(result);
  const copy = document.createElement('p');
  copy.setAttribute('data-probe', 'copy');
  copy.textContent =
    'Your browser wallet is not answering. Reconnect it or choose another wallet.';
  root.append(outcome, copy);
  root.setAttribute('data-wallet-probe-ready', 'true');
};

void run().then(finish, (error: unknown) => {
  finish({ probeThrew: String(error) });
});

const App = () => (
  <main>
    <h1>Fiddy wallet fallback probe</h1>
    <p data-probe="copy">
      Your browser wallet is not answering. Reconnect it or choose another
      wallet.
    </p>
  </main>
);

createRoot(document.getElementById('root')!).render(<App />);
