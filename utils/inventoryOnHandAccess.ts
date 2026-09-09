import { getSupabase } from '@/lib/supabase';

/**
 * What is on the shelves, and what it cost us — the Storage page's Inventory tab.
 *
 * Reads the `inventory_on_hand_cost` view (20260909152729), one row per balance:
 * (part, place, lot). The view owns the cost rule; this module owns getting all of it into the
 * browser without lying about how much it got.
 *
 * **THE TOTALS ARE NOT COMPUTED HERE, AND THAT IS DELIBERATE.** The table filters — by place, and
 * by "show me the ones with no cost" — and the footer has to describe the rows above it rather
 * than the shop. A server-side aggregate cannot follow a client-side filter without a round trip
 * per keystroke, so the footer sums whatever is showing. That is only safe because this reader
 * returns the COMPLETE set or admits it did not: see `truncated`.
 */

/** One balance, with the cost of the part it holds. */
export interface OnHandRow {
  balanceId: string;
  partId: string;
  partName: string;
  primaryUnit: string | null;
  source: string | null;
  locationId: string;
  locationName: string;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
  quantity: number;
  /**
   * What the part costs us per unit, at the tier its TOTAL on-hand quantity lands on.
   *
   * **NULL is a GAP, never a zero.** `gap` says which kind.
   */
  costPerUnit: number | null;
  /** Costed at the LOWEST break because the shop holds fewer than the smallest one. Not a gap. */
  costBelowMin: boolean;
  /** `quantity × costPerUnit`, rounded to the cent IN SQL so the rows sum to what is printed. */
  onHandCost: number | null;
  /**
   * Why there is no cost, or null when there is one.
   *
   * `made` is not a data-quality complaint: a made part's cost lives in the routing + BOM rollup
   * by design, so it has no purchase tier to be missing. Collapsing the two would accuse a shop of
   * not filling in a field that does not exist for that part.
   */
  gap: 'no_cost_tier' | 'made' | null;
}

export interface StorageOnHand {
  rows: OnHandRow[];
  /**
   * The read hit its ceiling, so `rows` is a PREFIX of what the shop holds.
   *
   * When this is true the surface must refuse to print a total rather than print a short one: a
   * total that is quietly missing a shelf is a number an owner would act on.
   */
  truncated: boolean;
}

/**
 * PostgREST's page size. `supabase/config.toml` sets `max_rows = 1000`, so a single unpaged read
 * would stop there SILENTLY — no error, just a short answer. That hazard is why this pages at all;
 * it is the same one 20260729205302 documents for the occupancy view.
 */
const PAGE = 1000;

/**
 * Hard stop on the row list.
 *
 * Not because the loop would fail past it — it would keep going — but because an unbounded loop on
 * a page load is a request budget nobody set. A shop at this size has outgrown a client-side
 * table, and the honest response is to say so rather than to keep fetching.
 */
export const ON_HAND_ROW_CEILING = 5000;

interface OnHandViewRow {
  balance_id: string | null;
  part_id: string | null;
  part_name: string | null;
  primary_unit: string | null;
  source: string | null;
  location_id: string | null;
  location_name: string | null;
  lot_id: string | null;
  lot_code: string | null;
  heat_number: string | null;
  quantity: number | null;
  cost_per_unit: number | null;
  cost_below_min: boolean | null;
  on_hand_cost: number | null;
  gap_reason: string | null;
}

/** `Number(x)` for a real value, `null` for a gap. NEVER `|| 0` — that turns a gap into a zero. */
function num(value: number | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Every balance in the shop, with its cost.
 *
 * Ordered by part then place then balance id: a total order, without which a range boundary
 * landing inside a tie can repeat or skip a row — the same reason `getBalancesForParts` orders on
 * three keys.
 */
export async function getStorageOnHand(companyId: string): Promise<StorageOnHand> {
  const supabase = getSupabase();
  const rows: OnHandRow[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('inventory_on_hand_cost')
      .select('*')
      .eq('company_id', companyId)
      .order('part_name')
      .order('location_name')
      .order('balance_id')
      .range(offset, offset + PAGE - 1);

    if (error) {
      // `.from()` reads report themselves through the Sentry Supabase integration with the query
      // attached, so this does not capture by hand — see DashboardMetrics' note on #708.
      console.error('Error loading storage on-hand:', error);
      throw error;
    }

    const page = (data ?? []) as OnHandViewRow[];
    for (const row of page) {
      // View columns generate as nullable. A row missing its own identity cannot be rendered or
      // counted, so skip it rather than paint an unnamed line — same guard as getLocationOccupancy.
      if (!row.balance_id || !row.part_id || !row.location_id) continue;
      rows.push({
        balanceId: row.balance_id,
        partId: row.part_id,
        partName: row.part_name ?? '',
        primaryUnit: row.primary_unit,
        source: row.source,
        locationId: row.location_id,
        locationName: row.location_name ?? '',
        lotId: row.lot_id,
        lotCode: row.lot_code,
        heatNumber: row.heat_number,
        quantity: Number(row.quantity ?? 0),
        costPerUnit: num(row.cost_per_unit),
        costBelowMin: row.cost_below_min === true,
        onHandCost: num(row.on_hand_cost),
        gap:
          row.gap_reason === 'made' || row.gap_reason === 'no_cost_tier' ? row.gap_reason : null,
      });
    }

    if (page.length < PAGE) return { rows, truncated: false };
    if (rows.length >= ON_HAND_ROW_CEILING) return { rows, truncated: true };
  }
}
