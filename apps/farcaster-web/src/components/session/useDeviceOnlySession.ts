/**
 * Is the session we are holding a device-only one, and who does it say we are?
 *
 * A completed SIWF handshake proves who signed in, but this client has no
 * backend to exchange that proof for a farcaster.xyz API token, so the session
 * it can hold is real identity with no server access (see ~/lib/siwfSession).
 * Everything the shell does after that assumes the opposite — so the shell has
 * to be able to ask this question in plain words, in one place.
 *
 * Identity comes from the CACHED onboarding state, never from a fetch: this
 * hook is read on every shell mount, including the ones where the network is
 * exactly what is broken, so it must not be able to fail or suspend.
 */

import { useCachedOnboardingState } from 'farcaster-client-hooks';

import { localApiEnabled } from '~/constants/api';
import { useAuth } from '~/contexts/AuthProvider';
import { isLocalSessionToken } from '~/lib/siwfSession';

type DeviceOnlySession =
  | { isDeviceOnly: false }
  | {
      isDeviceOnly: true;
      fid?: number;
      username?: string;
      displayName?: string;
    };

const useDeviceOnlySession = (): DeviceOnlySession => {
  const { authToken } = useAuth();
  const user = useCachedOnboardingState().result.state.user;

  // A local token is the marker. `localApiEnabled` is the exception that keeps
  // the dev escape hatch usable: with the mock API on, this session IS served,
  // so it is not "device-only" in the sense that matters here, and the shell
  // (and its degrade panels) must behave normally.
  if (!isLocalSessionToken(authToken) || localApiEnabled) {
    return { isDeviceOnly: false };
  }

  return {
    isDeviceOnly: true,
    fid: user?.fid,
    username: user?.username,
    displayName: user?.displayName,
  };
};

/**
 * "@fiddy · fid 4242" — the account, named the way the sign-in screen named it,
 * or whatever part of it we actually know. Never invents a handle.
 */
const describeDeviceOnlyAccount = (session: DeviceOnlySession): string => {
  if (!session.isDeviceOnly) {
    return '';
  }

  const { fid, username, displayName } = session;

  const name =
    username !== undefined && username !== ''
      ? `@${username}`
      : (displayName ?? (fid !== undefined ? `fid ${fid}` : ''));

  const withFid =
    username !== undefined && username !== '' && fid !== undefined
      ? `${name} · fid ${fid}`
      : name;

  return withFid.trim();
};

export { describeDeviceOnlyAccount, useDeviceOnlySession };
export type { DeviceOnlySession };
