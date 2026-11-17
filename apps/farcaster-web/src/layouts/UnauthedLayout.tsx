import { FC } from 'react';

import { PublicMiniAppWindowHost } from '~/components/miniApp/PublicMiniAppWindowHost';
import { routes } from '~/constants/routes';
import { useIsCurrentRoute } from '~/hooks/navigation/useIsCurrentRoute';
import { Container } from '~/layouts/Container';
import { MainContent } from '~/layouts/MainContent';
import { UnauthedLeftSideBar } from '~/layouts/UnauthedLeftSideBar';
import { UnauthedRightSideBar } from '~/layouts/UnauthedRightSideBar';

const UnauthedLayout: FC = () => {
  const hideChromesOnDownload = useIsCurrentRoute(routes.download);
  const hideChromesOnSignup = useIsCurrentRoute(routes.signup);
  const hideChromesOnRoute = hideChromesOnDownload || hideChromesOnSignup;

  return (
    <Container>
      {!hideChromesOnRoute && <UnauthedLeftSideBar />}
      <MainContent />
      {!hideChromesOnRoute && <UnauthedRightSideBar />}
      {/* The public shell's mini app window — see the component for why it
          cannot be the authed shell's host. Fixed-positioned, so it renders
          the same on every breakpoint including the phone. */}
      <PublicMiniAppWindowHost />
    </Container>
  );
};

export { UnauthedLayout };
