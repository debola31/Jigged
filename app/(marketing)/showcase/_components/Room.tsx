'use client';

// The shop's room: a sealed concrete floor with saw-cut joints and painted aisle lines, two-tone
// painted block walls, a roof of open-web joists and high-bay lights, and the light that goes with
// them (the CC0 Poly Haven HDRI the step videos use, contact shadows under everything that stands on
// the floor, and one reflection probe for metals). The walls the camera is outside are cut down to
// their band and the roof fades as the camera rises, so the overview and the walk still see in.
//
// Nothing here loads before the shop draws: the floor and walls start as plain colours, and their
// tiles and the HDRI (about 2 MB, from the bucket's room/ prefix) follow once the models are in.

import { Environment, Lightformer, useProgress } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as Sentry from '@sentry/nextjs';
import { useEffect, useMemo, useState } from 'react';
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CubeCamera,
  CylinderGeometry,
  DoubleSide,
  EquirectangularReflectionMapping,
  BufferGeometry,
  Group,
  HalfFloatType,
  InstancedMesh,
  Line,
  LinearSRGBColorSpace,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PMREMGenerator,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  TextureLoader,
  UniformsUtils,
  UnsignedByteType,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  type DataTexture,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toError } from '@/lib/supabaseErrors';
import { toScene, type Catalog, type Vec3 } from './catalog';
import { mediaUrl, type Rect } from './showcaseData';

const AMBER = '#D4872A';
/**
 * The height a wall is cut down to while the camera is outside it: its dark lower band, so the
 * overview (and anyone outside) sees in over it. The walls the camera is inside stand full height.
 */
const CUT_M = 1.2;
/** The floor tile: one pour between saw-cut control joints. */
const SLAB_M = 4;
/** The block tile: three 400 mm blocks by six 200 mm courses, in running bond. */
const BLOCK_M = 1.2;
const WALL_T = 0.2;
const LINE_M = 0.1;
const JOIST_PITCH = 2.4;
/** The joists' chords below the deck, and the high bays' lenses. */
const CHORDS_M = [0.6, 0.05];
const LENS_DROP = 1.4;
/** The roof shows below the first height, inside the building, and is gone above the second. */
const ROOF_SOLID = 3.6;
const ROOF_GONE = 4.4;
/** What darkens the floor under a thing: anything this close above it. */
const CONTACT_M = 0.9;
/** Even if the models never settle, the room's media starts this long after the shop mounts. */
const MEDIA_AFTER_MS = 15000;
/** look.py's strength for the HDRI (turned half a turn: Blender and three put the equirect's centre on opposite sides). */
const ENV_INTENSITY = 0.6;

const lin = (r: number, g: number, b: number) => new Color().setRGB(r, g, b, LinearSRGBColorSpace);
// Factors over the tiles, from the realism spike's material library; the plain colours are the
// tiles' means times the factor, so nothing jumps when the tiles arrive.
const WALL_UPPER = lin(0.62, 0.62, 0.6);
const WALL_BAND = lin(0.16, 0.17, 0.18);
const WALL_TILE_MEAN = 0.61;
const FLOOR_PLAIN = lin(0.242, 0.235, 0.229);
const LINE_PLAIN = lin(0.6, 0.414, 0.013);

/**
 * `models`: the light models are in and have settled. `settled`: the room is dressed and the
 * probe drawn, too. Read by the realistic models' stream, and by scripts and tests.
 */
export const roomStatus = { models: false, settled: false };

let redrawer: (() => void) | null = null;
let probeTexture: Texture | null = null;

/**
 * Draws the shop's static shadow map, contact shadows and reflection probe again, once: for when
 * what shows has changed without a model arriving, as when realistic models swap in.
 */
export function redrawRoom() {
  redrawer?.();
}

/** The reflection probe's environment, once drawn, for the metals of a model that arrives later. */
export function roomProbe(): Texture | null {
  return probeTexture;
}

// --- geometry -----------------------------------------------------------------------------------

