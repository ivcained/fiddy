/**
 * The hero Fiddy, on the page a visitor meets first.
 *
 * Four rules, the same four the chrome's mark keeps, in the same order:
 *
 *   1. The still paints first, always. The stage is never an empty box: the
 *      still is a PNG of this model's own front view, rendered at commit time in
 *      the same lighting the live canvas uses, so what arrives is a Fiddy and
 *      not a placeholder.
 *   2. The box exists before the model does. Its size comes from CSS and is
 *      identical before and after, so the model's arrival moves nothing on the
 *      page — the thing a hero is most likely to wreck.
 *   3. Motion is asked for, not assumed. Under `prefers-reduced-motion: reduce`
 *      the model is never fetched: the turn is decoration, and a reader who
 *      asked for stillness should not pay for it in bytes either.
 *   4. Anything that goes wrong — no WebGL, a missing file, a parse failure —
 *      leaves the still in place and says nothing.
 *
 * What is different from the mark is that this one can be turned by hand: on the
 * front door the pointer drags the model around and the turntable waits for it
 * to let go. The small variant beside a form does not take the pointer at all —
 * a canvas that eats a tap meant for the input next to it is a bug, not a toy.
 *
 * `data-fiddy-hero` reports which state is on screen (`still` or `moving`), so a
 * probe can assert it instead of guessing from pixels.
 */

import React, { memo, useEffect, useRef, useState } from 'react';

import {
  FIDDY_HERO_MODEL,
  FIDDY_HERO_PADDING,
  FIDDY_HERO_POSTER,
  FIDDY_HERO_RESUME_MS,
  FIDDY_HERO_TURN_RADIANS_PER_SECOND,
  heroMotionAllowed,
} from './fiddyHero';

/** Long enough that the front door is painted and readable first. */
const AFTER_FIRST_PAINT_MS = 320;

/**
 * How the camera sits on the hero. It looks slightly down on the model from
 * a little to the right, so the face is three-quarter rather than dead-on —
 * the shot the still is rendered from, and the one the turntable starts on.
 */
const HERO_VIEW: [number, number, number] = [0.34, 0.2, 1];

export interface FiddyHeroStageProps {
  /**
   * `hero` is the front door's stage: big, and turnable by hand. `form` is the
   * small one that sits beside a field while you type a name.
   */
  variant?: 'hero' | 'form';
}

const FiddyHeroStage = memo<FiddyHeroStageProps>(({ variant = 'hero' }) => {
  const host = useRef<HTMLSpanElement>(null);
  const mounted = useRef<{ dispose(): void } | null>(null);
  const [moving, setMoving] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);

  // Rule 3, read before anything is fetched. `null` (no matchMedia) counts as
  // allowed: an absence of the preference is not a request for stillness.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(heroMotionAllowed(query.matches));
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!motionAllowed) {
      setMoving(false);
      return;
    }

    const controller = new AbortController();
    // The `import()` is the point: three.js is a chunk of its own, shared with
    // the chrome's mark, fetched here and never as part of the first paint.
    const timer = window.setTimeout(() => {
      void import('./fiddyModelScene')
        .then(({ mountFiddyModel }) => {
          if (controller.signal.aborted || !host.current) {
            return undefined;
          }
          return mountFiddyModel(host.current, controller.signal, {
            model: FIDDY_HERO_MODEL,
            // A still file: no rig, no clips. It is turned, not animated.
            turntable: FIDDY_HERO_TURN_RADIANS_PER_SECOND,
            draggable: variant === 'hero',
            resumeAfterMs: FIDDY_HERO_RESUME_MS,
            view: HERO_VIEW,
            padding: FIDDY_HERO_PADDING,
          });
        })
        .then((scene) => {
          if (!scene) {
            return;
          }
          if (controller.signal.aborted) {
            scene.dispose();
            return;
          }
          mounted.current = scene;
          setMoving(true);
        })
        .catch(() => {
          // Rule 4: the still is the whole hero in that case, and the reader is
          // not told about a mascot's plumbing.
        });
    }, AFTER_FIRST_PAINT_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      mounted.current?.dispose();
      mounted.current = null;
    };
  }, [motionAllowed, variant]);

  return (
    <span
      className={`fiddy-hero-stage fiddy-hero-stage-${variant}`}
      data-fiddy-hero={moving ? 'moving' : 'still'}
      data-fiddy-hero-variant={variant}
      aria-hidden="true"
    >
      {/* Rule 1, and rule 2 with it: the still is an <img> with real dimensions
          inside a box CSS has already sized, so nothing below it moves when the
          canvas takes over. */}
      <img
        className="fiddy-hero-stage-still"
        src={FIDDY_HERO_POSTER}
        alt=""
        decoding="async"
      />
      <span className="fiddy-hero-stage-canvas" ref={host} />
    </span>
  );
});

FiddyHeroStage.displayName = 'FiddyHeroStage';

export { FiddyHeroStage };
