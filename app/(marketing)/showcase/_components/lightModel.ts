// The shop's light models, as moonshot/web/media.py writes them (gltf-transform optimize: meshopt, no Draco): one
// load per URL for the page, shared by the shop's canvas and a thing's card. Three's default loading manager, so
// they count in the shop's load status (ShopCanvas's useProgress).
import { use } from 'react';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Told apart by `'error' in`: a load can reject with anything, `undefined` included. */
export type LightModel = { scene: Object3D } | { error: unknown };

let loader: GLTFLoader | null = null;
const loads = new Map<string, Promise<LightModel>>();

/**
 * A light model's load, settled either way: it never rejects. Kept for the page, failures too, as the shop says
 * "Reload the page to try again".
 */
export function lightModel(url: string): Promise<LightModel> {
  let load = loads.get(url);
  if (!load) {
    loader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    load = loader.loadAsync(url).then(
      (gltf): LightModel => ({ scene: gltf.scene }),
      (error: unknown): LightModel => ({ error }),
    );
    loads.set(url, load);
  }
  return load;
}

/**
 * A light model, suspending while it loads; `{ error }` if it couldn't be, for the caller to report from an effect
 * and draw nothing in its place.
 *
 * Not thrown to an error boundary, as drei's useGLTF would: R3F's reconciler hands every error a boundary inside a
 * <Canvas> catches to the browser's `reportError` too (its createRoot passes that as onCaughtError), and it does so
 * before the boundary's componentDidCatch runs. Sentry's onerror then files each failed model as its own unhandled
 * issue, and the boundary's report of the same Error is dropped as already captured: one unhandled issue per model,
 * where the shop means one handled report per page (Sentry JAVASCRIPT-NEXTJS-3Q).
 */
export function useLightModel(url: string): LightModel {
  return use(lightModel(url));
}
