import { memo, Suspense, useSyncExternalStore } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { FiddyWalletHomeConnected } from '~/components/fiddy/FiddyWalletHome';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { PreferredWalletSelector } from '~/components/wallet/PreferredWalletDialog';
import { SettingsNav } from '~/layouts/SettingsNav';
import { holdTip, setHoldTip } from '~/lib/tipask';

/** Subscribe to hold-to-tip preference changes from other tabs/instances. */
const useHoldTip = () =>
  useSyncExternalStore(
    (cb) => {
      window.addEventListener('storage', cb);
      return () => window.removeEventListener('storage', cb);
    },
    holdTip,
    holdTip,
  );

const TipToggle = memo(() => {
  const on = useHoldTip();

  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-gray-900 dark:text-white">
          Hold Like to tip
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Holding Like on someone's cast sends a $1 tip. A tap still just likes.
        </span>
      </div>
      <button
        type="button"
        className={`rounded-full px-5 py-1.5 text-sm font-medium transition-colors ${
          on
            ? 'bg-fiddy text-white'
            : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
        }`}
        onClick={() => setHoldTip(!on)}
        aria-pressed={on}
      >
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
});

TipToggle.displayName = 'TipToggle';

const SettingsPreferredWalletPage = memo(() => {
  return (
    <Page meta={{ title: 'Preferred wallet / Farcaster' }}>
      <Suspense>
        <div className="border-default sm:border-x">
          <PageHeader hideCastButton>
            <PageTitle>Settings</PageTitle>
          </PageHeader>
        </div>
        <BorderedMainContent className="flex flex-row">
          <SettingsNav />
          <SettingsPageContent>
            <PreferredWalletSelector />
            {/* Which wallet pays for what your agent uses, and the one thing it
                pays for today. Beside the wallet chooser because it is the same
                question asked about money instead of identity. */}
            <FiddyWalletHomeConnected />

            {/* Hold-to-tip kill-switch: shares its state with TipSheet (tipask.ts). */}
            <div className="mt-6">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Tips
              </h3>
              <TipToggle />
            </div>
          </SettingsPageContent>
        </BorderedMainContent>
      </Suspense>
    </Page>
  );
});

SettingsPreferredWalletPage.displayName = 'SettingsPreferredWalletPage';

export { SettingsPreferredWalletPage };
