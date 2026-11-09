'use client';

// The realistic shop models (moonshot/web/realism/SPEC.md): streamed in after the light shop has
// settled, and swapped in per placed thing only while it is big enough on screen to matter. The
// light model stays everywhere else, the whole-shop view included, so the first view and its cost
// don't change. Both stay resident and swap by `visible`, so a swap is instant both ways.

import { useFrame, useThree, type RootState } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Frustum, MathUtils, Matrix4, Mesh, MeshStandardMaterial, Sphere, Texture, Vector3, type Group, type Object3D, type PerspectiveCamera, type WebGLRenderer } from 'three';
import { spotBox, type Catalog } from './catalog';
import { realisticManifest, type Manifest } from './realisticManifest';
import { reportLoadFailure } from './reportLoad';
import { redrawRoom, roomProbe, roomStatus } from './Room';
import { mediaUrl, type ShopItem } from './showcaseData';

/** The page's test for a mouse, as its controls use it (content.tsx): phones and touch keep the light models. */
export const FINE_POINTER = '(hover: hover) and (pointer: fine)';

/** A thing shows its realistic model from this share of the view's height, and goes back below the second. */
const ENTER = 0.2;
const LEAVE = 0.14;
/** At most this many realistic triangles shown at once, the biggest on screen first. */
const MAX_TRIANGLES = 1.5e6;
/** The shadows, contact shadows and probe are drawn again this long after the camera stops on a swap. */
const SETTLE_MS = 300;
/** Loading waits while the camera has moved this recently, so a flight doesn't stutter. */
const STILL_MS = 400;
const AT_ONCE = 2;
/** If the room never dresses (its media failing), stream this long after the light models settle. */
const ROOM_WAIT_MS = 10000;

/** One placed thing as the scene draws it: its group (position and turn), and the light model's group in it. */
export interface Slot {
  spot: ShopItem;
  outer: Group;
  light: Group;
}

interface Item {
  centre: Vector3;
  radius: number;
  triangles: number;
  full: Object3D;
  light: Group;
  shown: boolean;
}

/** For scripts and tests: how far the stream has got, and what the swap shows. */
export const realisticStatus = { assets: 0, loaded: 0, failed: 0, shown: 0, triangles: 0, done: false };

let reported = false;
function report(error: unknown) {
  // The light model stays; one report per page, as for the light models.
  if (!reported) reported = reportLoadFailure(error, 'Showcase: a realistic shop model failed to load');
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
// Safari has no requestIdleCallback.
const idle = () =>
  new Promise<void>((r) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(() => r(), { timeout: 2000 }) : window.setTimeout(r, 50)));

/** The swap rule, run each frame the camera moves or a model arrives. */
class Swap {
  readonly items: Item[] = [];
  /** Realistic models put in the scene, shown or not, to take out again. */
  readonly attached: Object3D[] = [];
  private readonly seen = new Matrix4();
  private readonly projection = new Matrix4();
  private readonly frustum = new Frustum();
  private readonly pv = new Matrix4();
  private readonly sphere = new Sphere();
  private movedAt = 0;
  private dirty = false;
  private swapped = false;
  private timer = 0;

  flying() {
    return performance.now() - this.movedAt < STILL_MS;
  }

  add(item: Item) {
    this.items.push(item);
    this.dirty = true;
  }

  update(camera: PerspectiveCamera) {
    camera.updateMatrixWorld();
    const moved = !this.seen.equals(camera.matrixWorld) || !this.projection.equals(camera.projectionMatrix);
    if (moved) {
      this.seen.copy(camera.matrixWorld);
      this.projection.copy(camera.projectionMatrix);
      this.movedAt = performance.now();
      if (this.swapped) this.settleLater();
    }
    if (!moved && !this.dirty) return;
    this.dirty = false;
    this.frustum.setFromProjectionMatrix(this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const tanHalf = Math.tan(MathUtils.degToRad(camera.fov / 2));
    // About the share of the view's height the thing spans; one off screen stays as it is.
    const want: [number, Item][] = [];
    for (const it of this.items) {
      if (!this.frustum.intersectsSphere(this.sphere.set(it.centre, it.radius))) continue;
      const share = it.radius / (Math.max(camera.position.distanceTo(it.centre), it.radius) * tanHalf);
      if (share >= (it.shown ? LEAVE : ENTER)) want.push([share, it]);
      else this.show(it, false);
    }
    want.sort((a, b) => b[0] - a[0]);
    let used = 0;
    for (const [, it] of want) {
      const fits = used + it.triangles <= MAX_TRIANGLES;
      this.show(it, fits);
      if (fits) used += it.triangles;
    }
    const shown = this.items.filter((it) => it.shown);
    realisticStatus.shown = shown.length;
    realisticStatus.triangles = shown.reduce((s, it) => s + it.triangles, 0);
    if (this.swapped) this.settleLater();
  }

  private show(it: Item, full: boolean) {
    if (it.shown === full) return;
    it.shown = full;
    it.full.visible = full;
    it.light.visible = !full;
    this.swapped = true;
  }

  /** The shadows, contact shadows and probe once more, once the camera has stopped on what swapped. */
  private settleLater() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.swapped = false;
      redrawRoom();
    }, SETTLE_MS);
  }

  /** Back to the light models, empty, so a stream started again begins from nothing. */
  dispose() {
    window.clearTimeout(this.timer);
    for (const it of this.items) it.light.visible = true;
    for (const o of this.attached) o.removeFromParent();
    this.items.length = 0;
    this.attached.length = 0;
    this.swapped = this.dirty = false;
  }
}

