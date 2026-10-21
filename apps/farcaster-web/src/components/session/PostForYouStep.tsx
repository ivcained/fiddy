/**
 * "Let Fiddy post as you?" — the one-time offer, made where the reader is.
 *
 * MEASURED (2026-10-21, the live client, signed in, before this card): pressing
 * Cast without a pass on this device answers with a sentence that sends the
 * reader to Advanced → their setup → "Issue app key". That is true and it stays
 * true; it is just not where a reader is standing when they find out.
 *
 * This card is that sentence, offered once, in the shell, right after sign-in,
 * with the setup one press away:
 *
 *   - it says what Fiddy may do with the pass (post, like, follow, edit
 *     profile), where it lives (this browser), and what it costs to set up
 *     (the account's seed phrase) — in plain words, no protocol vocabulary;
 *   - "Set it up" opens the SAME blocking warning and phrase step Advanced
 *     ships (`SeedPhraseWarningModal`: test account only, checkbox, cannot be
 *     dismissed without acknowledging) and issues the pass through the same
 *     call;
 *   - "Not now" is remembered on the device, so the offer is made once and then
 *     leaves the reader alone.
 *
 * It renders nothing at all when the offer does not apply — a session a server
 * can serve, no server named, an account this device already has a pass for, or
 * a reader who already said not now.
 */

import React, { FC, lazy, memo, Suspense } from 'react';

import { SETUP_STEP_COPY } from './postForYouOffer';
import { usePostForYou } from './usePostForYou';

/**
 * The warning + phrase step is Advanced's own screen, and the repository's lint
 * rule is that page components are reached lazily (`~/pages/*` may not be
 * imported statically) — which is also the right shape here: a reader who never
 * presses "Set it up" never downloads it.
 */
const SeedPhraseWarningModal = lazy(async () => {
  const module =
    await import('~/pages/settingsNode/Component/SeedPhraseWarningModal');
  return { default: module.SeedPhraseWarningModal };
});

const CARD_CLASS =
  'fixed bottom-20 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-xl bg-app border-default sm:bottom-6';

const PostForYouStep: FC = memo(() => {
  const {
    decision,
    phase,
    step,
    error,
    offer,
    closePhraseStep,
    sayNotNow,
    setUp,
  } = usePostForYou();

  const cardIsUp = decision.kind === 'offered' || phase !== 'idle';

  if (!cardIsUp) {
    return null;
  }

  return (
    <aside aria-label="Let Fiddy post as you" data-fiddy="post-for-you">
      {phase === 'idle' && decision.kind === 'offered' ? (
        <div className={CARD_CLASS}>
          <h2
            id="fiddy-post-for-you-heading"
            className="mb-2 text-base font-bold text-primary"
          >
            Let Fiddy post as you?
          </h2>
          <div className="mb-3 text-sm text-primary">
            <p className="mb-2">
              Fiddy can post, reply, like and follow for you. Those are signed
              here, on this device, so nothing that can post as you is ever held
              by a server.
            </p>
            <p className="text-muted">
              Setting it up asks for your account&rsquo;s seed phrase once. Use
              a test account, never your main one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={offer}
              data-fiddy="post-for-you-set-up"
              className="rounded border px-3 py-1.5 text-sm font-semibold text-primary bg-tertiary border-default"
            >
              Set it up
            </button>
            <button
              type="button"
              onClick={sayNotNow}
              data-fiddy="post-for-you-not-now"
              className="rounded px-3 py-1.5 text-sm text-muted"
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'setting-up' ? (
        <div className={CARD_CLASS} role="status">
          <p className="text-sm text-primary" data-fiddy="post-for-you-step">
            {step === null
              ? 'Setting this up…'
              : (SETUP_STEP_COPY[step] ?? 'Setting this up…')}
          </p>
        </div>
      ) : null}

      {phase === 'done' ? (
        <div className={CARD_CLASS} role="status">
          <p className="text-sm text-primary" data-fiddy="post-for-you-done">
            Done — Fiddy can post as you on this device.
          </p>
        </div>
      ) : null}

      {phase === 'failed' ? (
        <div className={CARD_CLASS}>
          <h2 className="mb-2 text-base font-bold text-danger">
            That didn&rsquo;t go through
          </h2>
          <p
            className="mb-3 text-sm text-primary"
            data-fiddy="post-for-you-error"
          >
            {error}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={offer}
              className="rounded border px-3 py-1.5 text-sm font-semibold text-primary bg-tertiary border-default"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={closePhraseStep}
              className="rounded px-3 py-1.5 text-sm text-muted"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {/* The warning and the phrase step are Advanced's own screen, unchanged:
          acknowledged by checkbox, not dismissible by accident, phrase cleared
          on close. */}
      {phase === 'asking-for-phrase' ? (
        <Suspense fallback={null}>
          <SeedPhraseWarningModal
            onClose={closePhraseStep}
            onConfirm={setUp}
            loading={false}
          />
        </Suspense>
      ) : null}
    </aside>
  );
});

PostForYouStep.displayName = 'PostForYouStep';

export { PostForYouStep };
