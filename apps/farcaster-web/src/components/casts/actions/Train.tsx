import { useCreateCast } from 'farcaster-client-hooks';
import { FC, memo, useCallback, useState } from 'react';

import { CastReactionAction } from '~/components/casts/actions/CastReactionAction';
import { CastActionProps } from '~/components/casts/actions/types';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { isTrain, TRAIN_URL } from '~/utils/cast/TrainCasts';

/** A locomotive from the front: train casts. */
const TrainIcon: FC = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path
      d="M4 2h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM2 10h14M10 2v7M6 14h.01M12 14h.01M7 16l-2 2M11 16l2 2"
      className="fill-tertiary"
    />
  </svg>
);

const Train: FC<CastActionProps> = memo(
  ({ cast, isFocused, disabled, includeReason: _includeReason }) => {
    const isSignedIn = useIsSignedIn();
    const currentUser = useCurrentUser();
    const createCast = useCreateCast();
    const [boarding, setBoarding] = useState(false);

    const board = useCallback(async () => {
      if (!isSignedIn || !currentUser) {
        return;
      }
      setBoarding(true);
      try {
        await createCast({
          fid: currentUser.fid,
          castText: cast.text,
          embeds: [cast.hash, TRAIN_URL],
        });
      } finally {
        setBoarding(false);
      }
    }, [cast, currentUser, isSignedIn, createCast]);

    if (!isSignedIn) {
      return null;
    }
    // only show for train-tagged casts
    if (!isTrain(cast)) {
      return null;
    }

    return (
      <CastReactionAction
        icon={<TrainIcon />}
        count={0}
        isActive={false}
        isFocused={!!isFocused}
        variant="purple"
        disabled={!currentUser || disabled || boarding}
        onClick={board}
      />
    );
  },
);

Train.displayName = 'Train';

export { Train };
