import { FC, memo, useState } from 'react';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { LoginWithMobile } from '~/components/login/LoginWithMobile';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';

type LoginModalProps = {
  onClose: () => void;
};

const LoginModal: FC<LoginModalProps> = memo(({ onClose }) => {
  /**
   * Making an account, from the same door as signing in to one.
   *
   * These are the two halves of "I want to be on Farcaster": one is for people
   * who already have an account, one for people who do not. Putting the second
   * behind the first — or behind a different screen nobody finds — is how a
   * client ends up only usable by people who were already users.
   */
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  if (isCreatingAccount) {
    return <CreateAccountSheet onClose={() => setIsCreatingAccount(false)} />;
  }

  return (
    <Modal>
      <DefaultModalContainer onClose={onClose}>
        <div className="flex size-full flex-col items-center justify-center p-4">
          <div
            className="relative flex w-full max-w-md flex-col items-start justify-center rounded-[12px] bg-[#141414] p-4"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <LoginWithMobile onClose={onClose} />
            <button
              type="button"
              className="fiddy-quiet-btn mt-3 self-center"
              data-fiddy="create-account-entry"
              onClick={() => setIsCreatingAccount(true)}
            >
              New to Farcaster? Make an account
            </button>
          </div>
        </div>
      </DefaultModalContainer>
    </Modal>
  );
});

LoginModal.displayName = 'LoginModal';

export { LoginModal };
