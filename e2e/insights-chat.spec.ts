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

// UNIQUE PER TEST, and that is not incidental. Both seeding tests run in the same
// worker pool; with one shared title, each one's "delete then insert" wiped the
// other's thread mid-run and the page found nothing. It passed for a while on
// timing alone, which is the worst way for a test to pass.
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
 * Seed one two-turn conversation owned by the signed-in user, in the company the
 * browser actually landed on.
 *
 * TAKES THE COMPANY FROM THE URL, never by name. Looking up 'E2E Test Company'
 * seeded whichever row happened to carry that name while the browser opened
 * whatever company homePathForRole picked — and a user with more than one company
 * (which any other suite's seed data can create) put those two on different rows.
 * The thread then existed, owned by the right user, on a company the page was not
 * showing. Reading the id out of /dashboard/{companyId} cannot drift from what is
 * on screen.
 *
 * `created_by` must be the signed-in user or the thread's RLS hides it — which is
 * the point of the policy, and the reason this reads the id back from
 * user_company_access rather than assuming one.
 */
async function seedThread(companyId: string, suffix: string): Promise<{ threadId: string }> {
  const a = admin();
  const title = `${THREAD_TITLE} — ${suffix}`;
  const company = { id: companyId };

  const { data: access } = await a
    .from('user_company_access')
    .select('user_id')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();
  if (!access) throw new Error(`no user_company_access row for company ${companyId}`);

  // Idempotent: the spec may run against a database a previous run already touched.
  await a.from('ai_chat_threads').delete().eq('title', title);

  const { data: thread, error } = await a
    .from('ai_chat_threads')
    .insert({ company_id: company.id, created_by: access.user_id, title })
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

  return { threadId: thread.id };
}

/** The company the browser opened, read from /dashboard/{companyId}. */
async function openDashboard(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const match = /\/dashboard\/([0-9a-f-]{36})/.exec(page.url());
  if (!match) throw new Error(`could not read a companyId from ${page.url()}`);
  return match[1];
}

test.describe('Insights chat', () => {
  test('invites before it warns: a heading, three starters, and no caveat yet', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // An offer, not a demand — and scoped to what the product does today.
    await expect(page.getByRole('heading', { name: 'Ask about your shop' })).toBeVisible({
      timeout: 15_000,
    });

    // NO CAVEAT BEFORE THERE IS AN ANSWER. A warning about mistakes shown to
    // someone who has not yet done anything was the most off-putting thing on
    // this surface; it is read under the composer from the first answer on.
    await expect(page.getByText(/check the numbers before you act/)).toHaveCount(0);
    await expect(page.getByText(/can make mistakes/i)).toHaveCount(0);

    // What stands in its place invites, and every noun in it is a subject the
    // assistant can actually read.
    await expect(
      page.getByText('Ask about your jobs, quotes, parts, customers, vendors and work centers.'),
    ).toBeVisible();

    // Three starters, one per shape of answer — not five, and not a filter bar.
    await expect(page.getByRole('button', { name: /How many jobs are late right now\?/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /What is my revenue trend over time\?/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /One-page report on this quarter/ })).toBeVisible();
    await expect(page.getByText(/quote pipeline/i)).toHaveCount(0);

    // No title and no BETA pill: the heading says what this is.
    await expect(page.getByText('Ask the shop')).toHaveCount(0);
    await expect(page.getByText('BETA')).toHaveCount(0);
    await expect(page.getByLabel('Your question')).toBeVisible();
  });

  test('names no hardware anywhere on the surface', async ({ page }) => {
    // "The AI box is offline" told a shop owner about a machine they do not have.
    // Asserted on the whole rendered page rather than one string, because the copy
    // lives in three places (the hook, the enqueue error and the route).
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Chat history' })).toBeVisible({
      timeout: 15_000,
    });

    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('ai box');
    expect(body).not.toContain('shop mac');
  });

  test('reads as a conversation, and the scorecards stay put while it scrolls', async ({ page }) => {
    const companyId = await openDashboard(page);
    const { threadId } = await seedThread(companyId, 'transcript');

    // The browser remembers its thread in sessionStorage; this is how a reload
    // re-attaches, so it is also how a test opens one.
    await page.evaluate(
      ([key, id]) => window.sessionStorage.setItem(key, id),
      [`jigged.aiThread.${companyId}`, threadId] as const,
    );
    await page.reload();

    await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(QUESTION)).toBeVisible();

    // The caveat arrives with the answer, and names the failure this system has.
    await expect(page.getByText(/check the numbers before you act/).first()).toBeVisible();

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
    const companyId = await openDashboard(page);
    const { threadId } = await seedThread(companyId, 'follow-ups');

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
    // Found by accessible name rather than placeholder: the placeholder is copy
    // and changes with the state, the label is the contract.
    await expect(page.getByLabel('Your question')).toHaveValue('');
  });
});
