import { lazyWithPreload, PreloadableComponent } from './helpers';
type ComposerComponent =
  typeof import('~/components/composer/Composer').Composer;

export const LoginQRCode = lazyWithPreload(() =>
  import('~/components/login/LoginQRCode').then((res) => ({
    default: res.LoginQRCode,
  })),
);

export const Composer: PreloadableComponent<ComposerComponent> =
  lazyWithPreload(() =>
    import('~/components/composer/Composer').then((res) => ({
      default: res.Composer,
    })),
  );

// Frames v1 deprecated: FarcasterFrameAttachment removed

export const PayUserDialog = lazyWithPreload(() =>
  import('~/components/payUser/PayUserDialog').then((res) => ({
    default: res.PayUserDialog,
  })),
);

/* A sealed cast in a feed, and a key someone shared in one: both are rare enough
   that their code (crypto, envelope reading) is imported the moment one appears,
   not with the bundle. */
export const SealedCastView = lazyWithPreload(() =>
  import('~/components/sealed/SealedCastView').then((res) => ({
    default: res.SealedCastView,
  })),
);

export const SealedKeyNotice = lazyWithPreload(() =>
  import('~/components/sealed/SealedKeyNotice').then((res) => ({
    default: res.SealedKeyNotice,
  })),
);
