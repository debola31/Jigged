import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Guards the external-operation send/receive migration against silent drift.
// The lifecycle correctness (enum widening, no strandable in_progress state,
// send attribution) lives in raw SQL that TypeScript can't see, so assert on the
// migration text directly.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

function migrationText(): string {
  const file = fs
    .readdirSync(MIGRATIONS_DIR)
    .find((f) => f.endsWith('_external_operation_send_receive.sql'));
  if (!file) throw new Error('external_operation_send_receive migration not found');
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

describe('external_operation_send_receive migration', () => {
  const sql = migrationText();
  const flat = sql.replace(/\s+/g, ' ');

  it("widens job_operations status CHECK to include 'sent'", () => {
    expect(flat).toContain("ADD CONSTRAINT \"job_operations_status_check\"");
    // All four values present in the new CHECK.
    for (const v of ['pending', 'in_progress', 'completed', 'sent']) {
      expect(flat).toContain(`'${v}'`);
    }
  });

  it('adds send attribution columns (sent_at, sent_by → auth.users)', () => {
    expect(flat).toContain('ADD COLUMN "sent_at"');
    expect(flat).toContain('ADD COLUMN "sent_by"');
    expect(flat).toMatch(/job_operations_sent_by_fkey.*auth"?\."?\.?"?users"?/i);
  });

  it('backfills pre-existing external in_progress ops to pending (no strandable state)', () => {
    // markOperationSent requires pending and the internal complete path throws for
    // external ops, so an external op left in_progress could never move again.
    expect(flat).toMatch(/UPDATE "public"\."job_operations".*SET "status" = 'pending'/);
    expect(flat).toMatch(/kind" = 'external'/);
    expect(flat).toMatch(/status" = 'in_progress'/);
  });

  it('logs the backfilled state change as a non-silent job_notes event', () => {
    expect(flat).toContain('INSERT INTO "public"."job_notes"');
    expect(flat).toContain("'event'");
  });
});
