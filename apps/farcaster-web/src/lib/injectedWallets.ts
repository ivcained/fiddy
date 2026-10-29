/**
 * Wallets that announce themselves to this page.
 *
 * Discovery is lazy-loaded only by the top-up fallback. It requests no accounts
 * and retains no address-to-provider registry. Selection lasts for the returned
 * TopUpWallet, so chain checks, approval, simulation and submission keep one
 * provider. Adapted narrowly from backmeupplz/quilcast (MIT), commits
 * 680cb61281960711640a3212a5799836e9acb6e5 and
 * 2a4ab887b9534c73c30e9bfaf624edc90e0f4682.
 */

export interface AnnouncedProvider {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  isMetaMask?: boolean;
}

export interface AnnouncedWallet {
  provider: AnnouncedProvider;
  label: string;
  rdns: string;
}

type AnnouncementDetail = {
  info?: { name?: unknown; rdns?: unknown };
  provider?: AnnouncedProvider;
};

export interface DiscoverAnnouncedWalletsOptions {
  target?: Window | null;
  waitMs?: number;
}

/** One short collection window, then the page's announced choices, deduplicated. */
export const discoverAnnouncedWallets = async ({
  target = null,
  waitMs = 80,
}: DiscoverAnnouncedWalletsOptions = {}): Promise<AnnouncedWallet[]> => {
  const page = target;
  if (page === null || typeof page.addEventListener !== 'function') {
    return [];
  }
  const wallets: AnnouncedWallet[] = [];
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<AnnouncementDetail>).detail;
    const provider = detail?.provider;
    if (typeof provider?.request !== 'function') {
      return;
    }
    const rdns = typeof detail.info?.rdns === 'string' ? detail.info.rdns : '';
    if (
      wallets.some(
        (wallet) =>
          wallet.provider === provider || (rdns !== '' && wallet.rdns === rdns),
      )
    ) {
      return;
    }
    const name = typeof detail.info?.name === 'string' ? detail.info.name : '';
    wallets.push({
      provider,
      label: name || (provider.isMetaMask ? 'MetaMask' : 'your browser wallet'),
      rdns,
    });
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      page.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(wallets);
    };
    const timer = setTimeout(finish, waitMs);
    page.addEventListener('eip6963:announceProvider', onAnnounce);
    try {
      page.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch {
      finish();
    }
  });
};
