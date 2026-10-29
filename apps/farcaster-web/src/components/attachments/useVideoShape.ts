import { useSyncExternalStore } from 'react';

import {
  defaultVideoShapeStore,
  resolveVideoShape,
  type VideoShape,
} from '~/components/attachments/videoShape';

const serverRevision = (): number => 0;

/** Re-render the existing cast layout when any rendered embed learns its shape. */
export const useVideoShapeRevision = (): number =>
  useSyncExternalStore(
    defaultVideoShapeStore.subscribe,
    defaultVideoShapeStore.revision,
    serverRevision,
  );

/** Provider dimensions first; otherwise the shape learned for THIS video URL. */
export const useResolvedVideoShape = (
  url: string,
  width?: number,
  height?: number,
): VideoShape | null => {
  useVideoShapeRevision();
  return resolveVideoShape({ url, width, height });
};