/** A box from `lo` to `hi` (scene metres), its UVs in tiles of `tile` metres so a texture lies at one scale on every face. */
function worldBox(lo: Vec3, hi: Vec3, tile: number): BoxGeometry {
  const g = new BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  g.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  const { position: p, normal: n, uv } = g.attributes;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, p.getX(i) / tile, p.getZ(i) / tile);
    else if (Math.abs(n.getX(i)) > 0.5) uv.setXY(i, p.getZ(i) / tile, p.getY(i) / tile);
    else uv.setXY(i, p.getX(i) / tile, p.getY(i) / tile);
  }
  return g;
}

/** A flat strip on the floor over a plan rect (mm), its UVs in metres. */
function floorStrip(r: Rect, lift: number): PlaneGeometry {
  const g = new PlaneGeometry((r[2] - r[0]) / 1000, (r[3] - r[1]) / 1000);
  g.rotateX(-Math.PI / 2);
  const [x, , z] = toScene((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 0);
  g.translate(x, lift, z);
  const { position: p, uv } = g.attributes;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), -p.getZ(i));
  return g;
}

/**
 * The aisles' painted edges, 100 mm inside each long side. Where aisles cross, each one's lines
 * stop at the other's edge, as they're painted.
 */
function aisleLines(aisles: { rect: Rect }[]): Rect[] {
  const lines: Rect[] = [];
  for (const a of aisles) {
    const [x0, y0, x1, y1] = a.rect;
    const along = x1 - x0 > y1 - y0;
    const w = LINE_M * 1000;
    const edges: Rect[] = along ? [[x0, y0, x1, y0 + w], [x0, y1 - w, x1, y1]] : [[x0, y0, x0 + w, y1], [x1 - w, y0, x1, y1]];
    for (const e of edges) {
      // The stretches of this line no other aisle crosses.
      let runs: [number, number][] = [along ? [e[0], e[2]] : [e[1], e[3]]];
      for (const b of aisles) {
        if (b === a) continue;
        const [cut0, cut1] = along ? [b.rect[0], b.rect[2]] : [b.rect[1], b.rect[3]];
        const crosses = along ? b.rect[1] <= e[1] && b.rect[3] >= e[3] : b.rect[0] <= e[0] && b.rect[2] >= e[2];
        if (!crosses) continue;
        runs = runs.flatMap(([s, t]): [number, number][] => [
          ...(cut0 > s ? [[s, Math.min(t, cut0)] as [number, number]] : []),
          ...(cut1 < t ? [[Math.max(s, cut1), t] as [number, number]] : []),
        ]).filter(([s, t]) => t - s > 1);
      }
      for (const [s, t] of runs) lines.push(along ? [s, e[1], t, e[3]] : [e[0], s, e[2], t]);
    }
  }
  return lines;
}

/** A 1.5 in B-deck's rib across its 152 mm pitch, as [from, to, slope] fractions of the pitch: flute, web, rib top, web. */
const RIB: [number, number, number][] = [
  [0, 0.23, 0],
  [0.23, 0.36, 1],
  [0.36, 0.87, 0],
  [0.87, 1, -1],
];
const RIB_PITCH = 0.152;

/** A roll-up door's slat: a groove where it hinges to the next, the rest flat. */
const SLAT: [number, number, number][] = [
  [0, 0.08, 1],
  [0.08, 0.16, -1],
  [0.16, 1, 0],
];
const SLAT_PITCH = 0.076;

/**
 * A profile that repeats one way, like a deck's ribs or a door's slats, as a normal map and a
 * colour map one repeat tall. Drawn in, ribs shimmer in the distance; a texture's mipmaps fade them.
 */
function stripes(profile: [number, number, number][], shade: (slope: number, at: number) => number) {
  const px = 64;
  const make = (paint: (slope: number, at: number) => [number, number, number]) => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      for (let y = 0; y < px; y++) {
        const at = (y + 0.5) / px;
        const slope = profile.find(([a, b]) => at >= a && at < b)?.[2] ?? 0;
        const [r, g, b] = paint(slope, at);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, y, 4, 1);
      }
    }
    const t = new CanvasTexture(canvas);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  // Slopes lean 45 degrees in the normal map, softer than a deck's real 62, which reads as stripes.
  const lean = Math.SQRT1_2;
  const normal = make((slope) => [128, Math.round(128 + slope * lean * 127), Math.round(128 + (slope ? lean : 1) * 127)]);
  const colour = make((slope, at) => {
    const v = Math.round(255 * shade(slope, at));
    return [v, v, v];
  });
  colour.colorSpace = SRGBColorSpace;
  return { normal, colour };
}

