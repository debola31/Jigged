// Where the camera goes: the whole shop, a thing, a step's place at its machine, a zone, and the
// walk along the main aisle. Pure arithmetic in scene metres (see catalog.ts for the frames), so it
// can be tested without a GPU; ShopCanvas plays the poses.
import { spotBox, toPlan, toScene, type Catalog, type Vec3 } from './catalog';
import type { Step, Where } from './showcaseData';

export interface Pose {
  position: Vec3;
  target: Vec3;
}

/** A move of the walk: where to, how long it takes, and the station it stops at, if any. */
export interface Leg extends Pose {
  ms: number;
  stop?: string;
}

const EYE_MM = 1600;
const WALK_MM_S = 4000;
const TURN_MS = 900;
const HOLD_MS = 1800;
// A vertical mill's table, from the floor: where a person at the door looks for the vise.
const TABLE_MM = 950;

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** How far back along `dir` the camera has to be for every corner to be in view. */
function fitDistance(corners: Vec3[], target: Vec3, dir: Vec3, tanH: number, tanV: number): number {
  const forward: Vec3 = [-dir[0], -dir[1], -dir[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  // A corner at `rel` from the target is in view once its depth covers its offset across and up.
  return Math.max(
    ...corners.map((c) => {
      const rel: Vec3 = [c[0] - target[0], c[1] - target[1], c[2] - target[2]];
      const depth = dot(rel, forward);
      return Math.max(Math.abs(dot(rel, right)) / tanH - depth, Math.abs(dot(rel, up)) / tanV - depth);
    }),
  );
}

/**
 * The whole building from above its south-west, as close as keeps every corner of its floor and
 * walls in view. `aspect` is the view's, less what cards cover: a narrow view looks more along the
 * building's length, a wide one more across it, whichever frames it largest.
 */
export function overviewPose(cat: Catalog, aspect = 1.6, fovDeg = 40): Pose {
  const [w, d] = cat.shop.building.size;
  const h = cat.shop.building.wall_height;
  const target = toScene(w / 2, d / 2, 0);
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * 0.92;
  const tanH = tanV * aspect;
  // The walls' full height at every corner: only the south wall, between them, is cut down while
  // the camera is south of the building (Room.tsx).
  const corners = [0, w].flatMap((x) => [0, d].flatMap((y) => [toScene(x, y, 0), toScene(x, y, h)]));
  // 38° above the floor, from between 25° and 70° west of south.
  const rise = (38 * Math.PI) / 180;
  const fits = [25, 35, 45, 55, 70].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const dir: Vec3 = [-Math.sin(a) * Math.cos(rise), Math.sin(rise), Math.cos(a) * Math.cos(rise)];
    return { dir, distance: fitDistance(corners, target, dir, tanH, tanV) };
  });
  const best = fits.reduce((a, b) => (b.distance < a.distance ? b : a));
  return { target, position: add(target, best.dir, best.distance) };
}

/** A thing from a little off its front, so its front and one side both show, filling the view. */
export function itemPose(cat: Catalog, id: string, fovDeg: number): Pose | null {
  const spot = cat.spots.get(id)?.[0];
  if (!spot) return null;
  const { center, size, front } = spotBox(cat.shop.assets[spot.asset], spot);
  const radius = Math.max(0.2, Math.hypot(...size) / 2);
  const dist = (radius / Math.sin((fovDeg * Math.PI) / 360)) * 1.1;
  const turn = (20 * Math.PI) / 180;
  const dir = norm([front[0], 0.75, front[2]]);
  const off: Vec3 = [dir[0] * Math.cos(turn) + dir[2] * Math.sin(turn), dir[1], -dir[0] * Math.sin(turn) + dir[2] * Math.cos(turn)];
  return { target: center, position: add(center, off, dist) };
}

/** The middle of a zone's things (plan mm), which can sit off the zone's own centre. */
export function zoneCentre(cat: Catalog, where: Where): [number, number] {
  const rect = cat.shop.zones.find((z) => z.name === where.name)?.rect;
  const inside = rect
    ? [...cat.shop.items, ...cat.shop.furniture].filter((t) => t.x >= rect[0] && t.x <= rect[2] && t.y >= rect[1] && t.y <= rect[3])
    : [];
  if (!inside.length) return [where.x, where.y];
  return [inside.reduce((s, t) => s + t.x, 0) / inside.length, inside.reduce((s, t) => s + t.y, 0) / inside.length];
}