/** Shadows from everything but glass, never picked (the light model's box is), and the probe on its metals. */
function prepare(model: Object3D, gl: WebGLRenderer) {
  const probe = roomProbe();
  model.visible = false;
  model.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    o.userData.realistic = true;
    o.raycast = () => {};
    const materials = [o.material].flat();
    o.castShadow = !materials.some((m) => m.transparent);
    o.receiveShadow = true;
    for (const m of materials) {
      if (probe && m instanceof MeshStandardMaterial && m.metalness >= 0.5) m.envMap = probe;
      // Uploaded now, not on the frame it first shows. Tiles shared between models upload once.
      for (const value of Object.values(m)) if (value instanceof Texture) gl.initTexture(value);
    }
  });
}

/**
 * Light models first; once they have settled (and the room with them) and the page is idle, the
 * realistic ones, two at a time and paused while the camera moves: heroes first, then the nearest,
 * in the manifest's order otherwise. Each is compiled before it may show.
 */
async function stream(cat: Catalog, slots: Map<number, Slot>, swap: Swap, get: () => RootState, signal: AbortSignal) {
  let modelsAt = 0;
  while (!roomStatus.settled) {
    if (signal.aborted) return;
    if (roomStatus.models) {
      modelsAt ||= performance.now();
      if (performance.now() - modelsAt > ROOM_WAIT_MS) break;
    }
    await sleep(500);
  }
  await idle();
  let manifest: Manifest | null;
  try {
    manifest = await realisticManifest();
  } catch (error) {
    if (!signal.aborted) report(error);
    return;
  }
  // None published yet: the light models, quietly.
  if (!manifest || signal.aborted) return;
  const { realisticLoader } = await import('./realisticLoader');
  if (signal.aborted) return;
  const { gl, scene, camera, invalidate } = get();
  const loader = realisticLoader(gl);

  const byAsset = new Map<string, Slot[]>();
  for (const slot of slots.values()) {
    if (manifest.assets[slot.spot.asset]) byAsset.set(slot.spot.asset, [...(byAsset.get(slot.spot.asset) ?? []), slot]);
  }
  const centre = (slot: Slot) => new Vector3(...spotBox(cat.shop.assets[slot.spot.asset], slot.spot).center);
  const queue = [...byAsset.keys()];
  realisticStatus.assets = queue.length;
  const next = () => {
    const near = new Map(queue.map((a) => [a, Math.min(...byAsset.get(a)!.map((s) => centre(s).distanceTo(camera.position)))]));
    const rank = (a: string) => [manifest.assets[a].priority === 'hero' ? 0 : 1, near.get(a)!, manifest.assets[a].load_order];
    queue.sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    return queue.shift();
  };

  const work = async () => {
    while (!signal.aborted) {
      await idle();
      while (swap.flying() && !signal.aborted) await sleep(250);
      const asset = signal.aborted ? undefined : next();
      if (!asset) return;
      try {
        const model = await loader.load(mediaUrl(manifest.assets[asset].full));
        if (signal.aborted) return;
        const placed = byAsset.get(asset)!.map((slot, i) => {
          const full = i === 0 ? model : model.clone(true);
          prepare(full, gl);
          slot.outer.add(full);
          swap.attached.push(full);
          return { slot, full };
        });
        // Its shaders built off the frame, so showing it doesn't stall one.
        await gl.compileAsync(model, camera, scene);
        if (signal.aborted) return;
        for (const { slot, full } of placed) {
          const { size } = spotBox(cat.shop.assets[slot.spot.asset], slot.spot);
          swap.add({ centre: centre(slot), radius: Math.hypot(...size) / 2, triangles: manifest.assets[asset].triangles, full, light: slot.light, shown: false });
        }
        realisticStatus.loaded += 1;
        invalidate();
      } catch (error) {
        if (signal.aborted) return;
        realisticStatus.failed += 1;
        report(error);
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, work));
  realisticStatus.done = !signal.aborted;
}

/** Streams the realistic models into the slots the shop's things have registered, and swaps them. */
export default function Realistic({ cat, slots }: { cat: Catalog; slots: Map<number, Slot> }) {
  const get = useThree((s) => s.get);
  const swap = useMemo(() => new Swap(), []);
  useFrame(({ camera }) => swap.update(camera as PerspectiveCamera));
  useEffect(() => {
    const stop = new AbortController();
    Object.assign(realisticStatus, { assets: 0, loaded: 0, failed: 0, shown: 0, triangles: 0, done: false });
    void stream(cat, slots, swap, get, stop.signal);
    return () => {
      stop.abort();
      swap.dispose();
    };
  }, [cat, slots, swap, get]);
  return null;
}
