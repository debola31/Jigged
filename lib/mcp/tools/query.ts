import { z } from 'zod';

import { callBackend } from '@/lib/mcp/backend';
import { defineCompanyTool, registerCompanyTool, type ToolTarget } from '@/lib/mcp/defineTool';

/**
 * Shop data by SQL, for the assistant's own answers and charts. The assistant writes the query;
 * Jigged runs it and returns rows. NO MODEL OF JIGGED'S RUNS: no AI credits, no `ai_jobs` row.
 *
 * Both tools call the FastAPI backend (api/routes/insights_routes.py), because the SQL sandbox is
 * the backend's: `POST /api/insights/{company}/query` runs the statement through the same
 * validator and executor as AI Insights, as `jigged_ai_readonly` with the company set per
 * transaction, so the DATABASE enforces the company, the archive filter and what is readable
 * (the `ai_readonly_select` policies; docs/modules/ai-insights.md). Nothing here re-checks a
 * statement: one validator, in Python.
 *
 * `get_data_schema` serves the schema notes and business definitions the insights model writes
 * against (`SCHEMA_CONTEXT`, `api/services/ai/semantics.md`) from the backend, verbatim. A
 * TypeScript copy would be a second schema description to drift, and those two files are the ones
 * CI checks against the database.
 *
 * WHO: every office user, as AI Insights is in the app (the ask bar has no admin gate). Operators
 * are refused by the wrapper and again by the backend. The `ai_insights` flag is not followed: it
 * switches off Jigged's own chat, not access to the data, which every other read tool returns.
 *
 * Who did a piece of work (`completed_by`, `operator_id`, the other `*_by` columns) is refused by
 * the backend, at the statement and in the result: the surveillance guardrail, which the catalogue
 * test can check only for declared output fields.
 */

/** sql_executor.MAX_ROWS. Pinned by api/tests/unit/test_insights_query_route.py. */
export const ROW_CAP = 200;
/** sql_executor.STATEMENT_TIMEOUT_MS / 1000. Pinned likewise. */
export const TIMEOUT_SECONDS = 5;
/** models/insights_models.DATA_QUERY_MAX_SQL_CHARS. Pinned likewise. */
export const MAX_SQL_CHARS = 10_000;

// ---------------------------------------------------------------------------
// get_data_schema
// ---------------------------------------------------------------------------

const SchemaResponse = z.object({
  schema_context: z.string(),
  semantics: z.string(),
  query_rules: z.array(z.string()),
  row_cap: z.number().int(),
  timeout_seconds: z.number(),
});

export const getDataSchema = defineCompanyTool({
  name: 'get_data_schema',
  title: 'Get the shop data schema',
  description:
    'Returns what query_shop_data runs against: the tables and columns that can be read, with ' +
    'notes on each and how they join; Jigged\'s definitions of business terms (late job, revenue, ' +
    'job value, open quote, this quarter and other periods), each with reference SQL; and the ' +
    `rules a query is held to ($1 for the company, $2 for today, one SELECT, at most ${ROW_CAP} ` +
    'rows). These are the same notes Jigged\'s own Insights writes its queries from. Reads none ' +
    'of the company\'s records.',
  access: 'read',
  input: {},
  output: {
    schema: z.string().describe('The readable tables and their columns, with notes and example queries.'),
    definitions: z
      .string()
      .describe('Business terms as Jigged defines them, with reference SQL using $1 and $2.'),
    rules: z.array(z.string()).describe('What query_shop_data holds a statement to.'),
    row_cap: z.number().describe('The most rows one query returns.'),
    timeout_seconds: z.number().describe('How long a query may run before it is stopped.'),
  },
  run: async (_args, env) => {
    const res = await callBackend(env, `/api/insights/${env.company.id}/schema`, SchemaResponse, {
      method: 'GET',
    });
    return {
      ok: true,
      data: {
        schema: res.schema_context,
        definitions: res.semantics,
        rules: res.query_rules,
        row_cap: res.row_cap,
        timeout_seconds: res.timeout_seconds,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// query_shop_data
// ---------------------------------------------------------------------------

const QueryResponse = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number().int(),
  row_cap: z.number().int(),
  capped: z.boolean(),
});

export const queryShopData = defineCompanyTool({
  name: 'query_shop_data',
  title: 'Query shop data with SQL',
  description:
    'Runs one read-only SQL query (PostgreSQL: a single SELECT, or WITH ... SELECT) over this ' +
    `company's Jigged data and returns the column names and at most ${ROW_CAP} rows, with a note ` +
    'when that cap may have cut the result. For counts, totals, trends and the data behind a ' +
    'chart. Nothing is changed: any other kind of statement is refused. Jigged\'s own AI is not ' +
    'used. Write company_id = $1 to scope each company table (Jigged binds the id; a query ' +
    'without $1 is refused) and $2 for today\'s date, sent as `today`; CURRENT_DATE and now() are ' +
    `refused. Archived records are not visible. A query stops after ${TIMEOUT_SECONDS} seconds. ` +
    'Columns recording who did a piece of work (completed_by, operator_id and other *_by columns) ' +
    'cannot be queried. The tables, columns and Jigged\'s definitions of terms such as late job and ' +
    'revenue come from get_data_schema.',
  access: 'read',
  openWorld: false,
  input: {
    sql: z
      .string()
      .min(1)
      .max(MAX_SQL_CHARS)
      .describe('One PostgreSQL SELECT. company_id = $1 scopes a table to this company; $2 is today.'),
    today: z.iso
      .date()
      .optional()
      .describe("The shop's local date (YYYY-MM-DD), bound as $2. Needed only when the query uses $2."),
  },
  output: {
    columns: z.array(z.string()).describe('The column names, in order.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('One object per row, keyed by column name. Numbers are numbers; dates are ISO strings.'),
    row_count: z.number().describe('How many rows are in `rows`.'),
    capped: z
      .boolean()
      .describe(`True when ${ROW_CAP} rows came back, the most one query returns: more may match.`),
    note: z.string().nullable().describe('Why the result may be incomplete; null when it is not.'),
  },
  run: async (args, env) => {
    const res = await callBackend(env, `/api/insights/${env.company.id}/query`, QueryResponse, {
      body: args.today ? { sql: args.sql, today: args.today } : { sql: args.sql },
    });
    return {
      ok: true,
      data: {
        columns: res.columns,
        rows: res.rows,
        row_count: res.row_count,
        capped: res.capped,
        note: res.capped
          ? `Only the first ${res.row_cap} rows came back, the most one query returns, and the ` +
            'query may match more. An aggregate (COUNT, SUM, GROUP BY) or a narrower filter covers the rest.'
          : null,
      },
    };
  },
});

export function registerQueryTools(server: ToolTarget): void {
  registerCompanyTool(server, getDataSchema);
  registerCompanyTool(server, queryShopData);
}

/** Exported for the catalogue test. */
export const QUERY_TOOLS = [getDataSchema, queryShopData];
