/**
 * The hero Fiddy, as assets and as one rule about when it may move.
 *
 * This is the owner's vinyl-toy mascot (`fiddy-hero.glb`, 25,611 triangles, one
 * mesh, three WebP textures baked in), and it is a different file from the baby
 * mark in the chrome on purpose: the mark is a 5s loop authored for a 36px slot,
 * this one is a still figure with no rig and no clips, so it is drawn by turning
 * it rather than by playing something. Both are drawn by the same scene module
 * (`~/components/fiddy/fiddyModelScene`) — one three.js setup for the whole app.
 *
 * The still (`fiddy-hero-poster.png`) is one frame of this GLB, rendered by
 * `scripts/render-hero-poster.mjs` at commit time in the same lighting the live
 * canvas uses. It is what paints before the model arrives, under reduced motion,
 * and forever on a browser without WebGL — so no visitor ever meets an empty box
 * where the mascot should be.
 */
export const FIDDY_HERO_MODEL = '/fiddy-hero.glb';

/** One frame of `fiddy-hero.glb`, drawn on a transparent background. */
export const FIDDY_HERO_POSTER = '/fiddy-hero-poster.png';

/**
 * How tight the camera is on the model, as a share of the distance that would
 * fit the model's whole bounding sphere: 0.85 fills the stage with the figure
 * while still leaving room for the straight-on and the side views, which are the
 * two the turntable spends most of its time between. `scripts/render-hero-poster.mjs`
 * carries the same number, and `verify-fiddy-hero.mjs` measures the still it
 * writes against the live canvas — so the two cannot drift apart quietly.
 */
export const FIDDY_HERO_PADDING = 0.85;

/**
 * Slow enough to read as breathing rather than spinning: one turn takes about
 * 25 seconds. A hero that whips around pulls the eye off the sentence under it.
 */
export const FIDDY_HERO_TURN_RADIANS_PER_SECOND = 0.25;

/**
 * After a drag the turntable waits this long before taking the wheel back, so a
 * visitor who has just posed the model is not fought for it. Measured from the
 * last pointer move, not from the release.
 */
export const FIDDY_HERO_RESUME_MS = 1800;

/**
 * May the hero move?
 *
 * Read before anything is fetched, so a reader who asked for stillness never
 * downloads the model at all. `null` means the browser could not tell us, which
 * is not a reason to deny motion — it is a reason to animate, as everyone else
 * does. Deliberately the same one rule the chrome's mark obeys, from the same
 * place: a second implementation of "is this reader asking for stillness?" is a
 * second answer waiting to disagree.
 */
export { markMotionAllowed as heroMotionAllowed } from './fiddyMark';
