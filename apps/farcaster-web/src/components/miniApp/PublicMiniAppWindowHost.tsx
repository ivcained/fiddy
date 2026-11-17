import * as React from 'react';

import { MiniApp } from '~/components/miniApp/MiniApp';
import { useLaunchMiniApp } from '~/contexts/MiniAppProvider';
import { useMinimizableWindowContext } from '~/contexts/MinimizableWindowProvider';
import { WalletLockedProvider } from '~/contexts/WalletLockedProvider';
import { cn } from '~/lib/utils';

/**
 * The mini app window for a reader who is NOT signed in.
 *
 * `MinimizableWindowHost` — the window the authed shell opens a mini app
 * into — is mounted only by `AuthedRightSideBar`, so a signed-out reader on
 * the public surfaces (`/feed`, `/explore`, a conversation) pressed a cast's
 * mini app launch button and nothing happened: `launchMiniApp` set its state,
 * and no host anywhere rendered it. The card that surfaced this (`t_5dfc9e8b`)
 * is the node-only mini apps card — its whole acceptance is a signed-out
 * reader, fresh browser, no Neynar key, opening an app from a cast — so the
 * public shell needs a window of its own.
 *
 * This is deliberately NOT `MinimizableWindowHost` reused with a flag: that
 * host also mounts the floating wallet, the spaces mini player and the
 * resume-cast button, whose providers (`SpaceContext`,
 * `CastComposerSessionProvider`) live inside `AuthedLayout` and would crash
 * or misrender outside it. `MiniApp` itself needs one provider the public
 * tree does not mount — `WalletLockedProvider`, for the embedded-wallet
 * bridge — and that provider is self-contained, so it is provided HERE
 * rather than asking every public page to grow it. The rest of what `MiniApp`
 * consumes are the global ones (`App.tsx` mounts `MiniAppProvider`,
 * `MinimizableWindowProvider` and `AuthProvider` above the router, and
 * `useWallet` has a provider-less default), and the user-dependent reads
 * (`useCurrentUser`, notifications, favorites) are query hooks that settle
 * into their signed-out answers. A signed-out launch therefore opens the
 * app anonymous — exactly the node-only chain this card ships — and the
 * app's own sign-in flow is the app's business, inside the iframe.
 *
 * The classes are `MinimizableWindowHost`'s own (variant `sidebar`), so the
 * two windows look and move the same; nothing here restyles the window.
 */
const PublicMiniAppWindowHost: React.FC = () => {
  const { miniAppParams } = useLaunchMiniApp();
  const { miniAppMinimized, dismissMiniApp } = useMinimizableWindowContext();

  return (
    <div
      className={cn([
        'pointer-events-none fixed bottom-4 z-10 flex w-auto flex-col items-end gap-3',
        'transition-all duration-300 ease-in-out',
        'max-h-[calc(100vh-1rem)] pt-3',
        'right-4 xl:bottom-0 xl:max-h-screen',
        'xl:right-auto xl:w-[393px]',
      ])}
    >
      <div
        className={cn([
          'transition-all duration-300 ease-in-out',
          'rounded-xl',
          'pointer-events-auto bg-swap',
          'flex min-h-[48px] shrink flex-col',
          {
            'w-[393px]': !miniAppMinimized,
            'w-[48px]': miniAppMinimized,
            hidden: !miniAppParams,
          },
        ])}
      >
        <WalletLockedProvider>
          <MiniApp
            launchConfig={miniAppParams?.launchConfig}
            context={miniAppParams?.context}
            debug={miniAppParams?.debug}
            onClose={dismissMiniApp}
          />
        </WalletLockedProvider>
      </div>
    </div>
  );
};

export { PublicMiniAppWindowHost };
