import { z } from 'zod';

import { ENTITY_ENDPOINT } from '@/lib/dataImportIngest';
import { ENTITY_FIELDS, ENTITY_LABELS } from '@/lib/dataImportSchema';
import { callBackend } from '@/lib/mcp/backend';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolResult, type ToolTarget } from '@/lib/mcp/defineTool';
import { companyLink, urlOutput } from '@/lib/mcp/tools/shared';
import { ALL_UNITS, resolveUnitAlias } from '@/lib/unitPresets';

/**
 * Bulk import from an assistant. The person's own AI reads their spreadsheet and does the column
 * mapping, which is the one step Jigged's Import page uses AI for; everything after it is the
 * page's own non-AI path. Rows go to the same `/api/<entity>/import/execute` routes the page's
 * ingest driver calls (lib/dataImportIngest.ts), with the same body: `skip_conflicts: true`, and
 * `pricing_columns: []` for parts. Those routes validate, detect conflicts and upsert by natural
 * identity, so an assistant's import lands exactly as the page's would.
 *
 *   preview_import   the route's `dry_run`: every check, the real run's counts, no write
 *   import_records   the real run
 *
 * Neither calls Jigged's AI. The AI data import (api/routes/data_import_routes.py) is never
 * touched, and parts arrive with their units already resolved (`uom_resolutions`), so the parts
 * route's AI unit inference never runs: a unit the alias table cannot read comes back as a
 * skipped row for the assistant to fix.
 *
 * Who may: any office user. The Import page has no admin guard (Sidebar "Import data" is not
 * `adminOnly`), and the routes require an office member of the company; a real run also requires
 * an entitled company (the billing gate), a preview does not.
 */