/** One round LED high bay, its lens at the origin: the housing, its fins, the driver and the hanger up to `hang` metres. */
function fixtureGeometry(hang: number): { body: BufferGeometry; lens: BufferGeometry } {
  const at = (g: BufferGeometry, y: number) => g.translate(0, y, 0);
  const body = mergeGeometries([
    at(new CylinderGeometry(0.165, 0.165, 0.07, 32), 0.04),
    at(new CylinderGeometry(0.17, 0.12, 0.06, 24), 0.105),
    at(new CylinderGeometry(0.06, 0.06, 0.09, 16), 0.18),
    at(new CylinderGeometry(0.004, 0.004, hang - 0.225, 6, 1, true), 0.225 + (hang - 0.225) / 2),
  ]);
  return { body, lens: at(new CylinderGeometry(0.15, 0.15, 0.006, 32), 0.003) };
}

function instances(geometry: BufferGeometry, material: MeshStandardMaterial | MeshBasicMaterial, matrices: Matrix4[]): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.computeBoundingSphere();
  return mesh;
}

// --- materials ----------------------------------------------------------------------------------

const FLOOR_VERTEX = /* glsl */ `
varying vec2 vPlan;
uniform vec2 uSize;`;

const FLOOR_FRAGMENT = /* glsl */ `
varying vec2 vPlan;
uniform vec2 uSize;
uniform sampler2D uContact;
uniform float uContactOn;
float roomHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float roomNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(roomHash(i), roomHash(i + vec2(1.0, 0.0)), u.x), mix(roomHash(i + vec2(0.0, 1.0)), roomHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Each pour mirrors the tile its own way, so its stains don't repeat every 4 m; the joints lie on
// the tile's edges, so they still meet. The normal map's frame comes from these UVs' derivatives,
// so it mirrors with them.
vec2 slabFlip(vec2 uv) {
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  return cell + mix(f, 1.0 - f, step(0.5, vec2(roomHash(cell + 3.1), roomHash(cell + 11.7))));
}`;

const FLOOR_UVS = /* glsl */ `
#ifdef USE_MAP
  vec2 slabMapUv = slabFlip(vMapUv);
  #define vMapUv slabMapUv
#endif
#ifdef USE_NORMALMAP
  vec2 slabNormalUv = slabFlip(vNormalMapUv);
  #define vNormalMapUv slabNormalUv
#endif
#ifdef USE_ROUGHNESSMAP
  vec2 slabRoughUv = slabFlip(vRoughnessMapUv);
  #define vRoughnessMapUv slabRoughUv
#endif`;

/**
 * Sealed concrete over the building's footprint: the tiles, a shade apart per pour, clouded at a
 * few scales so the 4 m tile doesn't repeat, and darkened where things stand on it.
 */
