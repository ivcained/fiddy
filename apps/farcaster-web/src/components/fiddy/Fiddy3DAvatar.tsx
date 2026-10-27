/**
 * The Fiddy 3D avatar for profile display — shows an animated GIF PFP when
 * a Fiddy 3D generation exists, or falls back to normal Farester PFP.
 *
 * Three rules, in this order:
 *
 *   1. The still paints first, always. The avatar is never empty, and it is
 *      never the reason the profile waits — the static thumbnail is fetched
 *      first and is a real placeholder.
 *   2. Motion is asked for, not assumed. Under `prefers-reduced-motion: reduce`
 *      the GIF is never fetched: reduce user bandwidth and respect preference.
 *   3. Anything that goes wrong — fetch failure, bad data, no generation —
 *      leaves the fallback (normal PFP) in place silently.
 */

import { FC, memo, useEffect, useRef, useState } from 'react';

import { fiddy3DAssetUrl, fiddy3DMotionAllowed } from './fiddy3DProfile';

export type Fiddy3DAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xl2';

const SIZE_PIXELS: Record<Fiddy3DAvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 80,
  xl: 120,
  xl2: 160,
};

interface Fiddy3DAvatarProps {
  /** The FID to show 3D assets for. */
  fid: number;
  /** Display name for alt text. */
  displayName: string;
  /** Normal PFP URL to fall back to. */
  fallbackPfpUrl?: string;
  /** Size preset matching Avatar component. */
  size?: Fiddy3DAvatarSize;
  /** Additional CSS classes. */
  className?: string;
  /** Callback when 3D assets fail to load. */
  onError?: () => void;
  /** Callback when 3D assets successfully load. */
  onLoad?: () => void;
}

/**
 * Check if an image URL points to a real image (not an error page).
 * Uses HEAD to fetch headers and verifies content-type.
 */
const probeImage = async (
  url: string,
  signal: AbortSignal,
): Promise<boolean> => {
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get('content-type') ?? '';
    // Accept common image types, reject HTML (error pages like 404)
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
};

const Fiddy3DAvatar: FC<Fiddy3DAvatarProps> = memo(
  ({
    fid,
    displayName,
    fallbackPfpUrl,
    size = 'xl2',
    className = '',
    onError,
    onLoad,
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [has3D, setHas3D] = useState(false);
    const [motionAllowed, setMotionAllowed] = useState(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const targetSize = SIZE_PIXELS[size];
    const gifUrl = fiddy3DAssetUrl(fid, 'turntable.gif');
    const thumbnailUrl = fiddy3DAssetUrl(fid, 'thumbnail.png');

    // Rule 2: Check reduced motion preference BEFORE fetching
    useEffect(() => {
      setMotionAllowed(fiddy3DMotionAllowed());
    }, []);

    // Probe for 3D assets and decide which to use
    useEffect(() => {
      const controller = new AbortController();
      let disposed = false;

      const checkAssets = async () => {
        // Always load thumbnail first as a fast probe
        const thumbnailExists = await probeImage(
          thumbnailUrl,
          controller.signal,
        );
        if (disposed) {
          return;
        }

        if (!thumbnailExists) {
          setLoading(false);
          return;
        }

        // Thumbnail exists — determine what to show based on motion preference
        if (!motionAllowed) {
          // Reduced motion - use static thumbnail
          setHas3D(true);
        } else {
          // Free to show animated GIF
          const gifExists = await probeImage(gifUrl, controller.signal);
          if (disposed) {
            return;
          }
          setHas3D(gifExists && thumbnailExists);
        }

        setLoading(false);
      };

      checkAssets();

      return () => {
        disposed = true;
        controller.abort();
      };
    }, [gifUrl, thumbnailUrl, motionAllowed]);

    // Handle error callback
    useEffect(() => {
      if (error && onError) {
        onError();
      }
    }, [error, onError]);

    // Handle load callback
    useEffect(() => {
      if (!loading && has3D && !error && onLoad) {
        onLoad();
      }
    }, [loading, has3D, error, onLoad]);

    const handleError = () => {
      setError(true);
      if (onError) {
        onError();
      }
    };

    const handleLoad = () => {
      if (onLoad) {
        onLoad();
      }
    };

    // Determine which image to show
    const show3D = has3D && !loading && !error;
    const showThumbnail = !show3D && has3D && !loading && !error;
    const showFallback = !has3D || loading || error;

    return (
      <div
        ref={containerRef}
        className={`relative overflow-hidden rounded-full ${className}`}
        style={{ width: targetSize, height: targetSize }}
        role="img"
        aria-label={
          show3D ? `${displayName}'s Fiddy 3D avatar` : `${displayName} avatar`
        }
      >
        {/* Priority: 3D GIF (animated) - only when motion is allowed */}
        {show3D && motionAllowed && (
          <img
            src={gifUrl}
            alt=""
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
            onError={handleError}
            onLoad={handleLoad}
          />
        )}

        {/* Priority: Static thumbnail (reduced motion) */}
        {showThumbnail && !motionAllowed && (
          <img
            src={thumbnailUrl}
            alt=""
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
            onError={handleError}
            onLoad={handleLoad}
          />
        )}

        {/* Fallback: Normal PFP */}
        {showFallback && fallbackPfpUrl && (
          <img
            src={fallbackPfpUrl}
            alt={`${displayName} avatar`}
            width={targetSize}
            height={targetSize}
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )}

        {/* Loading state - show fallback or placeholder */}
        {loading && !fallbackPfpUrl && (
          <div
            className="size-full animate-pulse bg-light-purple"
            style={{ width: targetSize, height: targetSize }}
          />
        )}
      </div>
    );
  },
);

Fiddy3DAvatar.displayName = 'Fiddy3DAvatar';

export { Fiddy3DAvatar };
export type { Fiddy3DAvatarProps };
