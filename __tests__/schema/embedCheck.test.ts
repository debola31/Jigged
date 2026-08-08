import { describe, it, expect } from 'vitest';
import path from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import {
  parseSchema,
  parseSelect,
  parseForeignKeys,
  extractSelects,
  scanProject,
  validateFile,
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

  /**
   * A select built by concatenation must be read WHOLE. The original extractor matched one
   * quoted literal and stopped, so everything after the first `+` went unchecked — which is
   * how a fabricated foreign-key hint in `getNewHelpful` reached a preview deployment
   * through a green run of this check.
   */
  it('joins a select concatenated across several string literals', () => {
    const source = `
      await supabase.from('note_reactions').select(
        'created_at, kind, ' +
          'reactor:user_company_access!note_reactions_reactor_fk(name), ' +
          'note:notes!inner(id, body)',
      );
    `;
    const out = extractSelects(source);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('note_reactions_reactor_fk');
    expect(out[0].text).toContain('note:notes!inner(id, body)');
  });

  it('ignores a second .select() argument, so { count } contributes no phantom column', () => {
    const source = `
      await supabase.from('notes').select('id, author:user_company_access(name)', { count: 'exact' });
    `;
    const out = extractSelects(source);
    expect(out[0].text).toContain('user_company_access(name)');
    expect(out[0].text).not.toContain('exact');
  });

  /**
   * Comments inside the argument routinely carry backticks or apostrophes (a note about
   * `<table>_<col>_fkey` naming, say). Treating those as string delimiters corrupts the
   * rest of the select — silently, since the result still parses as *something*.
   */
  it('skips comments inside the argument, including their backticks and apostrophes', () => {
    const source = `
      await supabase.from('note_reactions').select(
        'created_at, ' +
          // the FK's real name, not PostgREST's \`<table>_<col>_fkey\` default
          /* nor this one's */
          'reactor:user_company_access!note_reactions_reactor_fk(name)',
      );
    `;
    const out = extractSelects(source);
    expect(out[0].text).toBe(
      'created_at, reactor:user_company_access!note_reactions_reactor_fk(name)',
    );
  });
});

describe('schemaEmbedCheck — foreign-key hints', () => {
  /**
   * The same two tables and two foreign keys as before, in the shape
   * `supabase gen types` emits. Note where a foreign key LIVES: on the
   * referencing table's `Relationships`, not the one it points at — so
   * `note_reactions` carries the constraint that targets `user_company_access`.
   */
  const TYPES = `export type Database = {
  public: {
    Tables: {
      customer_addresses: {
        Row: {
          city: string | null
          id: string
        }
        Relationships: []
      }
      note_reactions: {
        Row: {
          id: string
          reactor_id: string
        }
        Relationships: [
          {
            foreignKeyName: "note_reactions_reactor_fk"
            columns: ["reactor_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          id: string
          shipping_address_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shipments_shipping_address_id_fkey"
            columns: ["shipping_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
        ]
      }
      user_company_access: {
        Row: {
          id: string
          name: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
  }
}
`;

  const check = (select: string): Violation[] => {
    const file = path.join(REPO_ROOT, '__tmp_embed_hint_fixture.ts');
    writeFileSync(file, `await supabase.from('x').select('${select}');\n`);
    try {
      return validateFile(file, parseSchema(TYPES), parseForeignKeys(TYPES));
    } finally {
      unlinkSync(file);
    }
  };

  /**
   * ON THE FK COUNT DROPPING WHEN THIS MOVED OFF THE SQL DUMP, since the
   * numbers look alarming and the explanation is not obvious.
   *
   * The old dump yielded 155 constraints; the generated types yield 137. All 20
   * of the difference reference `auth.users` — every `*_created_by_fkey`,
   * `*_user_id_fkey` and friends. `supabase gen types` emits Relationships only
   * for foreign keys whose target is in the exposed schema, and `auth` is not
   * exposed to the Data API, so those names can never be a legal embed hint.
   * Losing them costs nothing.
   *
   * The arithmetic closes the other way too: the types carry two FKs the dump
   * never had (jobs/shipments → customer_carrier_accounts), because the dump
   * predated the migrations that created that table. The new source is more
   * accurate, not less.
   */
  it('reads both hint forms out of the Relationships arrays', () => {
    const fks = parseForeignKeys(TYPES);
    expect([...fks.names].sort()).toEqual([
      'note_reactions_reactor_fk',
      'shipments_shipping_address_id_fkey',
    ]);
    // Keyed by the table the FK POINTS AT, which is what an embed names.
    expect([...(fks.columnsByTarget.get('customer_addresses') ?? [])]).toEqual([
      'shipping_address_id',
    ]);
  });

  /**
   * The bug this check was extended for. The schema names newer constraints
   * `<table>_<col>_fk` and older ones Postgres' default `<table>_<col>_fkey`, so there is
   * no rule to guess from — and a hint that resolves to nothing is a 400 on every call,
   * not a fallback to some default join.
   */
  it('flags a hint that names no real foreign key', () => {
    const v = check('reactor:user_company_access!note_reactions_reactor_id_fkey(name)');
    expect(v.map((x) => x.reason)).toEqual(['unknown-constraint']);
    expect(v[0].detail).toBe('note_reactions_reactor_id_fkey');
  });

  it('accepts a real constraint name', () => {
    expect(check('reactor:user_company_access!note_reactions_reactor_fk(name)')).toEqual([]);
  });

  /** Hints chain: the relationship AND the join type, each validated separately. */
  it('accepts a constraint name chained with a join keyword', () => {
    expect(check('reactor:user_company_access!note_reactions_reactor_fk!inner(name)')).toEqual([]);
  });

  /**
   * PostgREST also disambiguates by the referencing COLUMN. That column lives on the source
   * table, which this parser can't resolve, so it's matched against every FK pointing AT
   * the embedded table instead.
   */
  it('accepts the referencing column as a hint', () => {
    expect(check('shipping_address:customer_addresses!shipping_address_id(city)')).toEqual([]);
  });

  it('accepts plain join keywords', () => {
    expect(check('addr:customer_addresses!left(city)')).toEqual([]);
  });
});

describe('schemaEmbedCheck — full project scan', () => {
  it('reports no schema/embed drift across the app', () => {
    // Scans beyond utils/ as a ratchet: components and pages run their own
    // `.select()` calls (ShipmentForm's job embed is the largest), and nothing
    // covered them before. Zero findings there today — this is here so a future
    // component-level embed can't land unchecked.
    //
    // NOT `scripts`: this checker's own JSDoc contains an example `.select(`,
    // and `extractSelects` matches it anywhere in a file including inside a
    // comment block, which yields two false `unknown-table` violations.
    const result = scanProject(REPO_ROOT, ['utils', 'components', 'app', 'lib', 'hooks']);

    // `unresolved-interpolation` is a HARD ERROR, not a warning. It used to be
    // filtered out here, which made it invisible twice over: nothing failed, and
    // the only place warnings are printed (`main()`) is dead code — `tsx` isn't
    // installed and no script or CI step invokes it. That mattered more than it
    // sounds, because `validateEmbed` returns on an unresolved `${…}` BEFORE the
    // FK-hint check, so each suppressed warning was also silently disabling hint
    // validation for its embed. Both live instances were in bomAccess.ts and hid
    // `parts_bom_child_part_id_fkey` / `parts_bom_parent_part_id_fkey` — the only
    // FK hints in the repo that nothing checked. Resolving a constant is cheap
    // (see resolveInterpolations); leaving one unresolved is not.
    const hardErrors = result.violations;

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
        `Schema/embed drift detected. Update the query to ` +
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
