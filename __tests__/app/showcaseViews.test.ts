import { describe, it, expect } from 'vitest';
import showcase from '@/app/(marketing)/showcase/showcase.json';
import { catalog, gatherList, spotBox, stepsUsing } from '@/app/(marketing)/showcase/_components/catalog';
import type { LivePart, Showcase } from '@/app/(marketing)/showcase/_components/showcaseData';
import { itemPose, overviewPose, stepPose, walkLegs } from '@/app/(marketing)/showcase/_components/views';

/**
 * The showcase's camera and its "what you'll need" list, against the real page data: a step's
 * camera has to land where the step is done, or "click a step, see where" points at the wrong thing.
 */
const data = showcase as Showcase;
const cat = catalog(data.shop);
const part = data.parts.find((p) => p.status === 'live') as LivePart;
const step = (id: string) => part.steps.find((s) => s.id === id)!;
const vf2 = () => {
  const spot = cat.spots.get('vf2-1')![0];
  return spotBox(cat.shop.assets[spot.asset], spot);
};

describe('the camera at a step', () => {
  it("stands in front of the VF-2's door and looks down at its table", () => {
    const pose = stepPose(cat, step('op10-load'), 40);
    const { center, size, front } = vf2();
    const ahead = (p: number[]) => (p[0] - center[0]) * front[0] + (p[2] - center[2]) * front[2];
    const halfDepth = (Math.abs(front[0]) * size[0] + Math.abs(front[2]) * size[2]) / 2;
    expect(ahead(pose.position)).toBeGreaterThan(halfDepth); // in front of the machine, not in or behind it
    expect(pose.position[1]).toBeGreaterThan(pose.target[1]); // looking down
    // At the table: inside the machine's footprint, on its centre line.
    expect(ahead(pose.target)).toBeGreaterThanOrEqual(0);
    expect(ahead(pose.target)).toBeLessThan(halfDepth);
    expect(Math.abs((pose.target[0] - center[0]) * front[2] - (pose.target[2] - center[2]) * front[0])).toBeLessThan(0.01);
  });

  it("goes to the control, on the operator's right, to load the tools and start the cycle", () => {
    const table = stepPose(cat, step('op10-load'), 40);
    const pendant = stepPose(cat, step('op10-tools'), 40);
    expect(stepPose(cat, step('op10-start'), 40)).toEqual(pendant);
    expect(pendant.target).not.toEqual(table.target);
  });

  it('goes to the zone for a bench or inspection step', () => {
    const benches = data.shop.zones.find((z) => z.id === 'benches')!.rect;
    const { target } = stepPose(cat, step('deburr'), 40);
    // Scene (x, -y) back to plan mm.
    const [x, y] = [target[0] * 1000, -target[2] * 1000];
    expect(x).toBeGreaterThanOrEqual(benches[0]);
    expect(x).toBeLessThanOrEqual(benches[2]);
    expect(y).toBeGreaterThanOrEqual(benches[1]);
    expect(y).toBeLessThanOrEqual(benches[3]);
  });

  it('can fly to every thing in the shop', () => {
    for (const t of cat.things) expect(itemPose(cat, t.item, 40), t.item).not.toBeNull();
  });
});

describe('the walk', () => {
  it("starts at eye height, stops once at each of the part's stations, and ends where it was asked to", () => {
    const route = [...new Map(part.steps.map((s) => [s.where.name, s.where])).values()];
    const end = overviewPose(cat);
    const legs = walkLegs(cat, route, end);
    expect(legs[0].position[1]).toBeCloseTo(1.6);
    expect(new Set(legs.flatMap((l) => (l.stop ? [l.stop] : [])))).toEqual(new Set(route.map((r) => r.name)));
    expect(legs.at(-1)).toMatchObject(end);
  });
});

describe("what you'll need", () => {
  const gather = gatherList(part, cat, (id) => cat.shop.surfaces[id] ?? id);
  const at = (place: string) => gather.find((g) => g.place === place)?.uses.map((u) => u.item ?? u.name) ?? [];

  it('names the bench the vise and gauges are kept on, and the cabinet the cutters are in', () => {
    expect(at('Workbench: milling workholding')).toEqual(expect.arrayContaining(['vise-6in-1', 'parallels-1', 'edge-finder-1', 'tool-setter-1']));
    expect(at('Tool crib cabinet: cutting tools')).toContain('fm-2000');
  });

  it("lists a cutter the 3D shop doesn't show by name", () => {
    expect(at('Also needed')).toContain('2.5 mm drill');
  });

  it('numbers the steps that use a thing', () => {
    expect(stepsUsing(part, 'edge-finder-1')).toEqual(part.steps.flatMap((s, i) => (s.id.endsWith('-xy') ? [i + 1] : [])));
  });
});
