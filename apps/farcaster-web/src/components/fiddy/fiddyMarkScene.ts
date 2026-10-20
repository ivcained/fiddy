/**
 * The mark's little scene — the only file in the app that touches three.js, and
 * it is reached by `import()` so the library is a chunk of its own, fetched
 * after the shell has painted.
 *
 * Deliberately minimal, and deliberately the same rules as the loading loop on
 * fiddy.fun:
 *   - matte outline shells render BackSide (the black-model lesson),
 *   - the loop repeats seamlessly,
 *   - everything is disposed with an explicit context loss, so a top bar that
 *     unmounts does not leak a GPU context,
 *   - nothing renders while the tab is hidden.
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

export interface MountedMark {
  dispose(): void;
}

export const mountFiddyMark = async (
  host: HTMLElement,
  signal: AbortSignal,
): Promise<MountedMark | undefined> => {
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
  const camera = new PerspectiveCamera(34, 1, 0.1, 50);
  scene.add(new HemisphereLight(0xfff6e8, 0x22231f, 1.1));
  const sun = new DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  let mixer: AnimationMixer | null = null;
  const clock = new Clock();
  let frame = 0;
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelAnimationFrame(frame);
    mixer?.stopAllAction();
    renderer.dispose();
    // An explicit context loss: a browser keeps only a handful of live WebGL
    // contexts, and this one lives in a top bar that mounts on every route.
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  };
  signal.addEventListener('abort', dispose);

  try {
    const response = await fetch(FIDDY_MARK_MODEL, { signal });
    if (!response.ok) {
      throw new Error(`mark model missing: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (signal.aborted) {
      dispose();
      return undefined;
    }

    const baby = gltf.scene as Group;
    scene.add(baby);

    baby.traverse((child) => {
      const mesh = child as { material?: { name?: string; side?: number } };
      if (mesh.material?.name === 'ToonOutline') {
        mesh.material.side = BackSide;
      }
    });

    // Frame the model's own bounds — the same shot the still was captured
    // from, so the swap from still to moving does not jump.
    const bounds = new Box3().setFromObject(baby);
    const center = bounds.getCenter(new Vector3());
    const sphere = bounds.getBoundingSphere(new Sphere());
    const fov = (camera.fov * Math.PI) / 180;
    const distance = sphere.radius / Math.sin(fov / 2);
    camera.position
      .copy(new Vector3(0.5, 0.32, 1).normalize().multiplyScalar(distance))
      .add(center);
    camera.lookAt(center);

    const clip =
      gltf.animations.find((entry) => entry.name === FIDDY_MARK_CLIP) ??
      gltf.animations[0];
    mixer = new AnimationMixer(baby);
    if (clip) {
      mixer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    }

    const render = () => {
      if (disposed) {
        return;
      }
      frame = requestAnimationFrame(render);
      if (document.hidden) {
        return;
      }
      mixer?.update(clock.getDelta());
      renderer.render(scene, camera);
    };
    render();

    return { dispose };
  } catch (error) {
    dispose();
    if (signal.aborted) {
      return undefined;
    }
    // The caller keeps the still: a mark that cannot animate is still the mark.
    throw error;
  }
};