function floorMaterial(w: number, d: number, contact: Texture) {
  const uniforms = { uSize: { value: [w, d] }, uContact: { value: contact }, uContactOn: { value: 0 } };
  const material = new MeshStandardMaterial({ color: FLOOR_PLAIN, roughness: 0.38, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${FLOOR_VERTEX}\nvoid main() {`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPlan = uv * uSize;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${FLOOR_FRAGMENT}\nvoid main() {\n${FLOOR_UVS}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float pour = roomHash(floor(vPlan / ${SLAB_M.toFixed(1)}) + 7.0) - 0.5;
        float cloud = roomNoise(vPlan * 0.17) * 0.55 + roomNoise(vPlan * 0.7 + 17.0) * 0.3 + roomNoise(vPlan * 2.9 + 41.0) * 0.15;
        diffuseColor.rgb *= 1.0 + pour * 0.08 + (cloud - 0.5) * 0.18;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = max(roughnessFactor * (1.0 + (cloud - 0.5) * 0.35), 0.4);')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        float contact = texture2D(uContact, vec2(vPlan.x / uSize.x, 1.0 - vPlan.y / uSize.y)).a * uContactOn;
        float settled = 1.0 - 0.8 * contact;
        reflectedLight.indirectDiffuse *= settled;
        reflectedLight.indirectSpecular *= settled;
        reflectedLight.directDiffuse *= 1.0 - 0.45 * contact;`,
      );
  };
  material.customProgramCacheKey = () => 'showcase-floor';
  return { material, uniforms };
}

// --- contact shadows ----------------------------------------------------------------------------

/**
 * The floor's contact shadows: the shop drawn once from just under the floor, looking up, where
 * whatever is within CONTACT_M of the floor darkens it more the closer it is, then blurred. Drawn
 * again only when a model arrives, since nothing in the shop moves.
 */
class ContactShadows {
  readonly target: WebGLRenderTarget;
  private readonly spare: WebGLRenderTarget;
  private readonly camera: OrthographicCamera;
  // Both sides: a model's underside is often open, and from below its insides are what's there.
  private readonly depth = new MeshDepthMaterial({ side: DoubleSide });
  private readonly across = new ShaderMaterial({ ...HorizontalBlurShader, uniforms: UniformsUtils.clone(HorizontalBlurShader.uniforms), depthTest: false });
  private readonly down = new ShaderMaterial({ ...VerticalBlurShader, uniforms: UniformsUtils.clone(VerticalBlurShader.uniforms), depthTest: false });
  private readonly quad = new FullScreenQuad();
  private readonly px: [number, number];

  constructor(w: number, d: number) {
    // About 2.7 cm a texel either way.
    this.px = [2048, Math.round((2048 * d) / w)];
    this.target = new WebGLRenderTarget(...this.px);
    this.spare = new WebGLRenderTarget(...this.px);
    this.target.texture.generateMipmaps = this.spare.texture.generateMipmaps = false;
    this.camera = new OrthographicCamera(-w / 2, w / 2, d / 2, -d / 2, 0, CONTACT_M + 0.01);
    this.camera.position.set(w / 2, -0.01, -d / 2);
    this.camera.rotation.x = Math.PI / 2;
    this.camera.updateMatrixWorld();
    this.depth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'float near = 1.0 - fragCoordZ; gl_FragColor = vec4( 0.0, 0.0, 0.0, near * near );',
      );
    };
  }

  render(gl: WebGLRenderer, scene: Scene) {
    const hidden = hideForPasses(scene, true);
    const { background, overrideMaterial } = scene;
    const target = gl.getRenderTarget();
    const clear = gl.getClearColor(new Color());
    const alpha = gl.getClearAlpha();
    const shadows = gl.shadowMap.needsUpdate;
    gl.shadowMap.needsUpdate = false;
    scene.background = null;
    scene.overrideMaterial = this.depth;
    gl.setRenderTarget(this.target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, this.camera);
    scene.background = background;
    scene.overrideMaterial = overrideMaterial;
    this.blur(gl, 6);
    this.blur(gl, 2.5);
    this.blur(gl, 1);
    gl.setRenderTarget(target);
    gl.setClearColor(clear, alpha);
    gl.shadowMap.needsUpdate = shadows;
    hidden.forEach((o) => (o.visible = true));
  }

  private blur(gl: WebGLRenderer, texels: number) {
    this.across.uniforms.tDiffuse.value = this.target.texture;
    this.across.uniforms.h.value = texels / this.px[0];
    this.quad.material = this.across;
    gl.setRenderTarget(this.spare);
    this.quad.render(gl);
    this.down.uniforms.tDiffuse.value = this.spare.texture;
    this.down.uniforms.v.value = texels / this.px[1];
    this.quad.material = this.down;
    gl.setRenderTarget(this.target);
    this.quad.render(gl);
  }

  dispose() {
    this.target.dispose();
    this.spare.dispose();
    this.depth.dispose();
    this.across.dispose();
    this.down.dispose();
    this.quad.dispose();
  }
}

/**
 * Hides what a pass mustn't draw: outlines always. The probe leaves out the invisible boxes things
 * are picked by; the contact shadows keep them, since they give a machine whose model is open
 * underneath its footprint, and leave out what lies flat on the floor (`userData.flat`) instead.
 */
function hideForPasses(scene: Scene, contact = false): Object3D[] {
  const hidden: Object3D[] = [];
  scene.traverse((o) => {
    if (o.visible && (o instanceof Line || (contact ? o.userData.flat : o.userData.pick))) {
      o.visible = false;
      hidden.push(o);
    }
  });
  return hidden;
}

