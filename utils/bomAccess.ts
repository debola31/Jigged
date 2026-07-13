import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type {
  BomLine,
  BomLineFormData,
  BomLineWithChildPart,
  BomLineWithParentPart,
} from '@/types/bom';

const BOM_COLUMNS =
  'id, parent_part_id, child_part_id, quantity, unit, sequence, consume_whole_units, created_at, updated_at';

const CHILD_PART_COLUMNS =
  'id, part_name, description, primary_unit, is_stocked, source, costing_batch_quantity';

const PARENT_PART_COLUMNS = 'id, part_name, description';

/**
 * Get the BOM (children) for a part. Each row carries the joined child part
 * fields the BOM panel renders (name, primary_unit, etc.). Cost is no
 * longer stored on `parts` — callers resolve it live via
 * `getComputedPartCost` / `getPartCostExplain`.
 */
export async function getBomForPart(partId: string): Promise<BomLineWithChildPart[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts_bom')
    .select(`${BOM_COLUMNS}, child_part:parts!parts_bom_child_part_id_fkey(${CHILD_PART_COLUMNS})`)
    .eq('parent_part_id', partId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching BOM for part:', error);
    throw error;
  }

  type ChildPartRow = {
    id: string;
    part_name: string;
    description: string | null;
    primary_unit: string | null;
    is_stocked: boolean;
    source: 'made' | 'bought';
    costing_batch_quantity: number | string | null;
  };
  type Row = BomLine & {
    child_part: ChildPartRow | ChildPartRow[] | null;
  };

  return ((data || []) as Row[])
    .map((row) => {
      const child = Array.isArray(row.child_part) ? row.child_part[0] : row.child_part;
      if (!child) return null;
      return {
        id: row.id,
        parent_part_id: row.parent_part_id,
        child_part_id: row.child_part_id,
        quantity: Number(row.quantity),
        unit: row.unit,
        sequence: row.sequence,
        consume_whole_units: Boolean(row.consume_whole_units),
        created_at: row.created_at,
        updated_at: row.updated_at,
        child_part: {
          ...child,
          costing_batch_quantity:
            child.costing_batch_quantity === null || child.costing_batch_quantity === undefined
              ? null
              : Number(child.costing_batch_quantity),
        },
      } as BomLineWithChildPart;
    })
    .filter((row): row is BomLineWithChildPart => row !== null);
}

/**
 * Bulk lookup: distinct parent_part_id values across all parts_bom rows
 * whose parent part lives in the given company. Used by the Parts list
 * page's "Has BOM" column so the grid can show a checkmark per row from a
 * single small query (vs. one count query per row, which would be O(N)
 * network roundtrips).
 *
 * Filters to parts owned by the requested company by inner-joining the
 * parent `parts` row, so a user with access to multiple companies still sees
 * only the BOM-parent ids that belong to the company they're viewing.
 */
export async function getPartIdsWithBomLines(companyId: string): Promise<Set<string>> {
  const supabase = getSupabase();

  // Inner-embed the parent part to scope by company_id. parts_bom has no
  // company_id column of its own, so we have to pivot through parts.
  const { data, error } = await supabase
    .from('parts_bom')
    .select('parent_part_id, parent_part:parts!parts_bom_parent_part_id_fkey!inner(company_id)')
    .eq('parent_part.company_id', companyId);

  if (error) {
    console.error('Error fetching part ids with BOM lines:', error);
    throw error;
  }

  const ids = new Set<string>();
  for (const row of (data || []) as Array<{ parent_part_id: string }>) {
    ids.add(row.parent_part_id);
  }
  return ids;
}

/**
 * "Where used" view: parents that reference this part as a child in their
 * BOMs. Used by the part detail page's Where Used panel.
 */
export async function getBomParents(childPartId: string): Promise<BomLineWithParentPart[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts_bom')
    .select(`${BOM_COLUMNS}, parent_part:parts!parts_bom_parent_part_id_fkey(${PARENT_PART_COLUMNS})`)
    .eq('child_part_id', childPartId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching BOM parents:', error);
    throw error;
  }

  type Row = BomLine & {
    parent_part:
      | { id: string; part_name: string; description: string | null }
      | Array<{ id: string; part_name: string; description: string | null }>
      | null;
  };

  return ((data || []) as Row[])
    .map((row) => {
      const parent = Array.isArray(row.parent_part) ? row.parent_part[0] : row.parent_part;
      if (!parent) return null;
      return {
        id: row.id,
        parent_part_id: row.parent_part_id,
        child_part_id: row.child_part_id,
        quantity: Number(row.quantity),
        unit: row.unit,
        sequence: row.sequence,
        consume_whole_units: Boolean(row.consume_whole_units),
        created_at: row.created_at,
        updated_at: row.updated_at,
        parent_part: parent,
      } as BomLineWithParentPart;
    })
    .filter((row): row is BomLineWithParentPart => row !== null);
}

async function getNextBomSequence(parentPartId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('parts_bom')
    .select('sequence')
    .eq('parent_part_id', parentPartId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Error fetching max BOM sequence:', error);
    throw error;
  }

  return (data?.sequence ?? 0) + 10;
}

