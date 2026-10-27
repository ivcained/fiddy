/**
 * Profile edit component that allows users to enable Fiddy 3D on their
 * own profile. Only shown to the signed-in user for their own profile.
 * Uses local storage to remember the setting — no server claim.
 */

import { FC, memo, useCallback, useEffect, useState } from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';

import {
  clearStoredFiddy3DFid,
  FIDDY_3D_CREATE_URL,
  fiddy3DAssetUrl,
  getStoredFiddy3DFid,
  setStoredFiddy3DFid,
  validateFiddy3DUrl,
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
    const [linkedFid, setLinkedFid] = useState<number | null>(null);
    const [urlInput, setUrlInput] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Load stored preference on mount
    useEffect(() => {
      if (!isOwnProfile) {
        return;
      }
      const stored = getStoredFiddy3DFid();
      if (stored) {
        setLinkedFid(stored);
        setEnabled(true);
      }
    }, [isOwnProfile]);

    // Check if the linked FID has assets (probe the thumbnail)
    const [hasAssets, setHasAssets] = useState<boolean | null>(null);

    useEffect(() => {
      if (!linkedFid) {
        setHasAssets(null);
        return;
      }

      const controller = new AbortController();
      const checkAssets = async () => {
        try {
          const thumbnailUrl = fiddy3DAssetUrl(linkedFid, 'thumbnail.jpg');
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
    }, [linkedFid]);

    const handleEnable = useCallback(() => {
      setError(null);
      // If there's no URL input, ask user to visit fiddy.fun first
      if (!urlInput.trim()) {
        // Just enable with their own FID as default
        setLinkedFid(signedInFid);
        setStoredFiddy3DFid(signedInFid);
        setEnabled(true);
        return;
      }

      // Validate the input URL
      const validation = validateFiddy3DUrl(urlInput);
      if (!validation.valid) {
        setError('Invalid URL. Use a fiddy.fun/3d/ link.');
        return;
      }

      setLinkedFid(validation.fid);
      setStoredFiddy3DFid(validation.fid);
      setEnabled(true);
      setUrlInput('');
    }, [signedInFid, urlInput]);

    const handleDisable = useCallback(() => {
      setEnabled(false);
      clearStoredFiddy3DFid();
      setLinkedFid(null);
      setHasAssets(null);
    }, []);

    const handleUrlChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        setUrlInput(e.target.value);
        setError(null);
      },
      [],
    );

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
                onChange={(e) => {
                  if (e.target.checked) {
                    handleEnable();
                  } else {
                    handleDisable();
                  }
                }}
                className="peer sr-only"
              />
              <div className="peer h-5 w-9 rounded-full bg-gray-300 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white dark:bg-gray-600 dark:after:bg-white" />
            </label>
          </div>

          {enabled && (
            <>
              {/* Status indicator */}
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

              {/* URL input for linking a different FID */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-500">
                  Link a different FID (optional):
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={urlInput}
                    onChange={handleUrlChange}
                    placeholder="https://fiddy.fun/3d/..."
                    className="flex-1 rounded border bg-background px-2 py-1 text-sm border-default text-default placeholder:text-gray-400 focus:border-purple-500 focus:outline-none"
                  />
                  <button
                    onClick={handleEnable}
                    className="rounded bg-purple-600 px-3 py-1 text-sm text-white hover:bg-purple-700"
                  >
                    Link
                  </button>
                </div>
                {error && <span className="text-xs text-red-500">{error}</span>}
              </div>
            </>
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
