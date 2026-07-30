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
  //
  // Tolerant of a station already being selected: the choice persists, so on a
  // second visit within one test the picker is simply not rendered and the jobs
  // list shows instead. Requiring it unconditionally made the helper usable only
  // once per test.
  await page.goto(`/operator/${companyId}/jobs`);
  const picker = page.getByRole('button', { name: WC_INTERNAL });
  // Wait for one of the two possible states before deciding, for the same reason
  // as openStep below: isVisible() resolves immediately, so checking it straight
  // after a goto reports "no picker" on a page that simply has not rendered yet —
  // and the station silently never gets selected.
  await expect(picker.or(page.getByRole('button', { name: 'My Station' }))).toBeVisible({
    timeout: 30_000,
  });
  if (await picker.isVisible()) {
    await picker.click();
  }

  await page.goto(`/operator/${companyId}/jobs/${jobId}`);
  await expect(page).toHaveURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

const qtyField = (page: Page) => page.getByLabel('Parts finished');
const recordButton = (page: Page) => page.getByRole('button', { name: /record completion/i });
const undoButton = (page: Page) => page.getByRole('button', { name: /undo all/i });
const saveNoteButton = (page: Page) => page.getByRole('button', { name: /save note/i });
const completeBanner = (page: Page) =>
  page.getByRole('button', { name: /this step is complete/i });

/**
 * Open the seeded step from the traveler, and leave it ACTIONABLE.
 *
 * Self-healing on purpose. These tests share one job's completions, so a run that
 * dies mid-test leaves the step complete and every later run fails on a missing
 * quantity field for a reason that has nothing to do with the code. CI always
 * starts from a clean database; a developer's machine does not.
 */
async function openStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(WC_INTERNAL) }).first().click();
  await expect(page).toHaveURL(/\/operations\/[0-9a-f-]{36}/, { timeout: 30_000 });

  // Wait for EITHER state before deciding. isVisible() resolves immediately, so
  // on a freshly navigated page neither element exists yet, the heal was skipped,
  // and we then waited 30s for a field that was never going to appear.
  await expect(qtyField(page).or(completeBanner(page))).toBeVisible({ timeout: 30_000 });
  if (await completeBanner(page).isVisible()) {
    await completeBanner(page).click();
  }
  await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
}

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
    // The floor is unchanged: no zero-quantity completion. What changed is the
    // button's LABEL when the quantity is empty — with nothing to record there is
    // no completion to offer, so it presents as SAVE NOTE and is disabled until
    // something is typed. Asserting the old label here is what made this spec
    // fail in CI while the component test (already updated) passed.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    await qtyField(page).fill('0');

    await expect(recordButton(page)).toHaveCount(0);
    await expect(saveNoteButton(page)).toBeDisabled();
  });

  test('saves a note alone when nothing was finished', async ({ page }) => {
    // The hole B4 opened: capture rode on a button requiring qty > 0, so an
    // operator who finished ZERO pieces had to stay silent or type a false
    // quantity to get the note saved. Corrupting production data to satisfy a UI
    // constraint is far worse than an extra path.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    await qtyField(page).fill('0');

    // Unique per run. A fixed string accumulates in the shared local database and
    // then matches several feed entries, and it also matches the textarea still
    // holding the draft — three hits and a strict-mode violation. CI starts from a
    // clean database so it would have hit only the two-element version of the
    // same bug.
    const body = `machine down, nothing run ${Date.now()}`;
    await page.getByPlaceholder(/worth noting/i).fill(body);

    await saveNoteButton(page).click();

    // Scoped to the FEED, not the whole page, so the draft field cannot satisfy it.
    await expect(
      page.locator('p').filter({ hasText: body }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // And the step is still outstanding — no completion was invented to carry it.
    await expect(qtyField(page)).toBeVisible();
    await expect(completeBanner(page)).toHaveCount(0);
  });
});

/**
 * B5 — TRIANGULARITY.
 *
 * The asymmetry that makes writing something down worth the extra taps:
 *
 *   completion alone      → the step turns green. Nothing else.
 *   completion + a note   → your name on a Playbook entry, a view count that
 *                           grows, named readers, a login-banner line.
 *
 * If completing were rewarded on its own, the note would be pure cost and nobody
 * would write one. So "nothing comes back from a bare completion" is a FEATURE
 * with a test, not an omission — and My work is where the pressure to break it
 * will come from, because a contribution screen is exactly where a completion
 * count wants to appear.
 */
test.describe('completion alone earns nothing back', () => {
  /** Notes listed on My work; 0 when the empty state is showing. */
  async function myWorkNoteCount(page: Page, companyId: string): Promise<number> {
    await page.goto(`/operator/${companyId}/my-work`);
    await expect(
      page.getByRole('listitem').first().or(page.getByText('Nothing written yet')),
    ).toBeVisible({ timeout: 30_000 });
    return page.getByRole('listitem').count();
  }

  test('a bare completion adds no note and no My work row', async ({ page }) => {
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    const companyId = page.url().match(/\/operator\/([0-9a-f-]{36})\//)?.[1];
    expect(companyId).toBeTruthy();

    // The seed gives this user a durable note already, so the assertion is that
    // completing changes NOTHING — not that the page starts empty.
    const before = await myWorkNoteCount(page, companyId!);

    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    // Complete with the capture field left empty — which must be allowed.
    const noteField = page.getByPlaceholder(/worth noting/i);
    await expect(noteField).toBeVisible();
    await expect(noteField).toHaveValue('');
    await recordButton(page).click();
    await expect(completeBanner(page)).toBeVisible({ timeout: 30_000 });

    // Nothing captured, so nothing new came back.
    expect(await myWorkNoteCount(page, companyId!), 'a bare completion must add no row').toBe(
      before,
    );

    // And the line that must never be crossed: no completion count, streak or
    // average anywhere on the contribution screen.
    const body = (await page.textContent('body')) ?? '';
    for (const forbidden of [/completed/i, /completion/i, /streak/i, /average/i, /\bpace\b/i]) {
      expect(body, `My work must not surface ${forbidden}`).not.toMatch(forbidden);
    }

    // Leave the step as we found it. openStep already undoes a complete step, so
    // this is just a return trip.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);
  });
});