/** A zone from the south, the way its floor label reads, centred on its things. */
export function zonePose(cat: Catalog, where: Where): Pose {
  const target = toScene(...zoneCentre(cat, where), 0);
  return { target, position: add(target, [0, 9, 11]) };
}

/**
 * Where a step is done. At a machine's table: a few steps back from its door, the whole front in
 * view, looking at the table (until the doors are glass, closer only shows the doors). At its
 * pendant: in front of the control, on the operator's right. Anywhere else: its zone.
 */
export function stepPose(cat: Catalog, step: Step, fovDeg: number): Pose {
  const spot = step.where.item ? cat.spots.get(step.where.item)?.[0] : undefined;
  if (!spot) return zonePose(cat, step.where);
  if (!step.where.at) return itemPose(cat, spot.item, fovDeg)!;
  const { center, size, front } = spotBox(cat.shop.assets[spot.asset], spot);
  const halfDepth = (Math.abs(front[0]) * size[0] + Math.abs(front[2]) * size[2]) / 2;
  const halfWidth = (Math.abs(front[2]) * size[0] + Math.abs(front[0]) * size[2]) / 2;
  const [rx, ry] = toPlan(0, 0, spot.rot, 1, 0);
  const right: Vec3 = [rx, 0, -ry];
  if (step.where.at === 'pendant') {
    const target = add(add([center[0], 1.45, center[2]], front, halfDepth), right, halfWidth * 0.75);
    return { target, position: add(add(target, front, 1.3), [0, 0.15, 0]) };
  }
  const target = add([center[0], TABLE_MM / 1000, center[2]], front, halfDepth * 0.3);
  return { target, position: add([center[0], EYE_MM / 1000 + 0.45, center[2]], front, halfDepth + 2.2) };
}

/** The middle of a station, a machine half-way up or a zone at bench height, for the walk to face. */
function stationPoint(cat: Catalog, where: Where): Vec3 {
  const spot = where.item ? cat.spots.get(where.item)?.[0] : undefined;
  if (!spot) return toScene(...zoneCentre(cat, where), 900);
  const { center, size } = spotBox(cat.shop.assets[spot.asset], spot);
  return [center[0], size[1] * 0.45, center[2]];
}

/**
 * Walk the shop at eye height: in at the west end of the main aisle (the front door), along it to
 * each station of the part's route in turn, stopping across the aisle to face it, then to `end`.
 * Every zone opens onto the main aisle, which runs east-west.
 */
export function walkLegs(cat: Catalog, route: Where[], end: Pose): Leg[] {
  const [x0, y0, x1, y1] = cat.shop.aisles.reduce((a, b) => (b.rect[2] - b.rect[0] > a.rect[2] - a.rect[0] ? b : a)).rect;
  const eye = (x: number, y: number) => toScene(x, y, EYE_MM);
  const ahead = (x: number, y: number, dir: number) => toScene(x + dir * 8000, y, EYE_MM);
  let [x, y] = [x0 + 1500, (y0 + y1) / 2];
  const legs: Leg[] = [{ position: eye(x, y), target: ahead(x, y, 1), ms: 1600 }];
  for (const where of route) {
    const [px, py] = where.item ? [where.x, where.y] : zoneCentre(cat, where);
    const [sx, sy] = [Math.min(x1 - 1500, Math.max(x0 + 1500, px)), py < (y0 + y1) / 2 ? y1 - 500 : y0 + 500];
    const dir = Math.sign(sx - x) || 1;
    const facing = { position: eye(sx, sy), target: stationPoint(cat, where) };
    legs.push(
      { position: eye(sx, sy), target: ahead(sx, sy, dir), ms: Math.max(800, (Math.hypot(sx - x, sy - y) / WALK_MM_S) * 1000) },
      { ...facing, ms: TURN_MS, stop: where.name },
      { ...facing, ms: HOLD_MS, stop: where.name },
    );
    [x, y] = [sx, sy];
  }
  legs.push({ ...end, ms: 1600 });
  return legs;
}
