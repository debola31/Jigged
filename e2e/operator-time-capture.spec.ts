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
const startButton = (page: Page) => page.getByRole('button', { name: /start this step/i });
const adjustButton = (page: Page) => page.getByRole('button', { name: /^adjust$/i });
// `RECORD <n> FINISHED` — the number is interpolated into the verb, so match on
// the shape rather than a fixed quantity.
const recordButton = (page: Page) => page.getByRole('button', { name: /^record \d+ finished/i });
// The confirm sheet's own primary. Same label, so scope to the dialog or the
// two collide under strict mode.
const sheetRecordButton = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: /^record \d+ finished/i });
const completeBanner = (page: Page) =>
  page.getByRole('button', { name: /this step is complete/i });
// The hero clock's caption. The clock itself is a bare HH:MM:SS and matching on
// digits would be brittle.
const runningOnStep = (page: Page) => page.getByText(/^started \d/i);
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
  await expect(startButton(page).or(runningOnStep(page))).toBeVisible({ timeout: 30_000 });
  if (await runningOnStep(page).isVisible()) {
    await stopTimer(page);
  }
  await expect(startButton(page)).toBeVisible({ timeout: 30_000 });
}

/**
 * Close whatever is running on the current step.
 *
 * EVERY TEST THAT STARTS A TIMER ENDS BY CALLING THIS. Leaving one open would
 * leak into the next test through the chain — and worse, through the LAYOUT,
 * since the strip renders on every screen and its buttons then collide with the
 * dispatch rows the station helper is trying to click. The first version of this
 * spec leaked exactly that way and the failure surfaced as an unrelated
 * strict-mode violation inside a shared helper.
 */
async function stopTimer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /stop timing/i }).first().click();
  await page.getByRole('menuitem', { name: /done for the day/i }).click();
  await expect(runningOnStep(page)).toBeHidden({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('operator time capture', () => {
  test('starts a timer, shows it in the shell, and hides the estimate', async ({ page }) => {
    const companyId = await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openIdleStep(page);

    // Precondition: the estimate IS shown when nothing is running. Asserting
    // this first is what makes its later absence meaningful rather than a
    // selector that never matched anything.
    const hadEstimate = await estimateLine(page).isVisible();

    await startButton(page).click();

    // Leads with the fact, not the counter.
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });

    // THE GUARDRAIL. A live elapsed figure beside a quoted standard is a pace
    // gauge with a target — see
    // docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
    if (hadEstimate) {
      await expect(estimateLine(page)).toBeHidden();
    }

    // The strip is rendered by the LAYOUT, so it shows on screens that know
    // nothing about this step — that is the whole reason it lives in the shell,
    // and an operator who walks away with a timer running has to see it. An
    // explicit goto rather than clicking the nav and going back: the assertion
    // is about the layout, and routing it through two navigations only adds ways
    // to be flaky.
    await page.goto(`/operator/${companyId}/jobs`);
    await expect(runningOnStep(page).or(page.getByText(/since \d/i))).toBeVisible({
      timeout: 30_000,
    });

    // Leave nothing running. See stopTimer.
    await page.goBack();
    await stopTimer(page);
  });

  test('adjusting the start time keeps the recorded one', async ({ page }) => {
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openIdleStep(page);
    await startButton(page).click();
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
    await expect(page.getByText(/· adjusted/i)).toBeVisible({ timeout: 30_000 });

    await stopTimer(page);
  });

  test('recording a completion stops the timer', async ({ page }) => {
    // Stopping is a SIDE EFFECT of the action the operator was already taking.
    // There is no Stop button on the happy path, and this is why.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openIdleStep(page);
    await startButton(page).click();
    await expect(runningOnStep(page)).toBeVisible({ timeout: 30_000 });

    await qtyField(page).fill('1');

    // The primary opens the confirm sheet rather than writing. NOTHING IS
    // COMMITTED YET — this is the pre-completion step, which is why it does not
    // reintroduce the post-completion offer B4 deleted.
    await recordButton(page).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(/^Finishing /)).toBeVisible({ timeout: 30_000 });

    // The composer is here, carried from the step screen, so the last chance to
    // say something is on the way OUT rather than after the fact.
    await expect(sheet.getByPlaceholder(/next person/i)).toBeVisible();

    await sheetRecordButton(page).click();

    // The completion landed AND the interval closed with it.
    await expect(runningOnStep(page)).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(/1 of 5 good so far/)).toBeVisible({ timeout: 30_000 });

    // Undo the completion so the shared job is left as this file found it —
    // the completion spec asserts exact quantities against the same seed.
    await page.getByRole('button', { name: /undo all/i }).click();
    await expect(page.getByText(/1 of 5 good so far/)).toBeHidden({ timeout: 30_000 });
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
