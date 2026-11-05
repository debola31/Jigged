'use client';

import { CameraControls, Environment, Lightformer, useGLTF, useProgress } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import Typography from '@mui/material/Typography';
import { BoxGeometry, CanvasTexture, EdgesGeometry, Mesh, Object3D, PCFShadowMap, SRGBColorSpace, Vector3, type PerspectiveCamera } from 'three';
import { toError } from '@/lib/supabaseErrors';
import { spotBox, toScene, type Catalog, type Vec3 } from './catalog';
import { mediaUrl, type LivePart, type Rect, type ShopItem } from './showcaseData';
import { useShowcase } from './store';
import { itemPose, overviewPose, stepPose, walkLegs, type Leg, type Pose } from './views';

const AMBER = '#D4872A';
const TEAL = '#2BBCB3';
const FOV = 40;
const WALL_M = 1.2; // low, so the overview sees in; the real walls come with the realism pass

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
        <lineBasicMaterial color={color} />
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
  const hovered = useShowcase((s) => s.hovered);
  const invalidate = useThree((s) => s.invalidate);
  const step = index === null ? null : part.steps[index];
  const amber = new Set([step?.where.item, item].filter((id): id is string => !!id));
  const teal = new Set([...(step?.uses ?? []).flatMap((u) => (u.item ? [u.item] : [])), ...(hovered ? [hovered] : [])].filter((id) => !amber.has(id)));
  // The canvas draws on demand.
  useEffect(() => invalidate(), [item, index, hovered, invalidate]);
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

function Building({ cat }: { cat: Catalog }) {
  const { building, zones, aisles } = cat.shop;
  const [bw, bd] = building.size;
  const floor = rectOnFloor([0, 0, bw, bd], 0);
  const t = 0.2;
  const walls: { position: Vec3; size: Vec3 }[] = [
    { position: [floor.position[0], WALL_M / 2, t / 2], size: [bw / 1000, WALL_M, t] },
    { position: [floor.position[0], WALL_M / 2, -bd / 1000 - t / 2], size: [bw / 1000, WALL_M, t] },
    { position: [-t / 2, WALL_M / 2, floor.position[2]], size: [t, WALL_M, bd / 1000 + 2 * t] },
    { position: [bw / 1000 + t / 2, WALL_M / 2, floor.position[2]], size: [t, WALL_M, bd / 1000 + 2 * t] },
  ];
  const doors = building.doors ?? [];
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={floor.position} receiveShadow>
        <planeGeometry args={floor.size} />
        <meshStandardMaterial color="#c9c6bf" roughness={0.9} />
      </mesh>
      {walls.map((w, i) => (
        <mesh key={i} position={w.position} castShadow receiveShadow>
          <boxGeometry args={w.size} />
          <meshStandardMaterial color="#e4e1da" roughness={0.8} />
        </mesh>
      ))}
      {doors.map((d) => {
        const r = rectOnFloor(d.rect, 0);
        return (
          <mesh key={d.name} position={[r.position[0], WALL_M / 2 + 0.01, r.position[2]]}>
            <boxGeometry args={[r.size[0] + 0.05, WALL_M + 0.02, r.size[1]]} />
            <meshStandardMaterial color={AMBER} roughness={0.6} />
          </mesh>
        );
      })}
      {zones.map((z) => {
        const r = rectOnFloor(z.rect, 0.004);
        const labelAt = toScene((z.rect[0] + z.rect[2]) / 2, z.rect[1] < bd / 2 ? z.rect[1] + 600 : z.rect[3] - 600, 0);
        return (
          <group key={z.id}>
            <mesh rotation-x={-Math.PI / 2} position={r.position} receiveShadow>
              <planeGeometry args={r.size} />
              <meshStandardMaterial color={ZONE_TINT[z.id] ?? '#888888'} transparent opacity={0.13} roughness={1} depthWrite={false} />
            </mesh>
            <FloorLabel text={z.name} position={labelAt} />
          </group>
        );
      })}
      {aisles.flatMap((a) => {
        // Yellow safety lines along both long edges of each aisle.
        const horizontal = a.rect[2] - a.rect[0] > a.rect[3] - a.rect[1];
        const edges: Rect[] = horizontal
          ? [
              [a.rect[0], a.rect[1], a.rect[2], a.rect[1] + 80],
              [a.rect[0], a.rect[3] - 80, a.rect[2], a.rect[3]],
            ]
          : [
              [a.rect[0], a.rect[1], a.rect[0] + 80, a.rect[3]],
              [a.rect[2] - 80, a.rect[1], a.rect[2], a.rect[3]],
            ];
        return edges.map((e, i) => {
          const r = rectOnFloor(e, 0.006);
          return (
            <mesh key={`${a.name}-${i}`} rotation-x={-Math.PI / 2} position={r.position}>
              <planeGeometry args={r.size} />
              <meshStandardMaterial color="#e8c22e" roughness={0.7} />
            </mesh>
          );
        });
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
    <mesh rotation-x={-Math.PI / 2} position={[position[0], 0.008, position[2]]} renderOrder={1}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
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
function CameraRig({ cat, part }: { cat: Catalog; part: LivePart }) {
  const controls = useRef<CameraControls>(null);
  const view = useShowcase((s) => s.view);
  const token = useShowcase((s) => s.token);
  const walking = useShowcase((s) => s.walking);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const flight = useRef<{ legs: Leg[]; i: number; start: number; from: Pose } | null>(null);
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const poseOf = useMemo(
    () => (v: typeof view): Pose =>
      (v.kind === 'item' && itemPose(cat, v.id, camera.fov)) ||
      (v.kind === 'step' && stepPose(cat, part.steps[v.index], camera.fov)) ||
      overviewPose(cat, camera.aspect, camera.fov),
    [cat, part, camera],
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
        return;
      }
    }
    invalidate();
  });

  return <CameraControls ref={controls} makeDefault minDistance={0.3} maxDistance={140} maxPolarAngle={deg(86)} dollyToCursor smoothTime={0.35} />;
}

/** Nothing in the shop moves, so the shadow map is drawn again only when another model arrives. */
function Shadows() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl, scene, invalidate } = get();
    gl.shadowMap.autoUpdate = false;
    let count = -1;
    const id = window.setInterval(() => {
      // Cheap: a count of meshes, checked twice a second while models stream in.
      let n = 0;
      scene.traverse((o) => {
        if (o instanceof Mesh) n += 1;
      });
      if (n !== count) {
        count = n;
        gl.shadowMap.needsUpdate = true;
        invalidate();
      }
    }, 500);
    return () => {
      window.clearInterval(id);
      gl.shadowMap.autoUpdate = true;
    };
  }, [get]);
  return null;
}

