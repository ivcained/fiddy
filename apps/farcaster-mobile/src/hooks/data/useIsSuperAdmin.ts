import { useMemo } from 'react';

import { useCurrentUser_UNSAFE } from './useCurrentUser';

// Typed: `new Set([])` infers `Set<never>`, so `has(fid)` was a type error and
// the mobile typecheck gate could not pass on a clean checkout.
const superAdminFids = new Set<number>([]);

const useIsSuperAdmin = () => {
  const { fid } = useCurrentUser_UNSAFE();

  return useMemo(() => superAdminFids.has(fid), [fid]);
};

export { useIsSuperAdmin };