// --- the room -----------------------------------------------------------------------------------

interface Media {
  floor: [Texture, Texture, Texture];
  wall: [Texture, Texture, Texture];
  line: Texture;
  env: DataTexture;
}

async function loadMedia(gl: WebGLRenderer): Promise<Media> {
  // Its own manager, so these don't count as the shop's models in the load status.
  const manager = new LoadingManager();
  const loader = new TextureLoader(manager);
  const anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
  const tile = async (file: string, colour = false) => {
    const t = await loader.loadAsync(mediaUrl(`room/${file}`));
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = anisotropy;
    if (colour) t.colorSpace = SRGBColorSpace;
    return t;
  };
  const [floorColour, floorNormal, floorRough, wallColour, wallNormal, wallRough, line, env] = await Promise.all([
    tile('floor_color.webp', true),
    tile('floor_normal.webp'),
    tile('floor_rough.webp'),
    tile('wall_color.webp', true),
    tile('wall_normal.webp'),
    tile('wall_rough.webp'),
    tile('line_color.webp', true),
    new HDRLoader(manager).loadAsync(mediaUrl('room/machine_shop_02_1k.hdr')),
  ]);
  env.mapping = EquirectangularReflectionMapping;
  return { floor: [floorColour, floorNormal, floorRough], wall: [wallColour, wallNormal, wallRough], line, env };
}

let mediaFailures = 0;
function reportMedia(error: unknown) {
  // The room stays in its plain colours; one report per page.
  if (mediaFailures++ === 0) Sentry.captureException(toError(error, "Showcase: the shop room's textures failed to load"));
}

