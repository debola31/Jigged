import { test, expect, type Page } from '@playwright/test';
import { navigateTo, waitForGridLoaded } from './helpers/navigation';

/**
 * Recording a completion, end to end.
 *
 * WHY THIS SPEC EXISTS. Completion is the one action an operator must never
 * lose, and until now it had unit tests on the access layer and nothing above
 * it: no component test on the page that owns handleRecord/handleRevert, and no
 * E2E at all. The whole suite went green with the station guard, the quantity
 * default, the write and the undo unexercised in a browser.
 *
 * It is written BEFORE B4 merges capture into completion, deliberately. Tests
 * authored alongside a rewrite describe the new code, which is exactly what a
 * rewrite must not be judged by. Whatever B4 changes about the screen, this flow
 * — pick a station, open a step, record a quantity, see it counted, undo it —
 * has to keep working, and if the assertions here need editing then B4 changed
 * operator-visible behaviour and that should be a decision rather than a
 * surprise.
 *
 * It drives the real UI rather than constructed URLs so that the station guard,
 * the id resolution and the partial-completion summary are all covered — the
 * classes of failure that compile perfectly and render nothing.
 */

const JOB_SEARCH = /Job #, PO, customer/i;
const WC_INTERNAL = 'E2E Internal WC';

/** Reach a job's operator traveler, with a station selected. */
async function openTravelerWithStation(page: Page, jobNumber: string): Promise<void> {
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

  // The station picker gates the completion action, so go through it rather than
  // around it — a spec that skipped it would not cover the guard that decides
  // whether an operator can record anything at all.
  await page.goto(`/operator/${companyId}/jobs`);
  const picker = page.getByRole('button', { name: WC_INTERNAL });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.click();

  await page.goto(`/operator/${companyId}/jobs/${jobId}`);
  await expect(page).toHaveURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

/** Open the seeded step from the traveler. */
async function openStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(WC_INTERNAL) }).first().click();
  await expect(page).toHaveURL(/\/operations\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

const qtyField = (page: Page) => page.getByLabel('Good pieces finished');
const recordButton = (page: Page) => page.getByRole('button', { name: /record completion/i });
const undoButton = (page: Page) => page.getByRole('button', { name: /undo all/i });
const completeBanner = (page: Page) =>
  page.getByRole('button', { name: /this step is complete/i });

// These tests all drive the SAME job's completions, so they are order-dependent
// by nature — run in parallel they race on shared mutable state and fail at
// random. CI already uses one worker; this only constrains local runs.
test.describe.configure({ mode: 'serial' });

test.describe('operator completion', () => {
  test('records a partial, counts it, and undoes it', async ({ page }) => {
    // E2E-JS-NOTSTARTED is the open job, so its step is actionable, and it is
    // seeded with quantity 5 — with a quantity of 1 the whole balance IS the
    // order and a partial cannot be expressed.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    // The field states its own outcome: it arrives holding the remaining
    // balance, so RECORD COMPLETION finishes the step by default.
    const field = qtyField(page);
    await expect(field).toBeVisible({ timeout: 30_000 });
    const remaining = Number(await field.inputValue());
    expect(remaining, 'the field should default to the remaining balance').toBeGreaterThan(1);

    // Dial it down: a partial is the same gesture with a smaller number, not a
    // separate mode.
    await field.fill('2');
    await recordButton(page).click();

    // This line only renders once something is banked, so its presence IS the
    // assertion that the write landed AND was read back through the summary.
    await expect(page.getByText(/2 of 5 good so far/)).toBeVisible({ timeout: 30_000 });
    // Still actionable, because a partial leaves the rest outstanding.
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('3');

    // Undo is offered only against recorded work, and voids all of it.
    await undoButton(page).click();

    await expect(page.getByText(/good so far/)).toHaveCount(0, { timeout: 30_000 });
    await expect(undoButton(page)).toHaveCount(0);
    // Back to offering the full balance, which is what makes a second attempt
    // safe rather than a double-count.
    await expect(qtyField(page)).toHaveValue(String(remaining));
  });

  test('completing the balance closes the step, and undo reopens it', async ({ page }) => {
    // The default path: leave the number alone and tap once. The screen then
    // swaps the action for a completed state, which is a different branch of the
    // page and was the half this spec originally missed.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);
    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });

    await recordButton(page).click();

    await expect(completeBanner(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/5 of 5 good/)).toBeVisible();
    // No way to record again while complete — the field is gone, not merely
    // disabled, so a second tap cannot double-count.
    await expect(qtyField(page)).toHaveCount(0);

    // A completed step stays reversible: the banner itself is the undo.
    await completeBanner(page).click();

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    await expect(qtyField(page)).toHaveValue('5');
  });

  test('will not record nothing', async ({ page }) => {
    // The only floor is > 0. Without it an empty tap would append a zero-quantity
    // completion event and the step would read as worked-on when it was not.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    await qtyField(page).fill('0');

    await expect(recordButton(page)).toBeDisabled();
  });
});
