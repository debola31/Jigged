// The shape of ../showcase.json, written by `python -m moonshot.web.export` from the process plans
// and moonshot/library/records. The file is generated: change the plan or the records, never it.
// Plan coordinates are mm, +X east, +Y north, +Z up; rot is degrees about +Z. Fixed-length
// arrays are typed as number[] because that is what a JSON import gives.

/** [x0, y0, x1, y1], mm. */
export type Rect = number[];

export interface Where {
  name: string;
  /** The shop item the step happens at, highlighted in the shop view. Zone-level steps have none. */
  item?: string;
  /** Where at the machine: inside the door at its table, or at its pendant (loading tools, starting). */
  at?: 'table' | 'pendant';
  x: number;
  y: number;
}

/** Something a step uses besides its station; `item` is the shop item holding it, when the shop has one. */
export interface Use {
  name: string;
  item?: string;
}

export interface Step {
  id: string;
  title: string;
  /** The plan's caption, built only from the plan's facts (plan §2, O8; gate test_web_steps.py). */
  caption: string;
  kind: 'human' | 'cycle';
  group: string;
  where: Where;
  uses: Use[];
  /**
   * What the step is shown with, by path under the media root: a person's step is a video; a
   * machine cycle is the part after the cut, as a still and as the model a desktop can turn (only
   * people's work is rendered).
   */
  media: { type: 'video'; path: string } | { type: 'cut'; still: string; model: string };
  /** The media is in the bucket (moonshot/web/published.json). Until then the step shows as coming. */
  published: boolean;
}

interface PartBase {
  id: string;
  name: string;
  size: string;
}

export interface LivePart extends PartBase {
  status: 'live';
  material: string;
  stock: { material: string; size: string; from: string };
  /** The setups, then finishing; a setup names the machine it's on. */
  groups: { id: string; title: string; where?: string }[];
  steps: Step[];
}

export interface ComingPart extends PartBase {
  status: 'coming';
}

export type Part = LivePart | ComingPart;

export interface ShopItem {
  item: string;
  asset: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  name: string;
  /** shop.json's list it is in: machines, workholding, tools, … */
  category: string;
  kind: string;
  zone: string;
  /** The bench, cabinet or table it sits on. */
  on?: string;
  make?: string;
  model?: string;
  /** shop.json's facts about it, as label and value rows. */
  facts: string[][];
}

export interface Furniture {
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  rot: number;
  /** [width along local X, depth along local Y, top height], mm. */
  size: number[];
}

export interface Asset {
  name: string;
  /** Its light GLB, by path under the media root. */
  model: string;
  /** Its box in the asset frame, mm. */
  bbox: { min: number[]; max: number[] };
  description: string;
  key_specs: { name: string; value: unknown; unit?: string }[];
}

export interface Shop {
  name: string;
  fictional: boolean;
  categories: string[];
  /** size is [east-west, north-south], mm. */
  building: { size: number[]; wall_height: number; doors?: { name: string; rect: Rect }[] };
  zones: { id: string; name: string; rect: Rect }[];
  aisles: { name: string; rect: Rect }[];
  furniture: Furniture[];
  /** Every bench, cabinet and table's name by id, the benches (drawn as items) included. */
  surfaces: Record<string, string>;
  /** One per place a thing stands; a thing on several surfaces (the benches) is listed once for each. */
  items: ShopItem[];
  assets: Record<string, Asset>;
}

export interface Showcase {
  schema: 'jigged.showcase/1';
  parts: Part[];
  shop: Shop;
}

// Videos, stills and models are served from Supabase Storage, never from the Next build (plan §1).
// They are published to production's bucket only (`python -m moonshot.web.media upload`), so every
// deployment reads from there: a preview's NEXT_PUBLIC_SUPABASE_URL is its Supabase preview branch,
// whose bucket is empty. NEXT_PUBLIC_SHOWCASE_MEDIA_URL points development at
// `python -m moonshot.web.media serve`.
const MEDIA_ROOT =
  process.env.NEXT_PUBLIC_SHOWCASE_MEDIA_URL ??
  'https://mayuquvexmqjvwkfasxg.supabase.co/storage/v1/object/public/showcase';

export function mediaUrl(path: string): string {
  return `${MEDIA_ROOT.replace(/\/$/, '')}/${path}`;
}

// Development only: with NEXT_PUBLIC_SHOWCASE_PREVIEW_UNPUBLISHED=1 every step shows, so the player can
// be worked on against the media server's drafts before the finals are published.
const PREVIEW_UNPUBLISHED = process.env.NEXT_PUBLIC_SHOWCASE_PREVIEW_UNPUBLISHED === '1';

export function ready(step: Step): boolean {
  return step.published || PREVIEW_UNPUBLISHED;
}

/** The part as its last cut leaves it: the newest published still of a machine cycle. */
export function finishedStill(part: LivePart): string | null {
  const cut = [...part.steps].reverse().find((s) => s.media.type === 'cut' && ready(s));
  return cut && cut.media.type === 'cut' ? mediaUrl(cut.media.still) : null;
}
