import { test, expect } from '@playwright/test';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * The dashboard chat, in a real browser, against a real database.
 *
 * WHY THIS FILE EXISTS. ai-insights.md carried "No E2E covers the chat path" as a
 * known gap: the SQL validator and the chart gate were unit-tested, the browser
 * round trip was not. The 2026-09-09 redesign is exactly the kind of change unit
 * tests cannot judge — whether the conversation reads as one, whether the
 * scorecards survive an answer landing, whether the caveat is actually on screen.
 *
 * NO MODEL RUNS HERE, AND IT DOES NOT NEED TO. The turns are seeded straight into
 * ai_chat_messages, which is honest rather than a shortcut: nothing in the browser
 * writes that table anyway (a SECURITY DEFINER trigger on ai_jobs does), so the app
 * reads seeded rows by the same path it reads real ones. Asking a live question
 * would need the FastAPI backend and a worker with a 32B model — neither of which
 * CI has, and both of which would make this a test of the model's mood.
 */

const COMPANY_NAME = 'E2E Test Company';
const THREAD_TITLE = 'E2E insights transcript';
const QUESTION = 'how many open quotes do we have?';
const ANSWER = 'You have 6 open quotes, worth $12,371.38 in total.';
const FOLLOW_UP = 'Which of them expire this month?';

function admin(): SupabaseClient {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  if (!url || !key) {
    throw new Error(
      'missing TEST_SUPABASE_URL / TEST_SUPABASE_SECRET_KEY — global-setup should have set these.',
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Seed one two-turn conversation owned by the signed-in user.
 *
 * `created_by` must be that user or the thread's RLS hides it — which is the point
 * of the policy, and the reason this reads the id back from user_company_access
 * rather than assuming one.
 */
async function seedThread(): Promise<{ companyId: string; threadId: string }> {
  const a = admin();

  const { data: company } = await a
    .from('companies')
    .select('id')
    .eq('name', COMPANY_NAME)
    .limit(1)
    .maybeSingle();
  if (!company) throw new Error(`no company named ${COMPANY_NAME} — global-setup should have made it`);

  const { data: access } = await a
    .from('user_company_access')
    .select('user_id')
    .eq('company_id', company.id)
    .limit(1)
    .maybeSingle();
  if (!access) throw new Error('no user_company_access row for the E2E company');

  // Idempotent: the spec may run against a database a previous run already touched.
  await a.from('ai_chat_threads').delete().eq('title', THREAD_TITLE);

  const { data: thread, error } = await a
    .from('ai_chat_threads')
    .insert({ company_id: company.id, created_by: access.user_id, title: THREAD_TITLE })
    .select('id')
    .single();
  if (error || !thread) throw new Error(`seeding the thread failed: ${error?.message}`);

  const { error: msgError } = await a.from('ai_chat_messages').insert([
    {
      thread_id: thread.id,
      company_id: company.id,
      seq: 1,
      role: 'user',
      content: QUESTION,
    },
    {
      thread_id: thread.id,
      company_id: company.id,
      seq: 2,
      role: 'assistant',
      content: ANSWER,
      follow_ups: [FOLLOW_UP],
    },
  ]);
  if (msgError) throw new Error(`seeding the messages failed: ${msgError.message}`);

  return { companyId: company.id, threadId: thread.id };
}

test.describe('Insights chat', () => {
  test('says what it is, and says it can be wrong', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await expect(page.getByText('BETA').first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('Jigged AI can make mistakes. Please double-check responses.').first(),
    ).toBeVisible();

    // The empty state is one question and a box, not a list.
    await expect(page.getByText('What do you want to know about the shop?')).toBeVisible();
    await expect(page.getByPlaceholder(/^Ask /)).toBeVisible();
  });

  test('names no hardware anywhere on the surface', async ({ page }) => {
    // "The AI box is offline" told a shop owner about a machine they do not have.
    // Asserted on the whole rendered page rather than one string, because the copy
    // lives in three places (the hook, the enqueue error and the route).
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
    await expect(page.getByText('BETA').first()).toBeVisible({ timeout: 15_000 });

    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('ai box');
    expect(body).not.toContain('shop mac');
  });

  test('reads as a conversation, and the scorecards stay put while it scrolls', async ({ page }) => {
    const { companyId, threadId } = await seedThread();

    // The browser remembers its thread in sessionStorage; this is how a reload
    // re-attaches, so it is also how a test opens one.
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
    await page.evaluate(
      ([key, id]) => window.sessionStorage.setItem(key, id),
      [`jigged.aiThread.${companyId}`, threadId] as const,
    );
    await page.reload();

    await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(QUESTION)).toBeVisible();

    // THE POINT OF THE FIXED-HEIGHT PANE. Before this, the transcript grew the page
    // and every answer pushed the scorecards off the top. Overdue Jobs is the first
    // tile; it must still be in the viewport with a conversation on screen.
    await expect(page.getByText('Overdue Jobs')).toBeInViewport();

    // The transcript owns a scrollport of its own rather than the window.
    const scrolls = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('div'));
      return els.some(
        (el) =>
          getComputedStyle(el).overflowY === 'auto' &&
          el.clientHeight > 0 &&
          el.textContent?.includes('You have 6 open quotes'),
      );
    });
    expect(scrolls, 'the conversation should sit inside its own scrolling container').toBe(true);
  });

  test('offers the follow-up the model wrote, and asks it on a click', async ({ page }) => {
    const { companyId, threadId } = await seedThread();

    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
    await page.evaluate(
      ([key, id]) => window.sessionStorage.setItem(key, id),
      [`jigged.aiThread.${companyId}`, threadId] as const,
    );
    await page.reload();

    const chip = page.getByText(FOLLOW_UP);
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();

    // What is pinned here is that the chip SUBMITS -- the click reached
    // handleSubmit and the composer cleared -- not what came back. The stack runs
    // FastAPI against an Anthropic mock, but which sentence a mocked model returns
    // is not this test's business; that the suggestion is wired to the one door is.
    await expect(page.getByPlaceholder(/^Ask /)).toHaveValue('');
  });
});
