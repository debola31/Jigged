'use client';

import { CameraControls, Html, useGLTF, useProgress } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import Typography from '@mui/material/Typography';
import { AgXToneMapping, BoxGeometry, CanvasTexture, EdgesGeometry, Mesh, Object3D, PCFShadowMap, PerspectiveCamera, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three';
import { toError } from '@/lib/supabaseErrors';
import { spotBox, toScene, type Catalog, type Vec3 } from './catalog';
import Room, { roomStatus } from './Room';
import { mediaUrl, type LivePart, type Rect, type ShopItem } from './showcaseData';
import { useShowcase, type View } from './store';
import { itemPose, overviewPose, stepPose, walkLegs, zoneCentre, zonePose, type Leg, type Pose } from './views';

const AMBER = '#D4872A';
const TEAL = '#2BBCB3';
const FOV = 40;
// The building's own floor round the shop: dark concrete, gridded every metre and every 5 m, fading
// into the dark well before the fog, so the shop reads as a cell in a larger hall.
const HALL = '#16181d';
const HALL_FLOOR = '#1f2228';

const deg = (d: number) => (d * Math.PI) / 180;

// --- things -------------------------------------------------------------------------------------

function useInstance(url: string) {
  // Draco off, meshopt on: the models are written by gltf-transform optimize (moonshot/web/media.py).
  const gltf = useGLTF(url, false, true);
  return useMemo(() => {
    const object = gltf.scene.clone(true);
    object.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // Picking uses the box around the thing: far cheaper than raycasting its triangles.
      o.raycast = () => {};
    });
    return object;
  }, [gltf.scene]);
}

/** The box a thing is picked by, in its own frame: at least 8 cm a side, so a gauge can be hit from across the shop. */
function pickBox(cat: Catalog, spot: ShopItem): { size: Vec3; centre: Vec3 } {
  const { min, max } = cat.shop.assets[spot.asset].bbox;
  const size: Vec3 = [
    Math.max((max[0] - min[0]) / 1000, 0.08),
    Math.max((max[2] - min[2]) / 1000, 0.08),
    Math.max((max[1] - min[1]) / 1000, 0.08),
  ];
  return { size, centre: [(min[0] + max[0]) / 2000, Math.max((min[2] + max[2]) / 2000, size[1] / 2), -(min[1] + max[1]) / 2000] };
}

function Model({ url }: { url: string }) {
  return <primitive object={useInstance(url)} />;
}

function Thing({ cat, spot }: { cat: Catalog; spot: ShopItem }) {
  const hover = useShowcase((s) => s.hover);
  const openItem = useShowcase((s) => s.openItem);
  const { size, centre } = pickBox(cat, spot);

  return (
    <group position={toScene(spot.x, spot.y, spot.z)} rotation-y={deg(spot.rot)} name={spot.item}>
      <Skip onError={reportModel}>
        <Suspense fallback={null}>
          <Model url={mediaUrl(cat.shop.assets[spot.asset].model)} />
        </Suspense>
      </Skip>
      <mesh
        position={centre}
        // The room's contact shadows draw it as the thing's footprint; its reflection probe leaves it out.
        userData={{ pick: true }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          hover(spot.item);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (useShowcase.getState().hovered === spot.item) hover(null);
          document.body.style.cursor = '';
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.delta > 4) return; // the end of an orbit drag, not a click
          openItem(spot.item);
          posthog.capture('showcase item opened', { category: spot.category, source: 'scene' });
        }}
      >
        <boxGeometry args={size} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
    </group>
  );
}

let modelFailures = 0;
function reportModel(error: unknown) {
  // One report per page: the same outage would otherwise file one per model.
  if (modelFailures++ === 0) Sentry.captureException(toError(error, 'Showcase: a shop model failed to load'));
  useShowcase.getState().modelFailed();
}