/**
 * Cycle pre-check.
 *
 * The DB enforces this with a BEFORE INSERT/UPDATE trigger on parts_bom
 * (`enforce_no_bom_cycles`). We pre-check in the access layer so the UI can
 * surface a friendlier error ("Adding X as a child of Y would create a
 * cycle: Y → A → X → Y") before the trigger fires. Pure defense-in-depth —
 * the trigger is the source of truth and can't be bypassed.
 *
 * Implementation: a single recursive walk of `parts_bom` starting at
 * `childId`. If `parentId` appears anywhere in the descendants, the proposed
 * edge would close a cycle. The walk is bounded at depth 50 to match the
 * trigger.
 */
export async function checkBomCycle(
  parentId: string,
  childId: string,
): Promise<{ would_create_cycle: boolean; cycle_path?: string[] }> {
  if (parentId === childId) {
    return { would_create_cycle: true, cycle_path: [parentId, childId] };
  }

  const supabase = getSupabase();

  let frontier = [childId];
  const visited = new Set<string>([childId]);
  const cameFrom = new Map<string, string>();
  let depth = 0;

  while (frontier.length > 0 && depth < 50) {
    const { data, error } = await supabase
      .from('parts_bom')
      .select('parent_part_id, child_part_id')
      .in('parent_part_id', frontier);

    if (error) throw error;

    const next: string[] = [];
    for (const edge of (data || []) as Array<{ parent_part_id: string; child_part_id: string }>) {
      if (edge.child_part_id === parentId) {
        // Reconstruct the path: parentId → ... → childId → parentId
        const path: string[] = [edge.child_part_id, edge.parent_part_id];
        let cursor = edge.parent_part_id;
        while (cameFrom.has(cursor)) {
          cursor = cameFrom.get(cursor)!;
          path.push(cursor);
        }
        path.push(parentId);
        return { would_create_cycle: true, cycle_path: path };
      }
      if (!visited.has(edge.child_part_id)) {
        visited.add(edge.child_part_id);
        cameFrom.set(edge.child_part_id, edge.parent_part_id);
        next.push(edge.child_part_id);
      }
    }

    frontier = next;
    depth += 1;
  }

  return { would_create_cycle: false };
}

/**
 * Add a BOM line. Runs the app-layer cycle pre-check first; the DB trigger
 * is the ultimate guard.
 */
export async function addBomLine(
  parentPartId: string,
  formData: BomLineFormData,
): Promise<BomLine> {
  if (!formData.child_part_id) throw new Error('Child part is required');

  const cycleCheck = await checkBomCycle(parentPartId, formData.child_part_id);
  if (cycleCheck.would_create_cycle) {
    throw new Error(
      `Cannot add this BOM line — it would create a cycle (${cycleCheck.cycle_path?.join(' → ')}).`,
    );
  }

  const supabase = getSupabase();
  const sequence = await getNextBomSequence(parentPartId);

  const quantity = parseFloat(formData.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be greater than zero');
  }

  if (!formData.unit?.trim()) {
    throw new Error('Unit is required');
  }

  const { data, error } = await supabase
    .from('parts_bom')
    .insert({
      parent_part_id: parentPartId,
      child_part_id: formData.child_part_id,
      quantity,
      unit: formData.unit.trim(),
      sequence,
      consume_whole_units: formData.consume_whole_units,
    })
    .select(BOM_COLUMNS)
    .single();

  if (error) {
    console.error('Error adding BOM line:', error);
    if (error.code === '23505') {
      throw new Error('This child part is already in the BOM. Adjust the existing line instead.');
    }
    throw error;
  }
  return data as BomLine;
}

/**
 * Update a BOM line. If the child changes, re-runs the cycle pre-check.
 */
export async function updateBomLine(
  bomLineId: string,
  formData: BomLineFormData,
): Promise<BomLine> {
  const supabase = getSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('parts_bom')
    .select('parent_part_id, child_part_id')
    .eq('id', bomLineId)
    .single();

  if (existingError || !existing) {
    throw existingError || new Error('BOM line not found');
  }

  if (formData.child_part_id !== existing.child_part_id) {
    const cycleCheck = await checkBomCycle(existing.parent_part_id, formData.child_part_id);
    if (cycleCheck.would_create_cycle) {
      throw new Error(
        `Cannot change the child to this part — it would create a cycle (${cycleCheck.cycle_path?.join(' → ')}).`,
      );
    }
  }

  const quantity = parseFloat(formData.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be greater than zero');
  }
  if (!formData.unit?.trim()) {
    throw new Error('Unit is required');
  }

  const { data, error } = await supabase
    .from('parts_bom')
    .update({
      child_part_id: formData.child_part_id,
      quantity,
      unit: formData.unit.trim(),
      consume_whole_units: formData.consume_whole_units,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bomLineId)
    .select(BOM_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating BOM line:', error);
    if (error.code === '23505') {
      throw new Error('This child part is already in the BOM. Adjust the existing line instead.');
    }
    throw error;
  }
  return data as BomLine;
}

export async function deleteBomLine(bomLineId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('parts_bom').delete().eq('id', bomLineId);
  if (error) {
    console.error('Error deleting BOM line:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'BOM line',
        fallback: 'Failed to delete BOM line.',
      }),
    );
  }
}