function buildRoom(cat: Catalog) {
  const { building, aisles } = cat.shop;
  const [w, d] = building.size.map((v) => v / 1000);
  const h = building.wall_height / 1000;
  const cut = CUT_M;
  const root = new Group();
  root.name = 'room';
  const contact = new ContactShadows(w, d);

  // The floor.
  const floor = floorMaterial(w, d, contact.target.texture);
  const slab = new Mesh(new PlaneGeometry(w, d), floor.material);
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(w / 2, 0, -d / 2);
  slab.receiveShadow = true;
  slab.userData.flat = true;
  root.add(slab);

  const line = new MeshStandardMaterial({ color: LINE_PLAIN, roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const lines = new Mesh(mergeGeometries(aisleLines(aisles).map((r) => floorStrip(r, 0.003))), line);
  lines.receiveShadow = true;
  lines.userData.flat = true;
  root.add(lines);

  // The walls: a dark band below the cut, light block above it; each with the inward way it faces.
  const band = new MeshStandardMaterial({ color: WALL_BAND.clone().multiplyScalar(WALL_TILE_MEAN), roughness: 0.72 });
  const upper = new MeshStandardMaterial({ color: WALL_UPPER.clone().multiplyScalar(WALL_TILE_MEAN), roughness: 0.72 });
  const door = new MeshStandardMaterial({ color: AMBER, roughness: 0.55 });
  const slats = stripes(SLAT, (slope) => (slope ? 0.8 : 1));
  for (const tex of [slats.normal, slats.colour]) tex.repeat.set(1, 1 / SLAT_PITCH);
  const rollUp = new MeshStandardMaterial({ color: AMBER, map: slats.colour, normalMap: slats.normal, roughness: 0.5 });
  const t = WALL_T;
  const sides = [
    { lo: [-t, 0, 0] as Vec3, hi: [w + t, 0, t] as Vec3, inward: new Vector3(0, 0, -1), at: new Vector3(0, 0, 0) },
    { lo: [-t, 0, -d - t] as Vec3, hi: [w + t, 0, -d] as Vec3, inward: new Vector3(0, 0, 1), at: new Vector3(0, 0, -d) },
    { lo: [-t, 0, -d] as Vec3, hi: [0, 0, 0] as Vec3, inward: new Vector3(1, 0, 0), at: new Vector3(0, 0, 0) },
    { lo: [w, 0, -d] as Vec3, hi: [w + t, 0, 0] as Vec3, inward: new Vector3(-1, 0, 0), at: new Vector3(w, 0, 0) },
  ];
  const walls = sides.map((s) => {
    const lower = new Mesh(worldBox([s.lo[0], 0, s.lo[2]], [s.hi[0], cut, s.hi[2]], BLOCK_M), band);
    const top = new Group();
    top.add(new Mesh(worldBox([s.lo[0], cut, s.lo[2]], [s.hi[0], h, s.hi[2]], BLOCK_M), upper));
    lower.receiveShadow = true;
    top.children[0].receiveShadow = true;
    root.add(lower, top);
    return { ...s, upper: top, lower };
  });
  // The doors, proud of both faces of their wall, split at the cut like it.
  for (const r of building.doors ?? []) {
    const [x0, z1] = [r.rect[0] / 1000, -r.rect[1] / 1000];
    const [x1, z0] = [r.rect[2] / 1000, -r.rect[3] / 1000];
    const onEnd = Math.abs((x0 + x1) / 2) < 0.5 || Math.abs((x0 + x1) / 2 - w) < 0.5;
    const wall = walls[onEnd ? ((x0 + x1) / 2 < w / 2 ? 2 : 3) : (z0 + z1) / 2 > -d / 2 ? 0 : 1];
    const span = onEnd ? z1 - z0 : x1 - x0;
    // A roll-up door is taller than a person's: a door's height from its width, 2.2 m to 4.3 m.
    const tall = Math.min(4.3, Math.max(2.2, span * 1.08));
    const [lo, hi] = onEnd
      ? [[wall.lo[0] - 0.03, 0, z0], [wall.hi[0] + 0.03, 0, z1]]
      : [[x0, 0, wall.lo[2] - 0.03], [x1, 0, wall.hi[2] + 0.03]];
    const part = (y0: number, y1: number) => new Mesh(worldBox([lo[0], y0, lo[2]], [hi[0], y1, hi[2]], 1), tall > 3 ? rollUp : door);
    root.add(part(0, Math.min(cut, tall)));
    if (tall > cut) wall.upper.add(part(cut, tall));
  }

  // The roof: a ribbed deck on open-web joists every 2.4 m, spanning north-south, and a round high
  // bay hung from every other joist. Faded as one, so its materials are transparent throughout.
  const roof = new Group();
  const fade = { transparent: true, depthWrite: true };
  // The flutes a shade darker than the rib tops, as the light reaches them less.
  const ribs = stripes(RIB, (slope, at) => (at < 0.23 ? 0.81 : slope ? 0.855 : 0.925));
  for (const tex of [ribs.normal, ribs.colour]) tex.repeat.set(1, d / RIB_PITCH);
  const deck = new MeshStandardMaterial({ color: lin(0.75, 0.75, 0.74), map: ribs.colour, normalMap: ribs.normal, roughness: 0.55, ...fade });
  const steel = new MeshStandardMaterial({ color: lin(0.3, 0.3, 0.29), roughness: 0.6, ...fade });
  const alu = new MeshStandardMaterial({ color: lin(0.8, 0.8, 0.8), metalness: 1, roughness: 0.4, ...fade });
  const lens = new MeshBasicMaterial({ color: lin(6, 5.8, 5.5), ...fade });
  const deckPlane = new PlaneGeometry(w, d);
  deckPlane.rotateX(Math.PI / 2);
  deckPlane.translate(w / 2, h, -d / 2);
  roof.add(new Mesh(deckPlane, deck));
  const joistX = Array.from({ length: Math.floor((w - 0.2) / JOIST_PITCH) }, (_, k) => (k + 1) * JOIST_PITCH);
  const [bottom, top] = [h - CHORDS_M[0], h - CHORDS_M[1]];
  const chord = new BoxGeometry(0.1, 0.05, d);
  roof.add(
    instances(
      chord,
      steel,
      joistX.flatMap((x) => [bottom + 0.025, top - 0.025].map((y) => new Matrix4().makeTranslation(x, y, -d / 2))),
    ),
  );
  const rod = new CylinderGeometry(0.011, 0.011, 1, 6, 1, true);
  const webs: Matrix4[] = [];
  const up = new Vector3(0, 1, 0);
  for (const x of joistX) {
    for (let z = 0.15, rising = true; z + 0.6 < d; z += 0.6, rising = !rising) {
      const a = new Vector3(x, rising ? bottom + 0.05 : top - 0.05, -z);
      const b = new Vector3(x, rising ? top - 0.05 : bottom + 0.05, -z - 0.6);
      const along = b.clone().sub(a);
      webs.push(new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new Quaternion().setFromUnitVectors(up, along.clone().normalize()), new Vector3(1, along.length(), 1)));
    }
  }
  roof.add(instances(rod, steel, webs));
  const lensY = h - LENS_DROP;
  const fixture = fixtureGeometry(bottom - lensY);
  const bays = joistX
    .filter((_, k) => k % 2 === 0)
    .flatMap((x) => [0.2, 0.5, 0.8].map((f) => new Matrix4().makeTranslation(x, lensY, -d * f)))
    .filter((m) => m.elements[12] < w - 1);
  roof.add(instances(fixture.body, alu, bays), instances(fixture.lens, lens, bays));
  root.add(roof);
  const roofMaterials = [deck, steel, alu, lens];

  const toward = new Vector3();
  /** Cuts the walls the eye is outside down to their band and fades the roof; `null` shows it all, as from inside. */
  const cutaway = (eye: Vector3 | null) => {
    for (const wall of walls) wall.upper.visible = !eye || toward.subVectors(eye, wall.at).dot(wall.inward) > 0;
    const inside = !eye || (eye.x > 0 && eye.x < w && eye.z < 0 && eye.z > -d);
    const k = !eye ? 1 : inside ? Math.min(1, Math.max(0, (ROOF_GONE - eye.y) / (ROOF_GONE - ROOF_SOLID))) : 0;
    roof.visible = k > 0.01;
    for (const m of roofMaterials) m.opacity = k;
  };

  /** The tiles, once they're in. */
  const dress = (media: Media) => {
    const [fc, fn, fr] = media.floor;
    for (const tex of media.floor) tex.repeat.set(w / SLAB_M, d / SLAB_M);
    // Over the tile's roughness: sealed, but no more than satin. Smoother, its stains glint white.
    Object.assign(floor.material, { map: fc, normalMap: fn, roughnessMap: fr, roughness: 1.35 });
    floor.material.color.setRGB(1, 1, 1);
    const [wc, wn, wr] = media.wall;
    for (const [m, factor] of [
      [band, WALL_BAND],
      [upper, WALL_UPPER],
    ] as const) {
      Object.assign(m, { map: wc, normalMap: wn, roughnessMap: wr, roughness: 1 });
      m.color.copy(factor);
    }
    Object.assign(line, { map: media.line });
    line.color.setRGB(1, 1, 1);
    for (const m of [floor.material, band, upper, line]) m.needsUpdate = true;
  };

  const dispose = () => {
    root.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    for (const m of [floor.material, line, band, upper, door, rollUp, ...roofMaterials]) m.dispose();
    for (const tex of [ribs.normal, ribs.colour, slats.normal, slats.colour]) tex.dispose();
    contact.dispose();
  };

  return { root, contact, floorUniforms: floor.uniforms, cutaway, dress, dispose };
}

/** Points metallic materials at the probe instead of the HDRI's room, which isn't this one. */
function lightMetals(scene: Scene, env: Texture) {
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (const m of [o.material].flat()) {
      if (m instanceof MeshStandardMaterial && m.metalness >= 0.5 && m.envMap !== env) {
        m.envMap = env;
        m.needsUpdate = true;
      }
    }
  });
}