/** For scripts and tests: where a thing is on screen, so it can be clicked in 3D. */
function ScreenProbe({ cat }: { cat: Catalog }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
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
    };
    return () => {
      delete w.__showcase;
    };
  }, [cat, camera, gl]);
  return null;
}

function Scene({ cat, part }: { cat: Catalog; part: LivePart }) {
  // The sun's target has to be in the scene so its matrix follows its position.
  const sunTarget = useMemo(() => new Object3D(), []);
  const [bw, bd] = cat.shop.building.size;
  const centre = toScene(bw / 2, bd / 2, 0);
  return (
    <>
      <color attach="background" args={['#eceae5']} />
      <fog attach="fog" args={['#eceae5', 90, 190]} />
      <hemisphereLight args={['#ffffff', '#b9b2a6', 0.35]} />
      <directionalLight
        position={[centre[0] - 18, 40, centre[2] + 22]}
        intensity={2.4}
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
      <Environment resolution={128} frames={1} environmentIntensity={0.55}>
        <Lightformer form="rect" intensity={2} position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[40, 20, 1]} />
        <Lightformer form="rect" intensity={1} position={[-20, 6, 10]} rotation-y={Math.PI / 2} scale={[30, 6, 1]} />
        <Lightformer form="rect" intensity={0.8} position={[20, 6, -10]} rotation-y={-Math.PI / 2} scale={[30, 6, 1]} color="#ffe2c2" />
      </Environment>
      <Building cat={cat} />
      {cat.shop.items.map((spot, i) => (
        <Thing key={`${spot.item}#${i}`} cat={cat} spot={spot} />
      ))}
      <Highlights cat={cat} part={part} />
      <CameraRig cat={cat} part={part} />
      <Shadows />
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
      sx={{ position: 'absolute', left: 12, bottom: 12, px: 1.5, py: 0.75, borderRadius: 1, bgcolor: 'rgba(17, 20, 57, 0.8)', color: 'text.secondary', fontSize: '0.9rem' }}
    >
      {active ? `Loading the shop: ${loaded} of ${total} models` : `${failed} models couldn't be loaded. Reload the page to try again.`}
    </Typography>
  );
}

/** The shop in 3D. Loaded only in the browser, so three.js stays out of every other bundle. */
export default function ShopCanvas({ cat, part }: { cat: Catalog; part: LivePart }) {
  return (
    <>
      <Canvas
        shadows={{ type: PCFShadowMap }}
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: FOV, near: 0.05, far: 400, position: overviewPose(cat).position }}
        gl={{ antialias: true }}
        onPointerMissed={() => useShowcase.getState().hover(null)}
      >
        <Scene cat={cat} part={part} />
      </Canvas>
      <LoadStatus />
    </>
  );
}
