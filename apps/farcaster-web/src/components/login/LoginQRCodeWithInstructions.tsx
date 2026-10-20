import classNames from 'classnames';
import { FC, memo } from 'react';

import { LoginQRCode } from '~/lazy/components';

type LoginQRCodeWithInstructionsProps = {
  /** The SIWF relay URL — the thing the phone actually opens. */
  url: string;
  onClose: () => void;
  /** True once the phone has approved and we are finalising the session. */
  attemptingLogin: boolean;
  /** Shown under the code when the scan drags, before the hard timeout. */
  slow?: boolean;
};

const LoginQRCodeWithInstructions: FC<LoginQRCodeWithInstructionsProps> = memo(
  ({ url, onClose, attemptingLogin, slow }) => {
    return (
      <>
        <div className="flex flex-col space-y-3 p-8 sm:items-start">
          <div className="flex w-full flex-row justify-around">
            <div
              className={classNames(
                'relative mt-2 flex justify-around sm:mt-0',
                attemptingLogin && 'animate-pulse',
              )}
            >
              <LoginQRCode url={url} />
            </div>
          </div>
          <h3 className="font-seasonMix text-3xl font-semibold text-light">
            {attemptingLogin ? 'Signing you in' : 'Log in with mobile'}
          </h3>
          <div className="text-light">
            {attemptingLogin
              ? 'Approved on your phone — finishing up here.'
              : 'Open the Farcaster app on your phone and scan this code, or scan it with your Camera app.'}
          </div>
          {slow && !attemptingLogin ? (
            <div className="text-sm text-muted">
              Still waiting. Make sure the Farcaster app is the app that opened,
              then approve the request there.
            </div>
          ) : null}
          <div
            className="landing-btn-secondary-bg flex w-full cursor-pointer items-center justify-center rounded-[300px] px-[36px] py-[10px]"
            onClick={onClose}
          >
            <div className="text-[16px] text-light">Cancel</div>
          </div>
        </div>
      </>
    );
  },
);

LoginQRCodeWithInstructions.displayName = 'LoginQRCodeWithInstructions';

export { LoginQRCodeWithInstructions };
