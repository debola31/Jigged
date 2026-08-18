import { readFileSync } from 'fs';
import { join } from 'path';

import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * E2E: the clickwrap chain, once, for real.
 *
 * WHY THIS SPEC EXISTS. Two properties in this feature cannot be proven anywhere
 * else, and both are the kind that pass a unit test while being broken in
 * production:
 *
 *   1. THE DISABLED SUBMIT. jsdom does not do a browser's hit-testing, so a
 *      component test asserting `toBeDisabled()` proves the attribute is set,
 *      not that a real click does nothing. Only a browser proves that.
 *   2. THE IP. Every other test mocks the request. Here the browser makes a real
 *      POST to the real Route Handler, which reads real headers and writes a
 *      real row — so `ip_address IS NOT NULL` is the one assertion in the suite
 *      that exercises browser -> handler -> header -> Postgres end to end.
 *
 * WHY ITS OWN USER, not the shared E2E one. global-setup seeds acceptances for
 * the shared user precisely so the other 15 specs are not blocked by a modal.
 * This spec needs the opposite: someone with NO acceptances. A dedicated user
 * and company means it cannot reach the shared fixtures, and `fullyParallel` is
 * on.
 */

const COMPANY = 'E2E Clickwrap Shop';
const EMAIL = 'e2e-clickwrap@test.local';
const PASSWORD = 'e2e-clickwrap-password-12345';

let companyId = '';
let userId = '';

function envOrThrow(name: string): string {
  const value = process.env[name] ?? '';
  if (!value) throw new Error(`missing ${name} — global-setup should have set this.`);
  return value;
}

function admin(): SupabaseClient {
  return createClient(envOrThrow('TEST_SUPABASE_URL'), envOrThrow('TEST_SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function manifest() {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'public/legal/manifest.json'), 'utf-8'),
  ) as { documents: Record<string, { current: number; versions: { version: number; sha256: string }[] }> };
}

function currentEntry(type: 'tos' | 'privacy') {
  const doc = manifest().documents[type];
  return doc.versions.find((v) => v.version === doc.current)!;
}

test.describe.configure({ mode: 'serial' });

test.describe('clickwrap terms acceptance', () => {
  // Deliberately NOT the shared authenticated state: this spec needs a user who
  // has never accepted anything, which is exactly what global-setup prevents.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const a = admin();

    const { data: existing } = await a.auth.admin.listUsers();
    const found = existing?.users.find((u) => u.email === EMAIL);
    if (found) {
      userId = found.id;
      await a.auth.admin.updateUserById(userId, { password: PASSWORD });
    } else {
      const { data, error } = await a.auth.admin.createUser({
        email: EMAIL,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser failed: ${error.message}`);
      userId = data.user!.id;
    }

    const { data: company } = await a
      .from('companies')
      .select('id')
      .eq('name', COMPANY)
      .maybeSingle();
    if (company) {
      companyId = company.id;
    } else {
      const { data, error } = await a
        .from('companies')
        .insert({ name: COMPANY })
        .select('id')
        .single();
      if (error) throw new Error(`company insert failed: ${error.message}`);
      companyId = data.id;
    }

    // Otherwise the DB write gate closes on this company, same as global-setup.
    await a
      .from('company_billing')
      .upsert({ company_id: companyId, billing_exempt: true }, { onConflict: 'company_id' });

    await a
      .from('user_company_access')
      .upsert(
        { user_id: userId, company_id: companyId, role: 'admin', email: EMAIL, name: 'Clickwrap Tester' },
        { onConflict: 'user_id,company_id' },
      );

    // The state under test: no acceptances at all. Cannot be deleted through the
    // API -- the table is append-only by trigger -- so this asserts rather than
    // clears, and the beforeAll is written to be re-runnable without it.
    const { data: rows } = await a.from('terms_acceptances').select('id').eq('user_id', userId);
    if (rows?.length) {
      test.skip(
        true,
        'This user already has acceptance rows and they cannot be removed (append-only). Use a fresh local stack.',
      );
    }
  });

  test('blocks the dashboard until the terms are accepted, and records a real IP', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // The gate raises a real, focus-trapping modal.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    const submit = dialog.getByRole('button', { name: /i agree — continue/i });
    const box = dialog.getByRole('checkbox', { name: /i agree to the terms/i });

    // THE ASSERTION jsdom CANNOT MAKE. A real browser refuses the click.
    await expect(box).not.toBeChecked();
    await expect(submit).toBeDisabled();

    await box.check();
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Read the record back with service role: the browser cannot read another
    // user's rows, and cannot write its own at all.
    const a = admin();
    const { data: rows } = await a
      .from('terms_acceptances')
      .select('document_type, version, document_sha256, ip_address, ip_source, accepted_via')
      .eq('user_id', userId)
      .order('document_type');

    expect(rows).toHaveLength(2);

    const tos = rows!.find((r) => r.document_type === 'tos')!;
    expect(tos.version).toBe(currentEntry('tos').version);
    expect(tos.document_sha256).toBe(currentEntry('tos').sha256);
    expect(tos.accepted_via).toBe('reacceptance_dashboard');

    // The whole chain, for real: browser -> Route Handler -> header -> Postgres.
    // Everywhere else in the suite this request is mocked.
    expect(tos.ip_address).not.toBeNull();
    expect(tos.ip_source).not.toBe('unavailable');
  });

  test('a superseded acceptance is never edited, only added to', async ({ page }) => {
    const a = admin();

    // Simulate a version bump by inserting an acceptance of a version that is no
    // longer current. Cannot UPDATE the existing rows -- the table refuses -- and
    // that refusal is itself part of what this asserts.
    const { error } = await a.from('terms_acceptances').insert({
      user_id: userId,
      document_type: 'tos',
      version: 9999,
      document_sha256: 'f'.repeat(64),
      accepted_via: 'reacceptance_dashboard',
      ip_source: 'unavailable',
    });
    expect(error).toBeNull();

    const before = await a
      .from('terms_acceptances')
      .select('id, version, document_sha256')
      .eq('user_id', userId)
      .eq('document_type', 'tos')
      .eq('version', currentEntry('tos').version)
      .single();

    // Refused, and the assertion deliberately does not pin WHICH layer refuses.
    // Over PostgREST the GRANT bites first -- service_role holds SELECT and
    // INSERT only, so it returns 42501 before a statement reaches the table --
    // and the append-only trigger sits behind that for anything running as the
    // table's owner. Requiring the trigger's message would make this fail the
    // moment the outer defence does its job, which is backwards.
    const { error: updateError } = await a
      .from('terms_acceptances')
      .update({ version: 1 })
      .eq('id', before.data!.id);
    expect(updateError, 'update was not refused at all').not.toBeNull();

    const { error: deleteError } = await a
      .from('terms_acceptances')
      .delete()
      .eq('id', before.data!.id);
    expect(deleteError, 'delete was not refused at all').not.toBeNull();

    const after = await a
      .from('terms_acceptances')
      .select('document_sha256')
      .eq('id', before.data!.id)
      .single();
    expect(after.data!.document_sha256).toBe(before.data!.document_sha256);

    await page.close();
  });

  test('the documents are readable without signing in, and every version stays reachable', async ({
    browser,
  }) => {
    // A modal covering the document you are being asked to agree to is a
    // clickwrap that does not survive contact with a court.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    for (const path of ['/terms', '/privacy', '/terms/v1', '/privacy/v1']) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText(/version 1/i).first()).toBeVisible();
    }

    await context.close();
  });
});
