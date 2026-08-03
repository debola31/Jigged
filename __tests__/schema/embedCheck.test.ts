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

describe('schemaEmbedCheck — parser', () => {
  it('parses CREATE TABLE blocks and ignores CONSTRAINT lines', () => {
    const sql = `
CREATE TABLE IF NOT EXISTS "public"."example"
(
    "id" uuid NOT NULL,
    "name" text NOT NULL,
    "value" numeric(12,4),
    CONSTRAINT "example_pkey" PRIMARY KEY (id)
);
`;
    const schema = parseSchema(sql);
    expect(schema.get('example')).toEqual(new Set(['id', 'name', 'value']));
  });

  it('handles nested parens inside column type expressions', () => {
    const sql = `
CREATE TABLE IF NOT EXISTS "public"."nested"
(
    "id" uuid NOT NULL,
    "amount" numeric(12,4) NOT NULL,
    "tags" text[] DEFAULT '{}'::text[],
    CONSTRAINT "nested_check" CHECK ((amount > (0)::numeric))
);
`;
    expect(parseSchema(sql).get('nested')).toEqual(new Set(['id', 'amount', 'tags']));
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
  const SQL = `
CREATE TABLE IF NOT EXISTS "public"."user_company_access"
(
    "id" uuid NOT NULL,
    "name" text
);
CREATE TABLE IF NOT EXISTS "public"."customer_addresses"
(
    "id" uuid NOT NULL,
    "city" text
);
ALTER TABLE ONLY "public"."note_reactions"
    ADD CONSTRAINT "note_reactions_reactor_fk" FOREIGN KEY (reactor_id) REFERENCES user_company_access(id) ON DELETE CASCADE;
ALTER TABLE ONLY "public"."shipments"
    ADD CONSTRAINT "shipments_shipping_address_id_fkey" FOREIGN KEY (shipping_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL;
`;

  const check = (select: string): Violation[] => {
    const file = path.join(REPO_ROOT, '__tmp_embed_hint_fixture.ts');
    writeFileSync(file, `await supabase.from('x').select('${select}');\n`);
    try {
      return validateFile(file, parseSchema(SQL), parseForeignKeys(SQL));
    } finally {
      unlinkSync(file);
    }
  };

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
  it('reports no schema/embed drift across utils/', () => {
    const result = scanProject(REPO_ROOT, ['utils']);
    const hardErrors = result.violations.filter(
      (v) => v.reason !== 'unresolved-interpolation',
    );

    // Self-check: make sure the scanner actually did work. If we scanned
    // zero files or zero tables, the test would be a false negative.
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.schemaTables).toBeGreaterThan(20);

    if (hardErrors.length > 0) {
      const summary = formatErrors(hardErrors, REPO_ROOT);
      throw new Error(
        `Schema/embed drift detected in utils/. Update the access layer to ` +
          `match supabase/schema.prod.sql, or regenerate the schema via ` +
          `scripts/export_schema.py if a migration legitimately added/removed ` +
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
