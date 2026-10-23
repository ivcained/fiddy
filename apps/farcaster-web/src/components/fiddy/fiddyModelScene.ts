/**
 * The one scene in this app that touches three.js, and it is reached by
 * `import()` so the library is a chunk of its own, fetched after the shell has
 * painted. Two callers share it — the 36px mark in the chrome and the hero on
 * the front door — because a second three.js setup would be a second renderer,
 * a second GLTFLoader config and a second set of GPU contexts to leak.
 *
 * Deliberately minimal, and deliberately the same rules for both callers:
 *   - matte outline shells render BackSide (the black-model lesson),
 *   - a clip loops seamlessly, a still model is turned by the camera instead,
 *   - everything is disposed with an explicit context loss, so a top bar that
 *     unmounts or a route that changes does not leak a GPU context,
 *   - nothing renders while the tab is hidden,
 *   - the model is framed on its own bounds, so one shot is correct for any
 *     model without anyone hand-tuning a camera per asset.
 */

import {
  AnimationMixer,
  BackSide,
  Box3,
  Clock,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoopRepeat,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { FIDDY_MARK_CLIP, FIDDY_MARK_MODEL } from './fiddyMark';

/** A live model on screen. Call `dispose` to take it down for good. */
export interface MountedModel {
  dispose(): void;
}

export interface ModelSceneOptions {
  /** The GLB, from the site root. */
  model: string;
  /**
   * The clip to play, looped. Named rather than "first one" so a model that
   * grows a second clip does not silently start playing a different one.
   * Absent means the file is a still, which is the hero's case.
   */
  clip?: string;
  /** Extra azimuth per second while no pointer is on the model. 0 = still. */
  turntable?: number;
  /**
   * Let a pointer set the azimuth. Off for a model that sits beside a form: a
   * canvas that eats a tap meant for the input next to it is a bug, not a toy.
   */
  draggable?: boolean;
  /** Wait this long after the last drag before the turntable resumes. */
  resumeAfterMs?: number;
  /** Vertical field of view, in degrees. */
  fov?: number;
  /**
   * Where the camera sits, as a direction in the model's own frame — the model
   * is not rotated to face it, the camera moves. One shot per asset: the hero
   * looks up at the face a little, the mark is seen straight on.
   */
  view?: [number, number, number];
  /** Multiplies the framing distance. 1 is tight to the model's bounds. */
  padding?: number;
}

/**
 * The mark's shot, unchanged: same camera direction, same fov, same clip.
 *
 * It lives here rather than in the caller so that the still the chrome paints
 * first (`fiddy-mark-poster.png`, one frame of this GLB) and the model that
 * replaces it are framed by the same numbers — which is why the swap does not
 * jump.
 */
export const FIDDY_MARK_PRESET: ModelSceneOptions = {
  model: FIDDY_MARK_MODEL,
  clip: FIDDY_MARK_CLIP,
  fov: 34,
  view: [0.5, 0.32, 1],
  padding: 1,
};

const DEFAULT_FOV = 34;
const DEFAULT_VIEW: [number, number, number] = [0.5, 0.32, 1];

/**
 * Draw `options.model` into `host` and keep drawing it until `signal` aborts.
 *
 * Throws if the model cannot be fetched, parsed or drawn — the caller keeps its
 * still in that case, because a model that cannot move is still the model.
 */
export const mountFiddyModel = async (
  host: HTMLElement,
  signal: AbortSignal,
  options: ModelSceneOptions,
): Promise<MountedModel | undefined> => {
  if (signal.aborted || !host.clientWidth) {
    return undefined;
  }

  const size = host.clientWidth;
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size);
  renderer.setClearAlpha(0);
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(options.fov ?? DEFAULT_FOV, 1, 0.1, 50);
  scene.add(new HemisphereLight(0xfff6e8, 0x22231f, 1.1));
  const sun = new DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  let mixer: AnimationMixer | null = null;
  const clock = new Clock();
  let frame = 0;
  let disposed = false;
  /** Radians of orbit the turntable has drawn so far. */
  let spin = 0;
  /** Radians the visitor has dragged on top of the turntable. */
  let drag = 0;
  let dragging = false;
  let lastPointerX = 0;
  /** Wall-clock ms after which the turntable may turn again. */
  let resumeAt = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (!options.draggable) {
      return;
    }
    dragging = true;
    lastPointerX = event.clientX;
    // Capture so a drag that leaves the box keeps arriving here, and so the
    // page underneath does not start a text selection mid-turn.
    host.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    drag += (event.clientX - lastPointerX) * 0.01;
    lastPointerX = event.clientX;
    resumeAt = performance.now() + (options.resumeAfterMs ?? 0);
  };

  const endDrag = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    host.releasePointerCapture?.(event.pointerId);
    resumeAt = performance.now() + (options.resumeAfterMs ?? 0);
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelAnimationFrame(frame);
    mixer?.stopAllAction();
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', endDrag);
    host.removeEventListener('pointercancel', endDrag);
    renderer.dispose();
    // An explicit context loss: a browser keeps only a handful of live WebGL
    // contexts, and these live in chrome that mounts on every route.
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  };
  signal.addEventListener('abort', dispose);

  try {
    const response = await fetch(options.model, { signal });
    if (!response.ok) {
      throw new Error(`model missing: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (signal.aborted) {
      dispose();
      return undefined;
    }

    const model = gltf.scene as Group;
    scene.add(model);

    model.traverse((child) => {
      const mesh = child as { material?: { name?: string; side?: number } };
      if (mesh.material?.name === 'ToonOutline') {
        mesh.material.side = BackSide;
      }
    });

    // Frame the model's own bounds — the same shot its still was captured from,
    // so the swap from still to moving does not jump.
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());
    const sphere = bounds.getBoundingSphere(new Sphere());
    const fov = (camera.fov * Math.PI) / 180;
    const view = options.view ?? DEFAULT_VIEW;
    const distance =
      (sphere.radius / Math.sin(fov / 2)) * (options.padding ?? 1);

    // The camera sits on a circle around the model's own vertical axis, at the
    // azimuth `view` names and the height it names. At zero orbit this is
    // exactly `view * distance + center`, which is the shot every still of
    // these models was rendered from.
    const viewLength = Math.hypot(...view);
    const orbitRadius = (distance * Math.hypot(view[0], view[2])) / viewLength;
    const orbitHeight = center.y + (distance * view[1]) / viewLength;
    const viewAzimuth = Math.atan2(view[0], view[2]);

    const clip = options.clip
      ? (gltf.animations.find((entry) => entry.name === options.clip) ??
        gltf.animations[0])
      : undefined;
    mixer = new AnimationMixer(model);
    if (clip) {
      mixer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    }

    const turn = options.turntable ?? 0;
    if (options.draggable) {
      host.style.touchAction = 'pan-y';
      host.addEventListener('pointerdown', onPointerDown);
      host.addEventListener('pointermove', onPointerMove);
      host.addEventListener('pointerup', endDrag);
      host.addEventListener('pointercancel', endDrag);
    }

    const render = () => {
      if (disposed) {
        return;
      }
      frame = requestAnimationFrame(render);
      if (document.hidden) {
        return;
      }
      const delta = clock.getDelta();
      mixer?.update(delta);
      if (turn !== 0 && !dragging && performance.now() >= resumeAt) {
        spin += delta * turn;
      }
      // A visitor's drag and the turntable are the same number, added up before
      // the camera moves — so the two cannot fight over the model's facing.
      const azimuth = viewAzimuth + spin + drag;
      camera.position.set(
        center.x + Math.sin(azimuth) * orbitRadius,
        orbitHeight,
        center.z + Math.cos(azimuth) * orbitRadius,
      );
      camera.lookAt(center);
      renderer.render(scene, camera);
    };
    render();

    return { dispose };
  } catch (error) {
    dispose();
    if (signal.aborted) {
      return undefined;
    }
    throw error;
  }
};

/** The chrome mark: the preset above, and nothing else. */
export const mountFiddyMark = (
  host: HTMLElement,
  signal: AbortSignal,
): Promise<MountedModel | undefined> =>
  mountFiddyModel(host, signal, FIDDY_MARK_PRESET);
