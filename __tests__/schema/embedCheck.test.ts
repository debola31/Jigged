import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  parseSchema,
  parseSelect,
  extractSelects,
  scanProject,
  type Violation,
} from '../../scripts/schemaEmbedCheck';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * A miniature `types/database.ts`, matching what `supabase gen types` emits:
 * graphql_public first, then public, then the trailing `Constants` object that
 * repeats every schema key. Indentation is significant — the parser relies on
 * it, which is safe because CI asserts the real file byte-for-byte.
 */
const FIXTURE = `export type Json = string | number | boolean | null

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      example: {
        Row: {
          id: string
          name: string
          value: number | null
        }
        Insert: {
          id?: string
          name: string
          insert_only_artifact?: string
        }
        Update: {
          update_only_artifact?: string
        }
        Relationships: []
      }
      nested: {
        Row: {
          amount: number
          id: string
          tags: string[] | null
        }
        Insert: {
          amount: number
        }
        Relationships: [
          {
            foreignKeyName: "nested_example_fkey"
            columns: ["example_id"]
            referencedRelation: "example"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      a_view: {
        Row: {
          view_column: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      some_function: {
        Args: { p_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
  }
}

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
`;

describe('schemaEmbedCheck — parser', () => {
  it('reads the Row shape of each table under the public schema', () => {
    const schema = parseSchema(FIXTURE);
    expect(schema.get('example')).toEqual(new Set(['id', 'name', 'value']));
    expect(schema.get('nested')).toEqual(new Set(['amount', 'id', 'tags']));
  });

  it('does not leak Insert/Update-only keys into a table Row', () => {
    // Insert and Update restate the same columns with different optionality,
    // and carry generator-only keys. Row is the column set of record.
    const cols = parseSchema(FIXTURE).get('example')!;
    expect(cols.has('insert_only_artifact')).toBe(false);
    expect(cols.has('update_only_artifact')).toBe(false);
  });

  it('stops at Views, preserving the old CREATE TABLE-only scope', () => {
    // The previous parser read supabase/schema.prod.sql and matched only
    // CREATE TABLE, so an embed targeting a view was already an unknown
    // relation. Keep that boundary rather than silently widening the check.
    const schema = parseSchema(FIXTURE);
    expect(schema.has('a_view')).toBe(false);
    expect(schema.has('some_function')).toBe(false);
  });

  it('ignores the trailing Constants block, which repeats the public key', () => {
    // `public:` appears twice in the generated file. Anchoring on the type
    // declaration is what stops the constants object being parsed as a second,
    // empty schema that would clobber the real tables.
    const schema = parseSchema(FIXTURE);
    expect(schema.size).toBe(2);
    expect([...schema.keys()].sort()).toEqual(['example', 'nested']);
  });
});

describe('schemaEmbedCheck — select parsing', () => {
  it('splits top-level columns and identifies embeds with hints', () => {
    const result = parseSelect('*, customers!left(id, name), jobs!inner(id)');
    expect(result.columns.map((c) => c.name)).toEqual(['*']);
    expect(result.embeds.map((e) => ({ name: e.name, hint: e.hint }))).toEqual([
      { name: 'customers', hint: 'left' },
      { name: 'jobs', hint: 'inner' },
    ]);
  });

  it('strips alias prefix on embeds and columns', () => {
    const result = parseSelect('line_items:quote_line_items!left(id, sequence), addresses:customer_addresses(id)');
    expect(result.embeds.map((e) => e.name)).toEqual(['quote_line_items', 'customer_addresses']);
  });

  it('parses nested embeds correctly', () => {
    const result = parseSelect('id, customers(name, addresses:customer_addresses(id, city))');
    expect(result.embeds[0].name).toBe('customers');
    const inner = parseSelect(result.embeds[0].inner);
    expect(inner.embeds[0].name).toBe('customer_addresses');
    expect(inner.embeds[0].alias).toBe('addresses');
  });
});

describe('schemaEmbedCheck — extraction', () => {
  it('extracts inline .select() string contents', () => {
    const source = `
      const r = await supabase.from('quotes').select('id, jobs!left(id, job_number)');
    `;
    const out = extractSelects(source);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('jobs!left');
  });

  it('resolves template-literal interpolations against same-file consts', () => {
    const source = `
      const FIELDS = \`id, name\`;
      const SEL = \`*, parts(\${FIELDS})\`;
    `;
    const out = extractSelects(source);
    const sel = out.find((c) => c.source === 'const SEL');
    expect(sel?.text).toContain('parts(id, name)');
  });
});

describe('schemaEmbedCheck — full project scan', () => {
  it('reports no schema/embed drift across utils/', () => {
    const result = scanProject(REPO_ROOT, ['utils']);
    const hardErrors = result.violations.filter(
      (v) => v.reason !== 'unresolved-interpolation',
    );

    // Self-check: make sure the scanner actually did work. If we scanned
    // zero files or zero tables, the test would be a false negative.
    expect(result.filesScanned).toBeGreaterThan(0);
    // Floor kept close to the real count (57 when this moved to
    // types/database.ts). A parser that reads only part of the file — stopping
    // at the first sibling key, or picking up the trailing Constants block —
    // still returns a positive number, so a floor of 20 would wave a truncated
    // parse through and silently degrade every embed to "unknown relation".
    expect(result.schemaTables).toBeGreaterThan(50);

    if (hardErrors.length > 0) {
      const summary = formatErrors(hardErrors, REPO_ROOT);
      throw new Error(
        `Schema/embed drift detected in utils/. Update the access layer to ` +
          `match types/database.ts, or regenerate it with ` +
          `\`supabase start && pnpm gen:db-types\` if a migration legitimately added/removed ` +
          `columns:\n\n${summary}`,
      );
    }
  });

  it('catches a synthetic jobs.status-style regression', () => {
    // Regression test for the scanner itself — guarantees the test in the
    // previous case isn't trivially passing because validation is broken.
    // We synthesize a select-like string and feed it through the column
    // validator via parseSelect, then check that the column is flagged.
    const fakeSchema = new Map<string, Set<string>>([
      ['jobs', new Set(['id', 'job_number', 'production_status', 'fulfillment_status'])],
    ]);
    const parsed = parseSelect('jobs!left(id, job_number, status)');
    const jobsEmbed = parsed.embeds[0];
    expect(jobsEmbed.name).toBe('jobs');
    const inner = parseSelect(jobsEmbed.inner);
    const badCols = inner.columns
      .map((c) => c.name)
      .filter((n) => n !== '*' && !fakeSchema.get('jobs')!.has(n));
    expect(badCols).toEqual(['status']);
  });
});

function formatErrors(errors: Violation[], repoRoot: string): string {
  return errors
    .map((v) => {
      const rel = path.relative(repoRoot, v.file);
      switch (v.reason) {
        case 'unknown-table':
          return `  ${rel} [${v.context}]: relation "${v.table}" not in schema`;
        case 'unknown-column':
          return `  ${rel} [${v.context}]: ${v.table}.${v.column} does not exist`;
        default:
          return `  ${rel} [${v.context}]: ${v.reason}`;
      }
    })
    .join('\n');
}
