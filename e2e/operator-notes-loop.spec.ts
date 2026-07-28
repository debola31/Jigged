import { test, expect } from '@playwright/test';
import { DURABLE_NOTE_BODY } from './global-setup';

/**
 * The read-back loop, end to end.
 *
 * WHY THIS SPEC EXISTS. No E2E spec touched the operator surfaces before this
 * one, which is why the notes-subject migration had to be verified by hand in a
 * browser: the whole suite went green while the operator job feed, the previous-
 * notes sheet and the dashboard activity feed were all untested. Every one of
 * those reads through PostgREST embed hints (`jobs!notes_job_fk(...)`) and RPC
 * signatures that TypeScript cannot check — they compile perfectly and render
 * nothing.
 *
 * WHAT IT ASSERTS. That a note whose subject is the PART, written on one job, is
 * discoverable and readable from a different job for the same part — the product
 * thesis in one flow. Specifically:
 *
 *   1. the affordance advertises that knowledge exists (the count), because
 *      prior knowledge nobody knows about is not reachable whatever the tap
 *      count says;
 *   2. the note itself comes back, with its author and its step.
 *
 * The note is seeded by global-setup rather than runtime-skipped. A skip here
 * would hide precisely the regression this exists to catch — see the jobs.status
 * incident, where a runtime-skipped spec masked a broken SELECT in production.
 */

test.describe('operator read-back loop', () => {
  test('a durable part note is advertised and readable from a later job', async ({ page }) => {
    // Reach the traveler through the UI rather than a constructed URL, so the
    // spec also covers the ids actually resolving.
    await page.goto('/dashboard');
    await page.waitForURL(/\/dashboard\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
    expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

    await page.goto(`/dashboard/${companyId}/jobs`);
    await page.getByRole('gridcell', { name: 'E2E-JS-NOTSTARTED' }).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const jobId = page.url().match(/\/jobs\/([0-9a-f-]{36})/)?.[1];
    expect(jobId, 'job id should be in the job URL').toBeTruthy();

    // The operator hub redirects a single-part job straight to its traveler.
    await page.goto(`/operator/${companyId}/jobs/${jobId}`);
    await page.waitForURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 60_000 });

    // 1. The affordance advertises that there is something to read. This is the
    //    discoverability half — it used to be a bare "Previous notes" label while
    //    Files beside it showed a count.
    const priorNotes = page.getByRole('button', { name: /^Previous notes · \d+$/ });
    await expect(priorNotes).toBeVisible({ timeout: 30_000 });

    // 2. The knowledge itself, written against a DIFFERENT job for this part.
    await priorNotes.click();
    await expect(page.getByText(DURABLE_NOTE_BODY)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('E2E Test User').first()).toBeVisible();
  });

  test('the traveler feed renders without erroring on the notes query', async ({ page }) => {
    // Thin but load-bearing: getJobNotes unions job_id with captured_job_id and
    // embeds two FKs to `jobs`, all as PostgREST strings. A wrong hint throws at
    // runtime and the feed silently shows its error state instead of notes.
    await page.goto('/dashboard');
    await page.waitForURL(/\/dashboard\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];

    await page.goto(`/dashboard/${companyId}/jobs`);
    await page.getByRole('gridcell', { name: 'E2E-JS-DONE' }).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const jobId = page.url().match(/\/jobs\/([0-9a-f-]{36})/)?.[1];

    await page.goto(`/operator/${companyId}/jobs/${jobId}`);
    await page.waitForURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 60_000 });

    await expect(page.getByText('Job Feed')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Could not load the feed.')).toHaveCount(0);
  });
});