export const IMPORT_ENTITIES = [
  'customers',
  'vendors',
  'vendor_services',
  'work_centers',
  'parts',
  'bom',
  'routings',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Every execute route batches at 500, and FastAPI stops at 60 seconds. */
export const MAX_IMPORT_ROWS = 500;

/**
 * What the assistant needs beyond each field's label (lib/dataImportSchema.ts, which CI keeps in
 * step with the Python import schemas): accepted values, and what a row has to point at.
 */
const FIELD_NOTES: Record<ImportEntity, Record<string, string>> = {
  customers: {
    contact_name: 'saved as the primary contact of a new customer',
    country: 'USA when an address has none',
  },
  vendors: {
    primary_contact_name: 'saved as the primary contact of a new vendor; needed with an email or phone',
    primary_contact_role:
      'sales (the default), accounts_payable, quality, engineering, shipping_receiving or customer_service',
    country: 'USA when an address has none',
  },
  vendor_services: {
    vendor_name: 'an existing vendor',
    service_name: 'the process, not the vendor; matched within its vendor',
    unit_price: 'a number, 0 or more',
  },
  work_centers: {
    name: 'an in-house machine or station; an outside process is a vendor service',
    labor_rate: 'dollars per hour, 0 or more',
  },
  parts: {
    primary_unit: `${ALL_UNITS.join(', ')}; or ea, pcs, lb, kg, oz, in, ft, mm, cm, gal, L, sq ft`,
    source: 'made or bought; inferred from the other fields when absent',
    preferred_vendor_name: 'an existing vendor',
    cost_per_unit: 'kept for a bought part',
    quantity: '0 or more; recorded only with a location_name',
    location_name: 'an existing storage location, the shelf or bin itself',
    reorder_point: '0 or more',
  },
  bom: {
    parent_part_name: 'an existing part',
    child_part_name: 'an existing part',
    quantity: 'per assembly, above 0',
  },
  routings: {
    part_name: 'an existing part; its rows are its steps',
    work_center_name: 'an existing work center or vendor service; blank uses a work center named MISCELLANEOUS',
    vendor_name: 'names the vendor when two offer a service of the same name',
    sequence: "when no row has one, each part's steps are numbered in row order within the call",
    setup_minutes: 'in-house steps',
    cycle_minutes_per_unit: 'in-house steps',
    labor_rate_override: 'in-house steps',
    external_unit_price: "outside steps; absent, the service's own price applies",
  },
};

interface FieldSpec {
  key: string;
  required: boolean;
  text: string;
}

function fieldsOf(entity: ImportEntity): FieldSpec[] {
  return (ENTITY_FIELDS[entity] ?? []).map((f) => {
    const note = FIELD_NOTES[entity][f.key];
    return { key: f.key, required: f.required, text: note ? `${f.label}: ${note}` : f.label };
  });
}

const ROWS_DESCRIPTION =
  `The records, one object per row, keyed by the field names for \`entity\`; values are text or ` +
  `numbers, and a field may be left out. 1 to ${MAX_IMPORT_ROWS} rows. Required fields are marked *.\n` +
  IMPORT_ENTITIES.map(
    (entity) =>
      `${entity}: ` + fieldsOf(entity).map((f) => `${f.key}${f.required ? '*' : ''} (${f.text})`).join('; '),
  ).join('\n');

const importInput = {
  entity: z
    .enum(IMPORT_ENTITIES)
    .describe(
      'What the rows are. Records a row refers to have to exist first, so the order is: vendors, ' +
        'work_centers and customers; then vendor_services; then parts; then bom and routings.',
    ),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
    .min(1)
    .max(MAX_IMPORT_ROWS)
    .describe(ROWS_DESCRIPTION),
};

/* ── What the routes answer (api/models/*_import_models.py *ExecuteResponse) ───────────────── */

const skippedRowIn = z.object({
  row_number: z.number().int(),
  type: z.string(),
  field: z.string().nullable().optional(),
  reason: z.string(),
});

const rowErrorIn = z.object({ row_number: z.number().int(), reason: z.string() });

const baseResponse = z.object({
  success: z.literal(true),
  dry_run: z.boolean(),
  updated_count: z.number().int(),
  skipped_count: z.number().int(),
  errors: z.array(rowErrorIn),
  skipped_rows: z.array(skippedRowIn),
});
const countedResponse = baseResponse.extend({ imported_count: z.number().int() });
const vendorsResponse = countedResponse.extend({ contacts_imported_count: z.number().int() });
const partsResponse = countedResponse.extend({ quantity_skipped_already_placed: z.array(z.string()) });
const routingsResponse = baseResponse.extend({
  imported_routings_count: z.number().int(),
  imported_operations_count: z.number().int(),
});

/* ── What the tools return ─────────────────────────────────────────────────────────────────── */

const importOutput = {
  entity: z.enum(IMPORT_ENTITIES),
  saved: z.boolean().describe('True when the rows were written; false for a preview, which writes nothing.'),
  rows_received: z.number(),
  created: z
    .number()
    .describe('Rows that create a new record (for routings, new routing steps). In a preview, rows that would.'),
  updated: z.number().describe('Rows that update the record they match. In a preview, rows that would.'),
  skipped: z.number().describe('Rows left out.'),
  skipped_rows: z
    .array(
      z.object({
        row: z.number().describe('Position in `rows`, counting from 1.'),
        problem: z.string().describe('What kind of problem: missing_name, unknown_vendor, csv_duplicate, …'),
        field: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .describe('Each row left out by the checks, and why.'),
  failed_rows: z
    .array(z.object({ row: z.number().describe('Position in `rows`; 0 when not one row.'), reason: z.string() }))
    .describe('Rows that passed the checks but could not be written.'),
  routings_created: z.number().nullable().describe('Routings only: parts given their first routing.'),
  contacts_created: z.number().nullable().describe('Vendors only: primary contacts added to new vendors.'),
  quantities_not_recorded: z
    .array(z.string())
    .nullable()
    .describe(
      'Parts only: part names whose quantity is not recorded, because the row names no single existing ' +
        'location or the part already holds stock at another one. The rest of each row imports.',
    ),
  url: urlOutput,
};
type ImportOutput = z.infer<z.ZodObject<typeof importOutput>>;

/** Where the imported records live in the app. */
const ENTITY_PAGE: Record<ImportEntity, string> = {
  customers: '/customers',
  vendors: '/vendors',
  vendor_services: '/vendors',
  work_centers: '/work-centers',
  parts: '/parts',
  bom: '/parts',
  routings: '/parts',
};

/* ── Preparing the rows ────────────────────────────────────────────────────────────────────── */

type TextRow = Record<string, string>;
type ImportArgs = z.infer<z.ZodObject<typeof importInput>>;

/**
 * A unit as the parts route's alias table reads it (`normalize_uom_alias`,
 * api/services/uom_normalizer.py): a canonical unit or a known abbreviation, any case. Null when it
 * reads as neither; the route then reports the row as `unknown_unit` instead of asking the AI.
 */
export function canonicalUnit(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  // The app's alias table (lib/unitPresets.ts) is lowercase but for `L` and `mL`, where the Python
  // one is all lowercase; the third spelling lets `l` and `ml` read the same on both sides.
  for (const candidate of [lower, trimmed, lower.replace(/l$/, 'L')]) {
    const resolved = resolveUnitAlias(candidate);
    if (ALL_UNITS.includes(resolved)) return resolved;
  }
  return null;
}

/**
 * The parts route's `uom_resolutions`, keyed by 1-based row. Sent pre-resolved, the route trusts
 * them and never reaches its AI inference, which runs only when this map is empty.
 */
function unitResolutions(rows: TextRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  rows.forEach((row, i) => {
    const unit = canonicalUnit(row.primary_unit ?? '');
    if (unit) out[String(i + 1)] = unit;
  });
  return out;
}

/**
 * The Import page numbers a routing file's steps in file order when it has no step-number column
 * (`numberRoutingOpsInFileOrder`, lib/dataImportIngest.ts), so validation and the write agree on
 * every step's number. Same here, across one call.
 */
function numberStepsInRowOrder(rows: TextRow[]): void {
  if (rows.some((row) => (row.sequence ?? '').trim() !== '')) return;
  const next = new Map<string, number>();
  for (const row of rows) {
    const part = (row.part_name ?? '').trim().toLowerCase();
    if (!part) continue;
    const n = (next.get(part) ?? 0) + 1;
    next.set(part, n);
    row.sequence = String(n);
  }
}

function rowList(rows: number[]): string {
  return rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ', …' : ''}`;
}

/** Fields an entity does not take, by name, with the rows carrying each. */
function unknownFields(entity: ImportEntity, rows: ImportArgs['rows']): Map<string, number[]> {
  const known = new Set(fieldsOf(entity).map((f) => f.key));
  const unknown = new Map<string, number[]>();
  rows.forEach((row, i) => {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) unknown.set(key, [...(unknown.get(key) ?? []), i + 1]);
    }
  });
  return unknown;
}

/* ── The call ──────────────────────────────────────────────────────────────────────────────── */

interface Report {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  skippedRows: z.infer<typeof skippedRowIn>[];
  errors: z.infer<typeof rowErrorIn>[];
  routingsCreated: number | null;
  contactsCreated: number | null;
  quantitiesNotRecorded: string[] | null;
}

function reportOf(r: z.infer<typeof baseResponse>, created: number): Report {
  return {
    dryRun: r.dry_run,
    created,
    updated: r.updated_count,
    skipped: r.skipped_count,
    skippedRows: r.skipped_rows,
    errors: r.errors,
    routingsCreated: null,
    contactsCreated: null,
    quantitiesNotRecorded: null,
  };
}

async function execute(env: CompanyToolEnv, entity: ImportEntity, body: Record<string, unknown>): Promise<Report> {
  const path = ENTITY_ENDPOINT[entity];
  if (!path) throw new Error(`no import endpoint for ${entity}`);
  const init = { body };
  switch (entity) {
    case 'vendors': {
      const r = await callBackend(env, path, vendorsResponse, init);
      return { ...reportOf(r, r.imported_count), contactsCreated: r.contacts_imported_count };
    }
    case 'parts': {
      const r = await callBackend(env, path, partsResponse, init);
      return { ...reportOf(r, r.imported_count), quantitiesNotRecorded: r.quantity_skipped_already_placed };
    }
    case 'routings': {
      const r = await callBackend(env, path, routingsResponse, init);
      return { ...reportOf(r, r.imported_operations_count), routingsCreated: r.imported_routings_count };
    }
    default: {
      const r = await callBackend(env, path, countedResponse, init);
      return reportOf(r, r.imported_count);
    }
  }
}

async function runImport(args: ImportArgs, env: CompanyToolEnv, dryRun: boolean): Promise<ToolResult<ImportOutput>> {
  const { entity } = args;
  const label = ENTITY_LABELS[entity].toLowerCase();

  // A field the route has no column for would be dropped without a word. Say so instead.
  const unknown = unknownFields(entity, args.rows);
  if (unknown.size > 0) {
    const named = [...unknown.entries()].map(([key, rows]) => `${key} (${rowList(rows)})`).join(', ');
    return {
      ok: false,
      message:
        `Jigged doesn't import these fields for ${label}: ${named}. Nothing was ${dryRun ? 'checked' : 'imported'}. ` +
        `The ${label} fields are: ${fieldsOf(entity)
          .map((f) => f.key)
          .join(', ')}.`,
    };
  }

  const rows: TextRow[] = args.rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? '' : String(value)])),
  );
  if (entity === 'routings') numberStepsInRowOrder(rows);

  // The columns are already named for their fields; the routes still take a column -> field map.
  const present = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const body: Record<string, unknown> = {
    company_id: env.company.id,
    mappings: Object.fromEntries(present.map((key) => [key, key])),
    rows,
    skip_conflicts: true,
    dry_run: dryRun,
  };

  if (entity === 'parts') {
    const resolutions = unitResolutions(rows);
    if (Object.keys(resolutions).length === 0) {
      return {
        ok: false,
        message:
          `Every part needs a primary_unit Jigged recognises, and none of these rows has one, so nothing was ` +
          `${dryRun ? 'checked' : 'imported'}. Units: ${ALL_UNITS.join(', ')} (or ea, pcs, lb, in, ft, mm, kg).`,
      };
    }
    body.pricing_columns = [];
    body.uom_resolutions = resolutions;
  }

  const report = await execute(env, entity, body);
  // A preview that came back as a real run means it wrote; never report that as a preview.
  if (report.dryRun !== dryRun) throw new Error(`import ${entity}: asked dry_run=${dryRun}, got ${report.dryRun}`);

  return {
    ok: true,
    data: {
      entity,
      saved: !dryRun,
      rows_received: rows.length,
      created: report.created,
      updated: report.updated,
      skipped: report.skipped,
      skipped_rows: report.skippedRows.map((r) => ({
        row: r.row_number,
        problem: r.type,
        field: r.field ?? null,
        reason: r.reason,
      })),
      failed_rows: report.errors.map((e) => ({ row: e.row_number, reason: e.reason })),
      routings_created: report.routingsCreated,
      contacts_created: report.contactsCreated,
      quantities_not_recorded: report.quantitiesNotRecorded,
      url: companyLink(env, ENTITY_PAGE[entity]),
    },
  };
}

