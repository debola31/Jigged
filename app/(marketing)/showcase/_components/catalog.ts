// Lookups and geometry over the shop in showcase.json, shared by the lists, the panels and the 3D
// view. No three.js here, so the lists don't pull it in. Ported from trainual's shop view
// (web/src/shop/catalog.ts), whose frames are the same.
import type { Asset, LivePart, Shop, ShopItem } from './showcaseData';

export type Vec3 = [number, number, number];

export const CATEGORY_LABELS: Record<string, string> = {
  machines: 'Machines',
  workholding: 'Workholding',
  holders: 'Tool holders',
  tools: 'Cutting tools',
  inspection: 'Inspection',
  consumables: 'Consumables',
  hand_tools: 'Hand tools',
  support: 'Support',
  outside_processes: 'Outside processes',
};

/** Plan mm (+Z up) to scene metres (glTF's +Y up): world (x, y, z) lands at (x, z, -y). */
export function toScene(x: number, y: number, z: number): Vec3 {
  return [x / 1000, z / 1000, -y / 1000];
}

/** A point given in a thing's own frame (lx, ly), placed at (x, y) and turned rot degrees about +Z. */
export function toPlan(x: number, y: number, rot: number, lx: number, ly: number): [number, number] {
  const r = (rot * Math.PI) / 180;
  return [x + lx * Math.cos(r) - ly * Math.sin(r), y + lx * Math.sin(r) + ly * Math.cos(r)];
}

/** A thing's box where it stands, in scene metres: centre, size and the way its front faces. */
export function spotBox(asset: Asset, spot: Pick<ShopItem, 'x' | 'y' | 'z' | 'rot'>): { center: Vec3; size: Vec3; front: Vec3 } {
  const { min, max } = asset.bbox;
  const [cx, cy] = toPlan(spot.x, spot.y, spot.rot, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2);
  const quarter = Math.abs(Math.round(spot.rot / 90)) % 2 === 1;
  const w = max[0] - min[0];
  const d = max[1] - min[1];
  // Fronts are each asset's local -Y.
  const [fx, fy] = toPlan(0, 0, spot.rot, 0, -1);
  return {
    center: toScene(cx, cy, spot.z + (min[2] + max[2]) / 2),
    size: [(quarter ? d : w) / 1000, (max[2] - min[2]) / 1000, (quarter ? w : d) / 1000],
    front: [fx, 0, -fy],
  };
}

export interface Catalog {
  shop: Shop;
  /** Every place each thing stands, by its id. */
  spots: Map<string, ShopItem[]>;
  /** Each thing once, in the shop's category order, for the lists. */
  things: ShopItem[];
  zoneName(id: string): string;
}

export function catalog(shop: Shop): Catalog {
  const spots = new Map<string, ShopItem[]>();
  for (const i of shop.items) spots.set(i.item, [...(spots.get(i.item) ?? []), i]);
  const order = new Map(shop.categories.map((c, n) => [c, n]));
  const things = [...spots.values()]
    .map((s) => s[0])
    .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99));
  const zones = new Map(shop.zones.map((z) => [z.id, z.name]));
  return { shop, spots, things, zoneName: (id) => zones.get(id) ?? id };
}

export function matches(t: ShopItem, query: string, zoneName: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [t.item, t.name, t.kind, t.make, t.model, zoneName].join(' ').toLowerCase().replaceAll('_', ' ');
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** The 1-based numbers of the steps that use a thing or happen at it. */
export function stepsUsing(part: LivePart, item: string): number[] {
  return part.steps.flatMap((s, i) => (s.where.item === item || s.uses.some((u) => u.item === item) ? [i + 1] : []));
}

/**
 * What to gather before starting, by where it's kept: each placed thing a step uses, under the
 * bench, cabinet or zone it sits in; things the 3D shop doesn't show yet come last, by name.
 */
export function gatherList(part: LivePart, cat: Catalog, surfaceName: (id: string) => string): { place: string; uses: { name: string; item?: string }[] }[] {
  const places = new Map<string, Map<string, { name: string; item?: string }>>();
  const add = (place: string, key: string, use: { name: string; item?: string }) => {
    if (!places.has(place)) places.set(place, new Map());
    places.get(place)!.set(key, use);
  };
  for (const s of part.steps) {
    for (const u of s.uses) {
      const t = u.item ? cat.spots.get(u.item)?.[0] : undefined;
      if (t) add(t.on ? surfaceName(t.on) : cat.zoneName(t.zone), t.item, { name: t.name, item: t.item });
      else add('Also needed', u.name, { name: u.name });
    }
  }
  return [...places].map(([place, uses]) => ({ place, uses: [...uses.values()] }));
}
