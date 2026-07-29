import { test, expect, type Page } from '@playwright/test';
import { navigateTo, waitForGridLoaded } from './helpers/navigation';
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
 * thesis in one flow:
 *
 *   1. the affordance advertises that knowledge exists (the count), because
 *      prior knowledge nobody knows about is not reachable whatever the tap
 *      count says;
 *   2. the note itself comes back, with its author.
 *
 * The note is seeded by global-setup rather than runtime-skipped. A skip would
 * hide precisely the regression this exists to catch — see the jobs.status
 * incident, where a runtime-skipped spec masked a broken SELECT in production.
 */

const JOB_SEARCH = /Job #, PO, customer/i;

/**
 * Land on a job's operator traveler.
 *
 * Goes through the UI rather than a constructed URL so the spec also covers the
 * ids resolving. Note `/dashboard` is NOT a route — only `/dashboard/[companyId]`
 * exists — so entry is via `/`, which redirects to the user's company. The
 * operator hub then redirects a single-part job straight to its traveler.
 */
async function openTravelerFor(page: Page, jobNumber: string): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

  await navigateTo(page, 'Jobs');
  await waitForGridLoaded(page);
  await page.getByPlaceholder(JOB_SEARCH).fill(jobNumber);
  await waitForGridLoaded(page);

  // getByText, matching the pattern the passing jobs-list specs use — the grid
  // does not expose job numbers as named gridcells reliably.
  await page.getByText(jobNumber).first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const jobId = page.url().match(/\/jobs\/([0-9a-f-]{36})/)?.[1];
  expect(jobId, 'job id should be in the job URL').toBeTruthy();

  await page.goto(`/operator/${companyId}/jobs/${jobId}`);
  await expect(page).toHaveURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

test.describe('operator read-back loop', () => {
  test('a durable part note is advertised and readable from a later job', async ({ page }) => {
    await openTravelerFor(page, 'E2E-JS-NOTSTARTED');

    // 1. The affordance advertises that there is something to read. This is the
    //    discoverability half — it used to be a bare "Playbook" label while
    //    Files beside it showed a count.
    const priorNotes = page.getByRole('button', { name: /^Playbook · \d+$/ });
    await expect(priorNotes).toBeVisible({ timeout: 30_000 });

    // 2. The knowledge itself, written against a DIFFERENT job for this part.
    //
    // Scoped to the sheet (a fullScreen Dialog) rather than the page. A bare
    // getByText(...).first() matched whichever author name came first in DOM
    // order — and the traveler's collapsed feed sits behind this dialog with its
    // children MOUNTED BUT HIDDEN, so as soon as that job had any note the first
    // match became an invisible one and this failed on `hidden`, not on absence.
    // The count assertion above is deliberately left page-wide: the affordance is
    // on the traveler, not in the sheet.
    await priorNotes.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(DURABLE_NOTE_BODY)).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText('E2E Test User').first()).toBeVisible();
  });

  test('the traveler feed renders without erroring on the notes query', async ({ page }) => {
    // Thin but load-bearing: getJobNotes unions job_id with captured_job_id and
    // embeds two FKs to `jobs`, all as PostgREST strings. A wrong hint throws at
    // runtime and the feed silently shows its error state instead of notes.
    //
    // Uses an OPEN job deliberately. E2E-JS-DONE would be the better subject —
    // it is where the seeded note was captured, so its feed exercises the
    // captured_job_id half of the union — but the jobs list hides closed jobs by
    // default, so reaching it would mean driving the status filter and coupling
    // this spec to that control. The provenance path is covered instead by test
    // 1, whose note is captured on a DIFFERENT job from the one being read.
    await openTravelerFor(page, 'E2E-JS-NOTSTARTED');

    // The feed is collapsed on the traveler so the steps sit above the fold, so open it
    // first. MUI keeps collapsed children mounted-but-hidden, which means asserting on the
    // feed's contents without expanding would fail on visibility rather than on the query.
    await page.getByRole('button', { name: 'Notes & photos' }).click();

    await expect(page.getByText('Job Feed', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Could not load the feed.')).toHaveCount(0);
  });
});