/** Renders nothing in place of a child that threw, so one missing model doesn't take the shop down. */
class Skip extends Component<{ children: ReactNode; onError(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** An outline round a thing where it stands: amber for the station or selection, teal for what a step uses. */
function Outline({ cat, id, color }: { cat: Catalog; id: string; color: string }) {
  const spot = cat.spots.get(id)?.[0];
  const box = spot ? pickBox(cat, spot) : null;
  const geometry = useMemo(
    () => (box ? new EdgesGeometry(new BoxGeometry(box.size[0] * 1.04, box.size[1] * 1.04, box.size[2] * 1.04)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the box is derived from the spot
    [spot],
  );
  if (!spot || !geometry || !box) return null;
  return (
    <group position={toScene(spot.x, spot.y, spot.z)} rotation-y={deg(spot.rot)}>
      <lineSegments geometry={geometry} position={box.centre}>
        {/* The page's own amber and teal, untouched by the tone mapping. */}
        <lineBasicMaterial color={color} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/**
 * Amber round the open thing and the open step's station, teal round what the step uses and what
 * the pointer is over. Outlines rather than tints, which muddy dark parts (granite, castings).
 */
function Highlights({ cat, part }: { cat: Catalog; part: LivePart }) {
  const item = useShowcase((s) => s.item);
  const index = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  const hovered = useShowcase((s) => s.hovered);
  const invalidate = useThree((s) => s.invalidate);
  const step = sheet === 'step' && index !== null ? part.steps[index] : null;
  const amber = new Set([step?.where.item, item].filter((id): id is string => !!id));
  const teal = new Set([...(step?.uses ?? []).flatMap((u) => (u.item ? [u.item] : [])), ...(hovered ? [hovered] : [])].filter((id) => !amber.has(id)));
  // The canvas draws on demand.
  useEffect(() => {
    invalidate();
  }, [item, index, sheet, hovered, invalidate]);
  return (
    <>
      {[...amber].map((id) => (
        <Outline key={`a-${id}`} cat={cat} id={id} color={AMBER} />
      ))}
      {[...teal].map((id) => (
        <Outline key={`t-${id}`} cat={cat} id={id} color={TEAL} />
      ))}
    </>
  );
}

/**
 * A name over a place in the shop, to click. Drawn as HTML by drei, outside the page's MUI theme,
 * so it is styled inline.
 */
function Label({ at, text, color, shown, onClick }: { at: Vec3; text: string; color: string; shown: boolean; onClick(): void }) {
  // Hidden, not unmounted: each label is its own React root, and unmounting one while the step
  // changes makes React warn about a root unmounted mid-render.
  return (
    <Html position={at} center zIndexRange={[20, 0]}>
      <button
        type="button"
        onClick={onClick}
        tabIndex={shown ? 0 : -1}
        aria-hidden={!shown}
        style={{
          display: shown ? 'block' : 'none',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '0.8rem',
          fontWeight: 600,
          color: '#fff',
          background: 'rgba(17, 20, 57, 0.88)',
          border: `1px solid ${color}`,
          borderRadius: 999,
          padding: '0.25rem 0.7rem',
        }}
      >
        {text}
      </button>
    </Html>
  );
}

/** The part's stations, amber, and what the open step uses, teal: each opens or flies to its place. */
function Labels({ cat, part }: { cat: Catalog; part: LivePart }) {
  const phase = useShowcase((s) => s.phase);
  const index = useShowcase((s) => s.step);
  const sheet = useShowcase((s) => s.sheet);
  const item = useShowcase((s) => s.item);
  const { openItem, look } = useShowcase.getState();
  if (phase === 'pick') return null;
  const above = (id: string, lift: number): Vec3 | null => {
    const spot = cat.spots.get(id)?.[0];
    if (!spot) return null;
    const { center, size } = spotBox(cat.shop.assets[spot.asset], spot);
    return [center[0], center[1] + size[1] / 2 + lift, center[2]];
  };
  const open = (id: string) => {
    openItem(id);
    posthog.capture('showcase item opened', { category: cat.spots.get(id)?.[0].category ?? 'unknown', source: 'label' });
  };
  const stations = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()];
  const step = sheet === 'step' && index !== null ? part.steps[index] : null;
  const current = new Set((step?.uses ?? []).flatMap((u) => (u.item && u.item !== item ? [u.item] : [])));
  // Every placed thing any step uses gets a label, shown only while its step is open.
  const all = [...new Map(part.steps.flatMap((s) => s.uses).flatMap((u) => (u.item ? [[u.item, u.name] as const] : []))).entries()];
  return (
    <>
      {stations.map((w) => {
        const at = w.item ? above(w.item, 0.35) : toScene(...zoneCentre(cat, w), 2200);
        return at && <Label key={w.name} at={at} text={w.name} color={AMBER} shown onClick={() => (w.item ? open(w.item) : look({ kind: 'zone', where: w }))} />;
      })}
      {all.map(([id, name]) => {
        const at = above(id, 0.12);
        return at && <Label key={id} at={at} text={name} color={TEAL} shown={current.has(id)} onClick={() => open(id)} />;
      })}
    </>
  );
}

// --- building -----------------------------------------------------------------------------------

const ZONE_TINT: Record<string, string> = {
  milling: '#4682B4',
  turning: '#4682B4',
  grinding: '#2BBCB3',
  'wire-edm': '#2BBCB3',
  saw: '#D4872A',
  finishing: '#D4872A',
  inspection: '#6b5fb5',
  'tool-crib': '#8a8f98',
  benches: '#a07a52',
  shipping: '#8a8f98',
};

function rectOnFloor(r: Rect, lift: number): { position: Vec3; size: [number, number] } {
  const [x, , z] = toScene((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 0);
  return { position: [x, lift, z], size: [(r[2] - r[0]) / 1000, (r[3] - r[1]) / 1000] };
}

/** What stands in the room: the zones marked on its floor, and the benches, cabinets and carts. */
function Building({ cat }: { cat: Catalog }) {
  const { building, zones } = cat.shop;
  const [, bd] = building.size;
  return (
    <group>
      {zones.map((z) => {
        const r = rectOnFloor(z.rect, 0.004);
        const labelAt = toScene((z.rect[0] + z.rect[2]) / 2, z.rect[1] < bd / 2 ? z.rect[1] + 600 : z.rect[3] - 600, 0);
        return (
          <group key={z.id}>
            <mesh rotation-x={-Math.PI / 2} position={r.position} receiveShadow userData={{ flat: true }}>
              <planeGeometry args={r.size} />
              <meshStandardMaterial
                color={ZONE_TINT[z.id] ?? '#888888'}
                transparent
                opacity={0.13}
                roughness={1}
                depthWrite={false}
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-1}
              />
            </mesh>
            <FloorLabel text={z.name} position={labelAt} />
          </group>
        );
      })}
      {cat.shop.furniture.map((f) => {
        const [w, d, h] = f.size.map((v) => v / 1000);
        const slab = 0.04;
        const [body, top] = FURNITURE_COLOUR[f.kind] ?? FURNITURE_COLOUR.table;
        return (
          <group key={f.id} position={toScene(f.x, f.y, 0)} rotation-y={deg(f.rot)}>
            <mesh position={[0, (h - slab) / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[w * 0.96, h - slab, d * 0.92]} />
              <meshStandardMaterial color={body} roughness={0.6} />
            </mesh>
            <mesh position={[0, h - slab / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[w, slab, d]} />
              <meshStandardMaterial color={top} roughness={f.kind === 'table' ? 0.3 : 0.7} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const HALL_M = 600;
const SECTION_M = 5;

/**
 * The hall round the shop: a dark concrete floor, gridded every metre and more boldly every 5 m,
 * fading into the dark with the fog. The grid is a tiled texture, which every GPU draws (drei's
 * shader grid drew nothing under a software renderer).
 */
function Hall({ centre }: { centre: Vec3 }) {
  const texture = useMemo(() => {
    const px = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = HALL_FLOOR;
    ctx.fillRect(0, 0, px, px);
    ctx.strokeStyle = '#2f343d';
    ctx.lineWidth = 2;
    for (let i = 1; i < SECTION_M; i++) {
      const at = (i * px) / SECTION_M;
      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at, px);
      ctx.moveTo(0, at);
      ctx.lineTo(px, at);
      ctx.stroke();
    }
    // The section's edge, half on each side of the tile, so neighbouring tiles make it whole.
    ctx.strokeStyle = '#454b57';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, px, px);
    const t = new CanvasTexture(canvas);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(HALL_M / SECTION_M, HALL_M / SECTION_M);
    t.anisotropy = 8;
    t.colorSpace = SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => texture?.dispose(), [texture]);
  return (
    // Just under the shop's own floor, which hides it inside the walls.
    <mesh rotation-x={-Math.PI / 2} position={[centre[0], -0.05, centre[2]]} receiveShadow>
      <planeGeometry args={[HALL_M, HALL_M]} />
      <meshStandardMaterial map={texture} color={texture ? '#ffffff' : HALL_FLOOR} roughness={0.95} />
    </mesh>
  );
}

const FURNITURE_COLOUR: Record<string, [string, string]> = {
  bench: ['#3b4a5a', '#b8915f'],
  cabinet: ['#4682B4', '#2f3338'],
  cart: ['#b0413e', '#2f3338'],
  table: ['#5d6066', '#3a3d42'],
};

/** A zone's name painted on the floor, read from the south (the overview's side). */
function FloorLabel({ text, position }: { text: string; position: Vec3 }) {
  const [texture, setTexture] = useState<CanvasTexture | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: CanvasTexture | null = null;
    // Drawn once the page's fonts are in, so the label is in the page's face.
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      const family = getComputedStyle(document.body).fontFamily;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const px = 96;
      const label = text.toUpperCase();
      ctx.font = `700 ${px}px ${family}`;
      canvas.width = Math.ceil(ctx.measureText(label).width + px * 0.8);
      canvas.height = Math.ceil(px * 1.5);
      ctx.font = `700 ${px}px ${family}`;
      ctx.fillStyle = 'rgba(45, 50, 56, 0.78)';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px * 0.4, canvas.height / 2);
      made = new CanvasTexture(canvas);
      made.colorSpace = SRGBColorSpace;
      made.anisotropy = 8;
      setTexture(made);
    });
    return () => {
      cancelled = true;
      made?.dispose();
    };
  }, [text]);
  if (!texture) return null;
  const h = 0.7;
  const w = (h * texture.image.width) / texture.image.height;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[position[0], 0.008, position[2]]} renderOrder={1} userData={{ flat: true }}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}

// --- camera -------------------------------------------------------------------------------------

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Plays the camera's moves: one flight for a step, a thing or the overview, or the walk's legs.
 * A mouse can orbit, pan and zoom between moves, and grabbing the view ends a move in progress.
 * Under reduced motion every move is a cut, and only the walk's stops take time.
 */
function CameraRig({ cat, part, left, right }: { cat: Catalog; part: LivePart; left: number; right: number }) {
  const controls = useRef<CameraControls>(null);
  const view = useShowcase((s) => s.view);
  const token = useShowcase((s) => s.token);
  const walking = useShowcase((s) => s.walking);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const get = useThree((s) => s.get);
  const flight = useRef<{ legs: Leg[]; i: number; start: number; from: Pose } | null>(null);
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // Read when a pose is asked for, so a card changing size doesn't fly the camera again.
  const cover = useRef({ left, right });
  useEffect(() => {
    cover.current = { left, right };
  }, [left, right]);

  const poseOf = useMemo(
    () => (v: typeof view): Pose => {
      const { width, height } = get().size;
      const open = Math.max(width - cover.current.left - cover.current.right, width * 0.3);
      return (
        (v.kind === 'item' && itemPose(cat, v.id, camera.fov)) ||
        (v.kind === 'step' && stepPose(cat, part.steps[v.index], camera.fov)) ||
        (v.kind === 'zone' && zonePose(cat, v.where)) ||
        overviewPose(cat, height ? open / height : camera.aspect, camera.fov)
      );
    },
    [cat, part, camera, get],
  );

  const fly = (legs: Leg[]) => {
    const c = controls.current;
    if (!c) return;
    const p = c.getPosition(new Vector3());
    const t = c.getTarget(new Vector3());
    flight.current = { legs, i: 0, start: performance.now(), from: { position: p.toArray(), target: t.toArray() } };
    invalidate();
  };

  // The first view is set, not flown to; every later request flies.
  const first = useRef(true);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const pose = poseOf(view);
    if (first.current) {
      first.current = false;
      void c.setLookAt(...pose.position, ...pose.target, false);
      return;
    }
    if (!useShowcase.getState().walking) fly([{ ...pose, ms: 1300 }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `token` re-runs it for a repeated request
  }, [view, token, poseOf]);

  // While the whole shop is in view, a card folding, opening or closing frames it again, once the
  // card has settled.
  useEffect(() => {
    const s = useShowcase.getState();
    if (s.view.kind !== 'overview' || s.walking || first.current) return;
    const t = window.setTimeout(() => fly([{ ...poseOf(s.view), ms: 900 }]), 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of what the cards cover re-frames
  }, [left, right]);

  useEffect(() => {
    if (walking) {
      const route = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()];
      fly(walkLegs(cat, route, poseOf(useShowcase.getState().view)));
    } else if (flight.current && flight.current.legs.length > 1) {
      // Stopped by the button: back to where the visitor was.
      fly([{ ...poseOf(useShowcase.getState().view), ms: 1300 }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of walking starts or ends it
  }, [walking]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    // Grabbing the view ends a move, and the walk with it.
    const grab = () => {
      flight.current = null;
      const s = useShowcase.getState();
      if (s.walking) s.setWalking(false);
    };
    c.addEventListener('controlstart', grab);
    return () => c.removeEventListener('controlstart', grab);
  }, []);

  useFrame(() => {
    const f = flight.current;
    const c = controls.current;
    if (!f || !c) return;
    const leg = f.legs[f.i];
    const elapsed = performance.now() - f.start;
    const t = reduced ? 1 : Math.min(1, elapsed / leg.ms);
    const k = ease(t);
    const position = lerp(f.from.position, leg.position, k);
    const target = lerp(f.from.target, leg.target, k);
    void c.setLookAt(...position, ...target, false);
    const s = useShowcase.getState();
    if ((leg.stop ?? null) !== s.walkStop && s.walking) s.setWalkStop(leg.stop ?? null);
    const done = reduced ? elapsed >= (leg.stop ? leg.ms : 0) : t >= 1;
    if (done) {
      f.from = { position: leg.position, target: leg.target };
      f.i += 1;
      f.start = performance.now();
      if (f.i >= f.legs.length) {
        flight.current = null;
        if (s.walking) s.setWalking(false);
        // The controls move the camera on their next update: one more frame lands the last pose,
        // which under reduced motion is the whole move.
        invalidate();
        return;
      }
    }
    invalidate();
  });

  return <CameraControls ref={controls} makeDefault minDistance={0.3} maxDistance={140} maxPolarAngle={deg(86)} dollyToCursor smoothTime={0.35} />;
}

/**
 * With cards floating over the shop's sides, the view's centre moves to the middle of what they
 * leave uncovered, so whatever the camera flies to lands where it can be seen.
 */
function ViewOffset({ left, right }: { left: number; right: number }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  useEffect(() => {
    const { camera, invalidate } = get();
    if (!(camera instanceof PerspectiveCamera)) return;
    const shift = (left - right) / 2;
    if (shift) camera.setViewOffset(size.width, size.height, -shift, 0, size.width, size.height);
    else camera.clearViewOffset();
    invalidate();
  }, [get, size, left, right]);
  return null;
}

/**
 * For scripts and tests: where a thing is on screen, so it can be clicked in 3D; where the camera
 * is, and moving it; whether the room has finished dressing; and what a frame costs the GPU.
 */
function ScreenProbe({ cat }: { cat: Catalog }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const get = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as { __showcase?: unknown };
    w.__showcase = {
      project(id: string): { x: number; y: number } | null {
        const spot = cat.spots.get(id)?.[0];
        if (!spot) return null;
        const { center, size } = spotBox(cat.shop.assets[spot.asset], spot);
        const v = new Vector3(center[0], center[1] + size[1] * 0.3, center[2]).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
      /** Where the camera is and which way it looks, in scene metres. */
      camera() {
        return { position: camera.position.toArray(), looking: camera.getWorldDirection(new Vector3()).toArray() };
      },
      /** Move the camera as the page does: a zone, a thing, a step or the overview. */
      look(view: View) {
        useShowcase.getState().look(view);
      },
      /** The room's tiles and HDRI are on and its reflection probe drawn: the shop as it finally looks. */
      settled() {
        return roomStatus.settled;
      },
      /** Put the camera where `camera()` said it was, as a drag would leave it. */
      pose({ position, looking }: { position: Vec3; looking: Vec3 }) {
        const controls = get().controls as CameraControls | null;
        void controls?.setLookAt(...position, position[0] + looking[0] * 5, position[1] + looking[1] * 5, position[2] + looking[2] * 5, false);
        get().invalidate();
      },
      /** The GPU's time for a frame, in ms: n frames drawn back to back, each finished by reading a pixel back. */
      frameMs(n = 60) {
        const g = gl.getContext();
        const px = new Uint8Array(4);
        const frame = () => {
          gl.render(scene, camera);
          g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
        };
        frame();
        const start = performance.now();
        for (let i = 0; i < n; i++) frame();
        const info = gl.info.render;
        return { ms: (performance.now() - start) / n, calls: info.calls, triangles: info.triangles };
      },
    };
    return () => {
      delete w.__showcase;
    };
  }, [cat, camera, gl, scene, get]);
  return null;
}

function Scene({ cat, part, left, right }: { cat: Catalog; part: LivePart; left: number; right: number }) {
  // The sun's target has to be in the scene so its matrix follows its position.
  const sunTarget = useMemo(() => new Object3D(), []);
  const [bw, bd] = cat.shop.building.size;
  const centre = toScene(bw / 2, bd / 2, 0);
  return (
    <>
      <color attach="background" args={[HALL]} />
      {/* Clear of the shop from as far as the whole-shop view stands. */}
      <fog attach="fog" args={[HALL, 130, 320]} />
      {/* The high bays, as one key light from above the aisle: the one realtime light, with soft shadows. */}
      <directionalLight
        position={[centre[0] - 18, 40, centre[2] + 22]}
        intensity={3}
        color="#fff4e6"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={4}
        shadow-camera-left={-36}
        shadow-camera-right={36}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-near={1}
        shadow-camera-far={120}
        target={sunTarget}
      />
      <primitive object={sunTarget} position={centre} />
      <Hall centre={centre} />
      <Room cat={cat} />
      <Building cat={cat} />
      {cat.shop.items.map((spot, i) => (
        <Thing key={`${spot.item}#${i}`} cat={cat} spot={spot} />
      ))}
      <Highlights cat={cat} part={part} />
      <Labels cat={cat} part={part} />
      <CameraRig cat={cat} part={part} left={left} right={right} />
      <ViewOffset left={left} right={right} />
      <ScreenProbe cat={cat} />
    </>
  );
}

/** How many of the shop's models are in, while they stream; and how many failed, if any did. */
function LoadStatus() {
  const { active, loaded, total } = useProgress();
  const failed = useShowcase((s) => s.failedModels);
  if (!active && failed === 0) return null;
  return (
    <Typography
      role="status"
      sx={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', px: 1.5, py: 0.75, borderRadius: 1, bgcolor: 'rgba(17, 20, 57, 0.8)', color: 'text.secondary', fontSize: '0.9rem' }}
    >
      {active ? `Loading the shop: ${loaded} of ${total} models` : `${failed} models couldn't be loaded. Reload the page to try again.`}
    </Typography>
  );
}

/**
 * The shop in 3D. Loaded only in the browser, so three.js stays out of every other bundle. `left`
 * and `right` are how much of the view cards cover on each side, in CSS pixels.
 */
export default function ShopCanvas({ cat, part, left = 0, right = 0 }: { cat: Catalog; part: LivePart; left?: number; right?: number }) {
  return (
    <>
      <Canvas
        shadows={{ type: PCFShadowMap }}
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: FOV, near: 0.05, far: 400, position: overviewPose(cat).position }}
        gl={{ antialias: true, toneMapping: AgXToneMapping }}
        onPointerMissed={() => useShowcase.getState().hover(null)}
      >
        <Scene cat={cat} part={part} left={left} right={right} />
      </Canvas>
      <LoadStatus />
    </>
  );
}
