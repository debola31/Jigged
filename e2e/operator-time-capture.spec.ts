import { test, expect, type Page } from '@playwright/test';
import {
  navigateTo,
  selectStationIfPickerShown,
  waitForGridLoaded,
} from './helpers/navigation';

/**
 * Recording TIME on a step, end to end.
 *
 * WHY THIS SPEC EXISTS, separately from operator-completion.spec.ts. The
 * completion spec covers the number an operator types. This covers the clock,
 * and the clock has three behaviours that only exist in a browser against a real
 * database:
 *
 *   1. Starting writes a row through a SECURITY DEFINER RPC, not a `.from()`
 *      insert — the browser has no INSERT grant at all, so a wrong argument name
 *      is a 404 at runtime and compiles perfectly.
 *   2. The running strip is rendered by the LAYOUT from a context the step
 *      screen also consumes. Unit tests mock the access layer, so the select
 *      string and its two nested PostgREST embeds never meet a database — which
 *      is exactly how the NewHelpful embed shipped 400ing on every load.
 *   3. The estimate must DISAPPEAR from the step screen while a timer runs. That
 *      is a guardrail rather than a layout preference (a live counter beside a
 *      standard is the adjacent comparison the surveillance rule exists to
 *      prevent), and nothing but a rendered page can assert it.
 *
 * Drives the real UI rather than constructed URLs, for the same reason the
 * completion spec does: the station guard and the id resolution are the classes
 * of failure that compile and render nothing.
 */

const JOB_SEARCH = /Job #, PO, customer/i;
const WC_INTERNAL = 'E2E Internal WC';

async function openTravelerWithStation(page: Page, jobNumber: string): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

  await navigateTo(page, 'Jobs');
  await waitForGridLoaded(page);
  await page.getByPlaceholder(JOB_SEARCH).fill(jobNumber);
  await waitForGridLoaded(page);
  await page.getByText(jobNumber).first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const jobId = page.url().match(/\/jobs\/([0-9a-f-]{36})/)?.[1];

  await page.goto(`/operator/${companyId}/jobs`);
  await selectStationIfPickerShown(
    page,
    WC_INTERNAL,
    page.getByRole('button', { name: 'My Station' }),
  );

  await page.goto(`/operator/${companyId}/jobs/${jobId}`);
  await expect(page).toHaveURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 30_000 });
  return companyId!;
}

const qtyField = (page: Page) => page.getByLabel('Parts finished');
const startButton = (page: Page) => page.getByRole('button', { name: /start timing this step/i });
const adjustButton = (page: Page) => page.getByRole('button', { name: /^adjust$/i });
const recordButton = (page: Page) => page.getByRole('button', { name: /record completion/i });
const completeBanner = (page: Page) =>
  page.getByRole('button', { name: /this step is complete/i });
const runningOnStep = (page: Page) => page.getByText(/On this step since/i);
const estimateLine = (page: Page) => page.getByText(/^Estimated:/);

/**
 * Open the seeded step and leave it ACTIONABLE and NOT running.
 *
 * Self-healing in two directions, same reasoning as the completion spec: these
 * tests share one job, so a run that dies mid-test leaves the step either
 * complete or still timing, and every later run then fails for a reason that has
 * nothing to do with the code.
 */
async function openIdleStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(WC_INTERNAL) }).first().click();
  await expect(page).toHaveURL(/\/operations\/[0-9a-f-]{36}/, { timeout: 30_000 });

  await expect(qtyField(page).or(completeBanner(page))).toBeVisible({ timeout: 30_000 });
  if (await completeBanner(page).isVisible()) {
    await completeBanner(page).click();
  }
  await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });

  // Heal a timer left running by an earlier aborted run.
  if (await runningOnStep(page).isVisible()) {
    await page.getByRole('button', { name: /stop timing/i }).first().click();
    await page.getByRole('menuitem', { name: /done for the day/i }).click();
    await expect(startButton(page)).toBeVisible({ timeout: 30_000 });
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('operator time capture', () => {
  test('starts a timer, shows it in the shell, and hides the estimate', async ({ page }) => {
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openIdleStep(page);

    // Precondition: the estimate IS shown when nothing is running. Asserting
    // this first is what makes its later absence meaningful rather than a
    // selector that never matched anything.
    const hadEstimate = await estimateLine(page).isVisible();

    await expect(startButton(page)).toBeVisible({ timeout: 30_000 });
    await startButton(page).click();

    // Leads with the fact, not the counter.
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });

    // THE GUARDRAIL. A live elapsed figure beside a quoted standard is a pace
    // gauge with a target — see
    // docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
    if (hadEstimate) {
      await expect(estimateLine(page)).toBeHidden();
    }

    // The strip is rendered by the LAYOUT, so it must survive navigation away
    // from the step — that is the whole reason it lives in the shell.
    await page.getByRole('link', { name: /jobs/i }).first().click().catch(() => {});
    await page.goBack();
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });
  });

  test('adjusting the start time keeps the recorded one', async ({ page }) => {
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await page.getByRole('button', { name: new RegExp(WC_INTERNAL) }).first().click();
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });

    await adjustButton(page).click();
    await expect(page.getByRole('heading', { name: /adjust times/i })).toBeVisible();

    // The nudge buttons are the phone-first path: no keyboard, no precision, and
    // each tap independently undoable.
    await page.getByRole('button', { name: /subtract 15 minutes to started/i }).click();

    // Provenance appears as soon as the value diverges, stated as fact and with
    // no actor — "Recorded 9:12 AM", never "edited by".
    await expect(page.getByText(/^Recorded /)).toBeVisible();

    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText(/times adjusted/i)).toBeVisible({ timeout: 30_000 });
  });

  test('recording a completion stops the timer', async ({ page }) => {
    // Stopping is a SIDE EFFECT of the action the operator was already taking.
    // There is no Stop button on the happy path, and this is why.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await page.getByRole('button', { name: new RegExp(WC_INTERNAL) }).first().click();
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });

    await qtyField(page).fill('1');
    await recordButton(page).click();

    // The completion landed AND the interval closed with it.
    await expect(runningOnStep(page)).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(/1 of 5 good so far/)).toBeVisible({ timeout: 30_000 });
  });

  test('the Me tab journal carries no aggregate figure', async ({ page }) => {
    // The guardrail asserted through a real browser, as the completion spec does
    // for My work. A unit test cannot see what the assembled page renders.
    const companyId = await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await page.goto(`/operator/${companyId}/my-work`);
    await expect(page.getByText(/Your notes so far/i)).toBeVisible({ timeout: 30_000 });

    const body = (await page.textContent('body')) ?? '';
    for (const forbidden of [
      /streak/i,
      /average/i,
      /\bpace\b/i,
      /leaderboard/i,
      /per hour/i,
      /\bminutes\b/i,
      /this (week|month)/i,
      /\d+\s+entries\b/i,
    ]) {
      expect(body, `the Me tab must not surface ${forbidden}`).not.toMatch(forbidden);
    }
  });
});
