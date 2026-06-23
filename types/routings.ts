/**
 * Routings Module Types
 *
 * Types for the linear routing system. A routing is an ordered list of
 * routing_operations. Operations are ordered by `sequence` (steps of 10
 * leave room for inserts). BOM lives separately on the part itself
 * (`parts_bom`), not on the routing.
 */

import type { WorkCenterKind } from './workCenter';

// ============================================
// Core Database Entities
// ============================================

/**
 * A routing is an ordered list of operations that defines how a part is
 * manufactured. There is exactly one routing per part.
 */
export interface Routing {
  id: string;
  company_id: string;
  part_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  // created_at / updated_at have DEFAULT now() but no NOT NULL constraint —
  // mirror the DB shape so typed-mode reads stay clean. Same convention as
  // Customer.created_at (PR #286), Company.is_demo (PR #290).
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A single operation in the routing, ordered by `sequence`.
 *
 * The cost-relevant fields split by the work_center's kind:
 * - kind='internal' uses `setup_minutes` + `cycle_minutes_per_unit` priced at
 *   `COALESCE(labor_rate_override, work_center.labor_rate)`.
 * - kind='external' uses `external_unit_price` only (external work bills once
 *   per part, so there is no setup cost) and ignores the time/rate fields.
 */
export interface RoutingOperation {
  id: string;
  routing_id: string;
  work_center_id: string;
  sequence: number;
  setup_minutes: number | null;
  cycle_minutes_per_unit: number | null;
  labor_rate_override: number | null;
  external_unit_price: number | null;
  instructions: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================
// Entities with Relations
// ============================================

/**
 * Routing with related part information for display in lists.
 */
export interface RoutingWithPart extends Routing {
  part: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
}

/**
 * Routing with operation count and total time estimates for display.
 */
export interface RoutingWithStats extends RoutingWithPart {
  operations_count: number;
  total_run_time_per_unit: number | null;
}

/**
 * Routing operation joined with its work center for display.
 */
export interface RoutingOperationWithWorkCenter extends RoutingOperation {
  work_center: {
    id: string;
    name: string;
    kind: WorkCenterKind;
    labor_rate: number | null;
    vendor: { id: string; name: string } | null;
  } | null;
}

/**
 * Full routing data: ordered operations only. BOM lives on the part itself
 * (`parts_bom`) and is loaded separately by the part detail page.
 */
export interface RoutingWithGraph extends Routing {
  part: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
  operations: RoutingOperationWithWorkCenter[];
}

// ============================================
// Form Data Types
// ============================================

/**
 * Form data for creating/editing a routing operation.
 */
export interface RoutingOperationFormData {
  work_center_id: string;
  setup_minutes: string;
  cycle_minutes_per_unit: string;
  labor_rate_override: string;
  external_unit_price: string;
  instructions: string;
}

export const EMPTY_OPERATION_FORM: RoutingOperationFormData = {
  work_center_id: '',
  setup_minutes: '',
  cycle_minutes_per_unit: '',
  labor_rate_override: '',
  external_unit_price: '',
  instructions: '',
};

// ============================================
// Utility Functions
// ============================================

export function routingOperationToFormData(op: RoutingOperation): RoutingOperationFormData {
  return {
    work_center_id: op.work_center_id,
    setup_minutes: op.setup_minutes !== null ? String(op.setup_minutes) : '',
    cycle_minutes_per_unit:
      op.cycle_minutes_per_unit !== null ? String(op.cycle_minutes_per_unit) : '',
    labor_rate_override: op.labor_rate_override !== null ? String(op.labor_rate_override) : '',
    external_unit_price: op.external_unit_price !== null ? String(op.external_unit_price) : '',
    instructions: op.instructions || '',
  };
}

/**
 * Sum setup + per-unit cycle time across all internal operations in a
 * routing. External ops contribute zero minutes (they price by unit, not time)
 * — caller should fold in their flat costs separately if a duration estimate
 * is needed.
 */
export function calculateRoutingTime(
  operations: RoutingOperationWithWorkCenter[],
  quantity: number = 1,
): { runTime: number; setupTime: number; totalTime: number } {
  let runTime = 0;
  let setupTime = 0;

  for (const op of operations) {
    if (op.work_center?.kind === 'external') continue;
    runTime += (op.cycle_minutes_per_unit || 0) * quantity;
    setupTime += op.setup_minutes || 0;
  }

  return {
    runTime,
    setupTime,
    totalTime: setupTime + runTime,
  };
}

/**
 * Format time in minutes to a human-readable string.
 */
export function formatTime(minutes: number | null): string {
  if (minutes === null || minutes === 0) return '—';

  if (minutes < 1) {
    const seconds = Math.round(minutes * 60);
    return `${seconds} sec`;
  }

  if (minutes < 60) {
    const display = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10;
    return `${display} min`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);

  if (mins === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${mins} min`;
}