/* ── The tools ─────────────────────────────────────────────────────────────────────────────── */

export const previewImport = defineCompanyTool({
  name: 'preview_import',
  title: 'Preview an import',
  description:
    'Checks rows for a bulk import into a Jigged company without saving anything, with the same checks ' +
    "as Jigged's Import data page. `entity` says what the rows are (customers, vendors, vendor services, " +
    'work centers, parts, bills of materials or routings) and each row is one record keyed by that ' +
    `entity's field names, which are listed under \`rows\`; up to ${MAX_IMPORT_ROWS} rows per call. Returns ` +
    'how many rows would create a record, how many would update the record they match, and every row that ' +
    'would be skipped with the reason. Records a row refers to (a part\'s vendor, a routing step\'s work ' +
    'center, a BOM line\'s parts) have to exist already, so rows that name records from a file not yet ' +
    'imported come back skipped.',
  access: 'read',
  input: importInput,
  output: importOutput,
  run: (args, env) => runImport(args, env, true),
});

export const importRecords = defineCompanyTool({
  name: 'import_records',
  title: 'Import records',
  description:
    "Imports rows into a Jigged company in bulk, the same way Jigged's Import data page does. Each row " +
    'creates a record or updates the one it matches: a customer, vendor, work center or part with the same ' +
    "name, a vendor's service of the same name, a BOM line with the same parent and child, a routing step " +
    'with the same part and step number. An archived customer, vendor, vendor service or work center of ' +
    "that name is restored; an archived part's name goes to a new part. Rows that fail the checks are " +
    `skipped and listed with the reason; the rest are saved. Up to ${MAX_IMPORT_ROWS} rows per call, so a ` +
    `larger file goes in batches of ${MAX_IMPORT_ROWS} or fewer. Rows can only refer to records that exist, so ` +
    'entities go in this order: vendors, work centers and customers; vendor services; parts; bills of ' +
    'materials and routings. preview_import runs the same checks without saving. Returns how many rows ' +
    'were created, updated and skipped, and a link to the records in Jigged.',
  access: 'write',
  destructive: true,
  // Every route upserts on the record's identity: the same rows again leave the same records.
  idempotent: true,
  input: importInput,
  output: importOutput,
  run: (args, env) => runImport(args, env, false),
});

export function registerImportTools(server: ToolTarget): void {
  registerCompanyTool(server, previewImport);
  registerCompanyTool(server, importRecords);
}

/** Exported for the catalogue test. */
export const IMPORT_TOOLS = [previewImport, importRecords];
