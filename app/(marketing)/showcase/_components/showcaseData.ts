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
  x: number;
  y: number;
}

export interface Step {
  id: string;
  title: string;
  /** The plan's caption, built only from the plan's facts (plan §2, O8; gate test_web_steps.py). */
  caption: string;
  kind: 'human' | 'cycle';
  group: string;
  where: Where;
  /**
   * What the step is shown with, by path under the media root: a person's step is a video, a
   * machine cycle one still of the part after the cut (only people's work is rendered).
   */
  media: { type: 'video' | 'still'; path: string };
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
  groups: { id: string; title: string }[];
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
}

export interface Furniture {
  id: string;
  kind: string;
  x: number;
  y: number;
  rot: number;
  /** [width along local X, depth along local Y, top height], mm. */
  size: number[];
}

export interface Shop {
  name: string;
  fictional: boolean;
  /** size is [east-west, north-south], mm. */
  building: { size: number[]; wall_height: number };
  zones: { id: string; name: string; rect: Rect }[];
  aisles: { name: string; rect: Rect }[];
  furniture: Furniture[];
  items: ShopItem[];
  /** Each asset's light GLB (path under the media root) and its box in the asset frame, mm. */
  assets: Record<string, { name: string; model: string; bbox: { min: number[]; max: number[] } }>;
}

export interface Showcase {
  schema: 'jigged.showcase/1';
  parts: Part[];
  shop: Shop;
}

// Videos, stills and models are served from Supabase Storage, never from the Next build (plan §1).
// NEXT_PUBLIC_SHOWCASE_MEDIA_URL points development at `python -m moonshot.web.media serve`.
const MEDIA_ROOT =
  process.env.NEXT_PUBLIC_SHOWCASE_MEDIA_URL ??
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/showcase`;

export function mediaUrl(path: string): string {
  return `${MEDIA_ROOT.replace(/\/$/, '')}/${path}`;
}

// Development only: with NEXT_PUBLIC_SHOWCASE_PREVIEW_UNPUBLISHED=1 every step shows, so the player can
// be worked on against the media server's drafts before the finals are published.
const PREVIEW_UNPUBLISHED = process.env.NEXT_PUBLIC_SHOWCASE_PREVIEW_UNPUBLISHED === '1';

export function ready(step: Step): boolean {
  return step.published || PREVIEW_UNPUBLISHED;
}
