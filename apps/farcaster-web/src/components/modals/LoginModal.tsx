import { FC, memo, useState } from 'react';

import { CreateAccountSheet } from '~/components/fiddy/accounts/CreateAccountSheet';
import { Link } from '~/components/links/Link';
import { LoginWithMobile } from '~/components/login/LoginWithMobile';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { Modal } from '~/components/modals/Modal';

type LoginModalProps = {
  onClose: () => void;
};

/**
 * The way in, with every door in one column.
 *
 * Sign in with Farcaster is the QR handshake: it proves who you are and lets
 * Fiddy *read*. Under it sit the two ways to end up with an account Fiddy can
 * also *post* from, each its own block so neither becomes the only door:
 *
 *   - connecting an account you already have (`routes.fiddyConnect`): one tap,
 *     no fee, no phrase — the posting key is granted in your own Farcaster app,
 *     and you can take it back there;
 *   - making a new account here (`CreateAccountSheet`): a brand-new FID, a
 *     registration fee you pay, and a recovery phrase you write down.
 *
 * They are different products with different trades, so they get different
 * sentences, and neither pretends to be the other.
 */
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

            {/* Already on Farcaster: let Fiddy post for you as well as read.
                Its own block and its own page, with a link rather than a mode
                switch, because the approving happens in the person's own
                Farcaster app. */}
            <div
              className="mt-4 w-full border-t border-[#2a2a2a] pt-4 text-center"
              data-fiddy="connect-door"
            >
              <Link
                to="fiddyConnect"
                params={{}}
                searchParams={{}}
                title="Connect your Farcaster account"
                className="text-sm font-semibold text-[#d4ff3f] underline underline-offset-4"
                onClick={onClose}
              >
                Already on Farcaster? Let Fiddy post for you
              </Link>
              <p className="mt-1 text-xs text-[#9ba193]">
                No fee, no passphrase — you approve it in your Farcaster app.
              </p>
            </div>

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