/** One cube render of the shop from over the middle of the main aisle, walls up and roof on, into PMREM. */
function renderProbe(gl: WebGLRenderer, scene: Scene, at: Vec3, cutaway: (eye: Vector3 | null) => void, eye: Vector3): WebGLRenderTarget {
  // Half float where the GPU can draw into it, for the high bays' brightness; bytes otherwise.
  const float = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
  const cube = new WebGLCubeRenderTarget(256, { type: float ? HalfFloatType : UnsignedByteType });
  const camera = new CubeCamera(0.05, 120, cube);
  camera.position.set(...at);
  const hidden = hideForPasses(scene);
  cutaway(null);
  scene.add(camera);
  camera.update(gl, scene);
  scene.remove(camera);
  cutaway(eye);
  hidden.forEach((o) => (o.visible = true));
  const pmrem = new PMREMGenerator(gl);
  const env = pmrem.fromCubemap(cube.texture);
  pmrem.dispose();
  cube.dispose();
  return env;
}

/**
 * The room and its light. Until the HDRI is in, the shop is lit by a few soft panels, as it was
 * before the room had one.
 */
export default function Room({ cat }: { cat: Catalog }) {
  const get = useThree((s) => s.get);
  const room = useMemo(() => buildRoom(cat), [cat]);
  const [env, setEnv] = useState<DataTexture | null>(null);
  useEffect(() => () => room.dispose(), [room]);
  useFrame(({ camera }) => room.cutaway(camera.position));

  useEffect(() => {
    const { gl, scene, invalidate, camera } = get();
    const main = cat.shop.aisles.reduce((a, b) => (b.rect[2] - b.rect[0] > a.rect[2] - a.rect[0] ? b : a)).rect;
    const probeAt = toScene((main[0] + main[2]) / 2, (main[1] + main[3]) / 2, 2500);
    gl.shadowMap.autoUpdate = false;
    roomStatus.models = roomStatus.settled = false;
    const born = performance.now();
    let count = -1;
    let still = 0;
    let probed = -1;
    let started = false;
    let alive = true;
    let media: Media | null = null;
    let probe: WebGLRenderTarget | null = null;
    const drawProbe = () => {
      probe?.dispose();
      probe = renderProbe(gl, scene, probeAt, room.cutaway, camera.position);
      probeTexture = probe.texture;
      lightMetals(scene, probe.texture);
    };
    // What a swap of realistic models asks for once it has settled (Realistic.tsx).
    const redraw = () => {
      room.contact.render(gl, scene);
      gl.shadowMap.needsUpdate = true;
      if (probe) drawProbe();
      invalidate();
    };
    redrawer = redraw;
    // Twice a second, cheaply: a count of meshes. A new model draws the shadows and the contact
    // shadows again; once the models have settled, the room's media loads and then the probe.
    // Realistic models arrive hidden and change nothing drawn, so they don't count.
    const id = window.setInterval(() => {
      let n = 0;
      scene.traverse((o) => {
        if (o instanceof Mesh && !o.userData.realistic) n += 1;
      });
      if (n !== count) {
        count = n;
        still = 0;
        room.contact.render(gl, scene);
        room.floorUniforms.uContactOn.value = 1;
        gl.shadowMap.needsUpdate = true;
        if (probe) lightMetals(scene, probe.texture);
        invalidate();
        return;
      }
      still += 1;
      const settled = still >= 2 && !useProgress.getState().active;
      if (settled) roomStatus.models = true;
      if (!started && (settled || performance.now() - born > MEDIA_AFTER_MS)) {
        started = true;
        loadMedia(gl)
          .then((m) => {
            if (!alive) return;
            media = m;
            room.dress(m);
            setEnv(m.env);
            invalidate();
          })
          .catch(reportMedia);
      }
      if (settled && media && scene.environment === media.env && probed !== count) {
        probed = count;
        drawProbe();
        roomStatus.settled = true;
        invalidate();
      }
    }, 500);
    return () => {
      alive = false;
      window.clearInterval(id);
      if (redrawer === redraw) redrawer = null;
      probeTexture = null;
      gl.shadowMap.autoUpdate = true;
      probe?.dispose();
      if (media) for (const tex of [...media.floor, ...media.wall, media.line, media.env]) tex.dispose();
    };
  }, [get, room, cat]);

  return (
    <>
      {env ? (
        <Environment map={env} environmentIntensity={ENV_INTENSITY} environmentRotation={[0, Math.PI, 0]} />
      ) : (
        <Environment resolution={128} frames={1} environmentIntensity={0.55}>
          <Lightformer form="rect" intensity={2} position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[40, 20, 1]} />
          <Lightformer form="rect" intensity={1} position={[-20, 6, 10]} rotation-y={Math.PI / 2} scale={[30, 6, 1]} />
          <Lightformer form="rect" intensity={0.8} position={[20, 6, -10]} rotation-y={-Math.PI / 2} scale={[30, 6, 1]} color="#ffe2c2" />
        </Environment>
      )}
      <primitive object={room.root} />
    </>
  );
}
