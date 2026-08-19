import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { ensureTermsAccepted } from './fixtures/terms';

/**
 * E2E: someone who already uses Jigged is invited to a SECOND company.
 *
 * WHY THIS SPEC EXISTS. `docs/modules/invitation-system.md` named "existing-user invite" in its own
 * list of untested cases, and the gap had teeth. The accept page had one path — "set up your
 * account", with a password box whose helper text invited an existing user to type the password
 * they already had. GoTrue rejects that with `same_password`, and because `updateUser` ran BEFORE
 * `accept_invitation`, the throw meant the user ALSO never joined the company. A password-shaped
 * error message, a membership-shaped failure, and no way out except clearing a field nothing had
 * told them to fill in.
 *
 * WHY ITS OWN USER, not the shared E2E one. Joining a second company changes what
 * `getPostLoginRoute` does forever after: two companies means `/` stops going straight to the one
 * company and starts following `last_company_id`. Every other spec that opens `/` and expects
 * E2E Test Company would then be at the mercy of this file's ordering, and `fullyParallel` is on.
 * A dedicated user and a dedicated pair of companies means this spec cannot reach them at all.
 *
 * WHAT IS REAL. The user really pre-exists with a password and a company; the second company and
 * its invitation are real rows; `accept_invitation` is the real SECURITY DEFINER RPC against real
 * Postgres; the membership it writes is read back from the database; the password is proven
 * unchanged by signing in with the original one afterwards.
 *
 * WHAT IS STUBBED, AND WHY. Exactly one thing: `GET /team-invites/:id`, which the page calls to
 * read the invitation. That handler returns 500 unless `RESEND_API_KEY` is set — the check sits
 * above the routing, so even this read needs it. Wiring a Resend secret into every developer's
 * local stack and into CI to serve what is a two-row SELECT is a poor trade. If that handler's
 * response shape changes, this spec will not notice; that is the accepted cost, and it applies to
 * nothing else in the flow.
 */

const HOME_COMPANY = 'E2E Multi Home Shop';
const SECOND_COMPANY = 'E2E Multi Second Shop';
const MULTI_EMAIL = 'e2e-multi@test.local';
const MULTI_PASSWORD = 'e2e-multi-password-12345';

let homeCompanyId = '';
let secondCompanyId = '';
let multiUserId = '';
let invitationId = '';

function envOrThrow(name: string): string {
  const value = process.env[name] ?? '';
  if (!value) {
    throw new Error(`missing ${name} — global-setup should have set this.`);
  }
  return value;
}

