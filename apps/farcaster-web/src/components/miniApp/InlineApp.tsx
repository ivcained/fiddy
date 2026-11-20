import { SignIn } from '@farcaster/miniapp-host';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Image } from '~/components/images/Image';
import {
  SignInProvider,
  useSignIn,
} from '~/contexts/Frame/Actions/SignInProvider';
import { LaunchContext } from '~/contexts/MiniAppProvider';
import { useMinimizableWindowContext } from '~/contexts/MinimizableWindowProvider';
import { useCachedCurrentUser } from '~/hooks/data/useCachedCurrentUser';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useExternalNavigate } from '~/hooks/navigation/useExternalNavigate';
import { useNavigate } from '~/hooks/navigation/useNavigate';
import { useNavigateToConversation } from '~/hooks/navigation/useNavigateToConversation';

import type { Inline as InlineWire, Say } from './inline';
import type { MiniAppLaunchConfig } from './MiniApp';

/**
 * A mini app embed's inline view (`fc:miniapp:inline`): its page in a frame
 * `height` px tall, answered by `inline.ts`. Rendered in a cast's card instead
 * of only the picture and the button, so a poll's votes happen in the feed.
 *
 * Loads lazily: the Comlink wire is imported only once this card runs (a feed
 * with a poll never pulls it unless the view is shown), and the whole thing is
 * separate from `MiniApp.tsx` so a feed containing a poll never loads the
 * wallets.
 *
 * Privacy: on Fiddy's own host the view loads as it scrolls in; any other
 * host's view loads only once it is tapped — loading its page would tell it
 * who is reading, which its picture (fetched elsewhere) never does. Never on
 * this app's own origin: Fiddy itself in the card is a page to trick a tap
 * out of.
 */

const OWN_HOST = /^https:\/\/(?:[\w-]+\.)+fiddy\.fun$/;

type InlineAppProps = {
  /** The embed's url (the app's link in the cast). */
  url: string;
  /** The inline view's url (same-origin with the app). */
  src: string;
  height: number;
  app: { url: string; name?: string; icon?: string };
  /** The cast this card is in (a real embed, not a composer preview). */
  cast?: { hash: string; authorFid?: number; text: string } | null;
  image?: string;
  context: LaunchContext;
  disabled?: boolean;
};

const InnerInlineApp: React.FC<InlineAppProps> = ({
  url,
  src,
  height,
  app,
  cast,
  image,
  context,
  disabled,
}) => {
  const { launchMiniApp } = useMinimizableWindowContext();
  const openUrl = useExternalNavigate();
  const navigateToConversation = useNavigateToConversation();
  const navigate = useNavigate();
  const isSignedIn = useIsSignedIn();
  const user = useCachedCurrentUser();
  const { signIn: signInChain } = useSignIn();

  const originHost = useMemo(() => {
    try {
      return { origin: new URL(src).origin, host: new URL(src).host };
    } catch {
      return { origin: '', host: '' };
    }
  }, [src]);
  const origin = originHost.origin;
  const host = originHost.host;

  const [run, setRun] = useState(OWN_HOST.test(origin));
  const [mod, setMod] = useState<typeof import('./inline')>();
  const [say, setSay] = useState<Say>(null);
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (run && !mod) {
      import('./inline').then(setMod).catch(() => {});
    }
  }, [run, mod]);

  const handleOpenApp = useCallback(
    (targetUrl: string) => {
      const launchConfig: MiniAppLaunchConfig =
        targetUrl === app.url
          ? { type: 'manifest', url: app.url }
          : { type: 'manifest', url: targetUrl };
      launchMiniApp({ context, launchConfig });
    },
    [launchMiniApp, context, app.url],
  );

  const handleOpenUrl = useCallback(
    (targetUrl: string) => {
      openUrl({ to: targetUrl, openInNewTab: true });
    },
    [openUrl],
  );

  const handleViewCast = useCallback(
    (hash: string) => {
      navigateToConversation({ castHash: hash, openInNewTab: false });
    },
    [navigateToConversation],
  );

  const handleViewProfile = useCallback(
    (fid: number) => {
      navigate({ to: 'profileCastsWithoutUsername', params: { fid } });
    },
    [navigate],
  );

  const handleSignIn = useCallback(
    async (options: SignIn.SignInOptions): Promise<SignIn.SignInResult> => {
      const result = await signInChain({
        name: app.name,
        domain: host,
        uri: url,
        options,
      });
      return result;
    },
    [signInChain, app.name, host, url],
  );

  const wireConfig = useMemo<Omit<InlineWire, 'frame'>>(
    () => ({
      origin,
      host,
      name: app.name || host,
      cast,
      embed: url,
      app: { url: app.url, name: app.name, icon: app.icon },
      say: setSay,
      user: () =>
        isSignedIn && user
          ? {
              fid: user.fid,
              username: user.username ?? null,
              displayName: user.displayName ?? null,
              pfpUrl: user.pfp?.url ?? null,
            }
          : undefined,
      openApp: handleOpenApp,
      openUrl: handleOpenUrl,
      viewCast: handleViewCast,
      viewProfile: handleViewProfile,
      signIn: handleSignIn,
    }),
    [
      origin,
      host,
      app.name,
      app.icon,
      app.url,
      cast,
      url,
      isSignedIn,
      user,
      handleOpenApp,
      handleOpenUrl,
      handleViewCast,
      handleViewProfile,
      handleSignIn,
    ],
  );

  // answering before the frame's page can ask anything: attach only once the
  // wire module is in and the frame is rendered
  useLayoutEffect(() => {
    if (!mod || !ref.current) {
      return;
    }
    const detach = mod.attach({ ...wireConfig, frame: ref.current });
    return detach;
  }, [mod, wireConfig]);

  if (disabled) {
    // the composer's preview: the wire's own preview rules apply, but the view
    // is not interactive there
    return null;
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className="relative w-full shrink-0 overflow-hidden"
      style={{ height: `${height}px` }}
      onClick={stop}
    >
      {mod ? (
        <iframe
          ref={ref}
          src={src}
          title={app.name || host}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          className="h-full w-full border-0"
        />
      ) : !run ? (
        <>
          {image && (
            <Image
              src={image}
              alt={app.name || host}
              className="h-full w-full object-cover"
            />
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRun(true);
            }}
            className="absolute inset-0 flex items-center justify-center bg-black/30 text-white"
          >
            Load {host} here
          </button>
        </>
      ) : null}
      {say && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-label={say.title}
          onClick={stop}
        >
          <div className="bg-surface rounded-lg p-4 text-center shadow-lg">
            <b className="block">{say.title}</b>
            {say.body && <span className="mt-1 block text-sm">{say.body}</span>}
            <span className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1 text-sm"
                onClick={() => say.done?.(false)}
              >
                Cancel
              </button>
              {say.yes && (
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1 text-sm text-white"
                  onClick={() =>
                    Date.now() - (say.at || 0) > 1000 && say.done?.(true)
                  }
                >
                  {say.yes}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export const InlineApp: React.FC<InlineAppProps> = (props) => (
  <SignInProvider>
    <InnerInlineApp {...props} />
  </SignInProvider>
);
