/**
 * Profile edit component that allows users to enable Fiddy 3D on their
 * own profile. Only shown to the signed-in user for their own profile.
 * Uses local storage to remember the setting — no server claim.
 * Only allows the signed-in user's own FID.
 */

import { FC, memo, useCallback, useEffect, useState } from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';

import {
  clearStoredFiddy3DFid,
  FIDDY_3D_CREATE_URL,
  fiddy3DAssetUrl,
  getStoredFiddy3DFid,
  setStoredFiddy3DFid,
} from './fiddy3DProfile';

interface ProfileFiddy3DSettingsProps {
  /** The signed-in user's FID. */
  signedInFid: number;
  /** Whether this is the signed-in user's own profile. */
  isOwnProfile: boolean;
}

const ProfileFiddy3DSettings: FC<ProfileFiddy3DSettingsProps> = memo(
  ({ signedInFid, isOwnProfile }) => {
    const [enabled, setEnabled] = useState(false);
    const [hasAssets, setHasAssets] = useState<boolean | null>(null);

    // Load stored preference on mount
    useEffect(() => {
      if (!isOwnProfile) {
        return;
      }
      const stored = getStoredFiddy3DFid();
      // Only enable if it matches the current signed-in FID
      if (stored === signedInFid) {
        setEnabled(true);
      }
    }, [isOwnProfile, signedInFid]);

    // Check if the user's FID has 3D assets (probe the thumbnail)
    useEffect(() => {
      if (!enabled || !signedInFid) {
        setHasAssets(null);
        return;
      }

      const controller = new AbortController();
      const checkAssets = async () => {
        try {
          const thumbnailUrl = fiddy3DAssetUrl(signedInFid, 'thumbnail.png');
          const response = await fetch(thumbnailUrl, {
            method: 'HEAD',
            signal: controller.signal,
          });
          setHasAssets(response.ok);
        } catch {
          setHasAssets(false);
        }
      };
      checkAssets();

      return () => controller.abort();
    }, [enabled, signedInFid]);

    const handleToggle = useCallback(() => {
      if (enabled) {
        // Disable: clear storage
        setEnabled(false);
        clearStoredFiddy3DFid();
        setHasAssets(null);
      } else {
        // Enable: store signed-in FID
        setStoredFiddy3DFid(signedInFid);
        setEnabled(true);
      }
    }, [enabled, signedInFid]);

    if (!isOwnProfile) {
      return null;
    }

    return (
      <div className="mt-4 rounded-lg border bg-card p-4 border-default">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-default">
              Fiddy 3D (beta)
            </h3>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={enabled}
                onChange={handleToggle}
                className="peer sr-only"
              />
              <div className="peer h-5 w-9 rounded-full bg-gray-300 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white dark:bg-gray-600 dark:after:bg-white" />
            </label>
          </div>

          {enabled && (
            <div className="text-xs">
              {hasAssets === null && (
                <span className="text-gray-500">Checking for your 3D...</span>
              )}
              {hasAssets === true && (
                <span className="text-green-600">✓ 3D avatar found</span>
              )}
              {hasAssets === false && (
                <span className="text-yellow-600">
                  No 3D found.{' '}
                  <ExternalLink
                    href={FIDDY_3D_CREATE_URL}
                    className="text-purple-600 hover:underline"
                  >
                    Create yours →
                  </ExternalLink>
                </span>
              )}
            </div>
          )}

          {!enabled && (
            <ExternalLink
              href={FIDDY_3D_CREATE_URL}
              className="text-xs text-purple-600 hover:underline"
            >
              Get your chibi figure →
            </ExternalLink>
          )}
        </div>
      </div>
    );
  },
);

ProfileFiddy3DSettings.displayName = 'ProfileFiddy3DSettings';

export { ProfileFiddy3DSettings };
export type { ProfileFiddy3DSettingsProps };