function admin(): SupabaseClient {
  return createClient(envOrThrow('TEST_SUPABASE_URL'), envOrThrow('TEST_SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Find-or-create, so a local re-run without `supabase db reset` behaves like CI's fresh DB. */
async function findOrCreateCompany(a: SupabaseClient, name: string): Promise<string> {
  const { data: existing } = await a
    .from('companies')
    .select('id')
    .eq('name', name)
    .limit(1)
    .maybeSingle();

  const id =
    existing?.id ??
    (await (async () => {
      const { data, error } = await a.from('companies').insert({ name }).select('id').single();
      if (error || !data) throw new Error(`create company ${name}: ${error?.message}`);
      return data.id as string;
    })());

  // Same reason global-setup does it: without a billing row the write gate closes on the company.
  const { error } = await a
    .from('company_billing')
    .upsert({ company_id: id, billing_exempt: true }, { onConflict: 'company_id' });
  if (error) throw new Error(`company_billing upsert for ${name}: ${error.message}`);
  return id;
}

async function findOrCreateUser(a: SupabaseClient): Promise<string> {
  const { data: list, error: listError } = await a.auth.admin.listUsers();
  if (listError) throw new Error(`listUsers: ${listError.message}`);
  const existing = list.users.find((u) => u.email === MULTI_EMAIL);
  if (existing) {
    // Reset the password so the "password still works afterwards" assertion means something on a
    // re-run against a database a previous run may have touched.
    const { error } = await a.auth.admin.updateUserById(existing.id, { password: MULTI_PASSWORD });
    if (error) throw new Error(`reset password: ${error.message}`);
    return existing.id;
  }

  const { data, error } = await a.auth.admin.createUser({
    email: MULTI_EMAIL,
    password: MULTI_PASSWORD,
    email_confirm: true,
    user_metadata: { first_name: 'Mabel', last_name: 'Okonkwo', display_name: 'Mabel Okonkwo' },
  });
  if (error || !data.user) throw new Error(`create user: ${error?.message}`);
  return data.user.id;
}

test.describe.configure({ mode: 'serial' });

test.describe('existing user invited to a second company', () => {
  // Deliberately NOT the shared authenticated state — this spec signs in as its own user.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const a = admin();
    multiUserId = await findOrCreateUser(a);
    // This spec provisions its own user, so global-setup's seeding does not reach
    // them. Without this the gate disables the Join button and the click below
    // times out with no visible cause.
    await ensureTermsAccepted(a, multiUserId);
    homeCompanyId = await findOrCreateCompany(a, HOME_COMPANY);
    secondCompanyId = await findOrCreateCompany(a, SECOND_COMPANY);

    // Already a member of one shop — this is what makes them an EXISTING user.
    const { error: accessError } = await a
      .from('user_company_access')
      .upsert(
        {
          user_id: multiUserId,
          company_id: homeCompanyId,
          role: 'admin',
          name: 'Mabel Okonkwo',
          email: MULTI_EMAIL,
        },
        { onConflict: 'user_id,company_id' },
      );
    if (accessError) throw new Error(`seed home access: ${accessError.message}`);

    // …and not yet a member of the other one, however many times this has run.
    await a
      .from('user_company_access')
      .delete()
      .eq('user_id', multiUserId)
      .eq('company_id', secondCompanyId);
    await a.from('invitations').delete().eq('email', MULTI_EMAIL).eq('company_id', secondCompanyId);
    await a.from('user_preferences').delete().eq('user_id', multiUserId);

    const { data, error } = await a
      .from('invitations')
      .insert({
        company_id: secondCompanyId,
        email: MULTI_EMAIL,
        role: 'user',
        status: 'pending',
        invited_by: multiUserId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`create invitation: ${error?.message}`);
    invitationId = data.id;
  });

  test('joins in one tap, keeps their password, and can move between both shops', async ({
    page,
  }) => {
    const a = admin();

    // 1. Sign in as the existing user, the way they actually would.
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign In' }).waitFor({ timeout: 60_000 });
    await page.getByLabel('Email').fill(MULTI_EMAIL);
    await page.getByLabel('Password').fill(MULTI_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${homeCompanyId}`), { timeout: 30_000 });

    // 2. The invitation read — the one stubbed call. See the header.
    await page.route(`**/functions/v1/team-invites/${invitationId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: invitationId,
          company_id: secondCompanyId,
          email: MULTI_EMAIL,
          role: 'user',
          status: 'pending',
          invited_by: multiUserId,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          company_name: SECOND_COMPANY,
        }),
      });
    });

    await page.goto(`/accept-invite/${invitationId}`);

    // 3. The regression, stated positively: an established account is asked for nothing.
    const join = page.getByRole('button', { name: new RegExp(`Join ${SECOND_COMPANY}`, 'i') });
    await expect(join).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel(/^password/i)).toHaveCount(0);
    await expect(page.getByLabel(/first name/i)).toHaveCount(0);

    await join.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${secondCompanyId}`), { timeout: 30_000 });

    // 4. The membership is real, not just a redirect that looks right.
    const { data: access } = await a
      .from('user_company_access')
      .select('role')
      .eq('user_id', multiUserId)
      .eq('company_id', secondCompanyId)
      .maybeSingle();
    expect(access?.role, 'the invited role should be granted in the second company').toBe('user');

    // The first shop is untouched — this is an addition, not a move.
    const { data: original } = await a
      .from('user_company_access')
      .select('role')
      .eq('user_id', multiUserId)
      .eq('company_id', homeCompanyId)
      .maybeSingle();
    expect(original?.role, 'existing company access must survive joining another').toBe('admin');

    const { data: inv } = await a
      .from('invitations')
      .select('status, accepted_by')
      .eq('id', invitationId)
      .single();
    expect(inv?.status).toBe('accepted');
    expect(inv?.accepted_by).toBe(multiUserId);

    // 5. The point of the whole fix: the password they arrived with still works.
    const asUser = createClient(
      envOrThrow('TEST_SUPABASE_URL'),
      envOrThrow('TEST_SUPABASE_PUBLISHABLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { error: signInError } = await asUser.auth.signInWithPassword({
      email: MULTI_EMAIL,
      password: MULTI_PASSWORD,
    });
    expect(signInError, 'the original password must still sign them in').toBeNull();

    // 6. And now that they hold two, they can move between them.
    const trigger = page.getByRole('button', { name: new RegExp(SECOND_COMPANY, 'i') }).first();
    await expect(trigger).toBeEnabled({ timeout: 30_000 });
    await trigger.click();

    const homeRow = page.getByRole('button', { name: new RegExp(HOME_COMPANY, 'i') });
    await expect(homeRow).toBeVisible({ timeout: 15_000 });
    await homeRow.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${homeCompanyId}`), { timeout: 30_000 });
  });
});
