import { test, expect, type Page } from '@playwright/test';
import {
  navigateTo,
  selectStationIfPickerShown,
  waitForGridLoaded,
} from './helpers/navigation';

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
  await selectStationIfPickerShown(
    page,
    WC_INTERNAL,
    // Settled marker: the lens toggle only renders once a station is chosen.
    page.getByRole('button', { name: 'My Station' }),
  );

  await page.goto(`/operator/${companyId}/jobs/${jobId}`);
  await expect(page).toHaveURL(/\/parts\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

const qtyField = (page: Page) => page.getByLabel('Parts finished');
/**
 * The untimed completion path, and that choice is deliberate.
 *
 * `RECORD <n> FINISHED` now requires a running interval — starting is mandatory
 * on the shop floor, so the primary button is START until one is open. What THIS
 * file tests is completion mechanics: default quantity, partials,
 * over-completion, undo, and the note riding along. None of that is about time,
 * and routing it through the timer would make it fail for reasons that have
 * nothing to do with quantities. `Complete without timing` records exactly the
 * same completion event with no interval attached.
 *
 * The timed path is covered end to end in e2e/operator-time-capture.spec.ts.
 */
const recordButton = (page: Page) =>
  page.getByRole('button', { name: /complete without timing/i });
const undoButton = (page: Page) => page.getByRole('button', { name: /undo all/i });
const postNoteButton = (page: Page) => page.getByRole('button', { name: /^post$/i });
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
    // The floor is unchanged — no zero-quantity completion — but the shape of
    // "no" moved twice, and both revisions are worth recording because each one
    // broke this test for a different reason.
    //
    // It first asserted a DISABLED RECORD button. Then the label became SAVE
    // NOTE when the quantity emptied, so it asserted a disabled SAVE NOTE. Then
    // starting became mandatory and needs no quantity, so with the field cleared
    // there IS a real action available and the primary is START. The note arm is
    // gone entirely now — notes are the composer's job — and nothing is disabled.
    //
    // What has to stay true through all three is the only thing worth asserting:
    // NEITHER completion path is reachable with nothing to record.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    await qtyField(page).fill('0');

    await expect(page.getByRole('button', { name: /start this step/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^record \d+ finished/i })).toHaveCount(0);
    await expect(recordButton(page)).toHaveCount(0);
  });

  test('saves a note without touching the quantity, and without completing', async ({ page }) => {
    /**
     * THE REPORTED BUG, end to end.
     *
     * Capture briefly lived inside the completion block, submitted by the same
     * button that recorded production. The quantity field is PREFILLED with the
     * remaining balance, so that button read START and then RECORD n FINISHED —
     * and the SAVE NOTE arm it was supposed to fall back to only appeared once
     * the operator cleared the quantity by hand. Nobody found it. In practice a
     * note could not be saved without finishing the step.
     *
     * So this test deliberately LEAVES THE QUANTITY ALONE. The previous version
     * filled '0' first, and that fill was the whole defect wearing a passing
     * test — it is the one line that must not come back.
     */
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    const prefilled = await qtyField(page).inputValue();
    expect(Number(prefilled)).toBeGreaterThan(0);

    // Unique per run. A fixed string accumulates in the shared local database and
    // then matches several feed entries, and it also matches the textarea still
    // holding the draft — three hits and a strict-mode violation. CI starts from a
    // clean database so it would have hit only the two-element version of the
    // same bug.
    const body = `machine down, nothing run ${Date.now()}`;
    await page.getByPlaceholder(/for this step/i).fill(body);

    await postNoteButton(page).click();

    // Scoped to the FEED, not the whole page, so the draft field cannot satisfy it.
    await expect(
      page.locator('p').filter({ hasText: body }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The step is untouched: still outstanding, still offering the same quantity.
    await expect(qtyField(page)).toHaveValue(prefilled);
    await expect(completeBanner(page)).toHaveCount(0);
  });

  test('recording a completion writes no note, and says so if a draft is left staged', async ({
    page,
  }) => {
    // The other half of the split. Completion stopped sweeping up the composer,
    // which is what makes the note independent — but it is also how a staged
    // photo used to get silently discarded, so the composer says plainly that it
    // still holds something, instead of letting the operator walk away believing
    // it was saved.
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    await openStep(page);

    await expect(qtyField(page)).toBeVisible({ timeout: 30_000 });
    const body = `unposted draft ${Date.now()}`;
    await page.getByPlaceholder(/for this step/i).fill(body);

    await recordButton(page).click();

    await expect(page.getByText(/not posted yet/i)).toBeVisible({ timeout: 30_000 });
    // Still a draft, never written: no feed entry carries it.
    await expect(page.locator('p').filter({ hasText: body })).toHaveCount(0);
  });
});

/**
 * The find field on the dispatch list.
 *
 * Unit tests cover the matching and the empty state against mocked rows; what
 * only a browser can show is that the field narrows the list the READINESS RPC
 * actually returned, with a real station selected — the two things that decide
 * whether a row is on screen at all. A filter that worked over fixtures and
 * silently matched nothing against live data would pass every other gate.
 */
test.describe('finding one job on the dispatch list', () => {
  test('narrows the list to a match and back', async ({ page }) => {
    await openTravelerWithStation(page, 'E2E-JS-NOTSTARTED');
    const companyId = page.url().match(/\/operator\/([0-9a-f-]{36})\//)?.[1];
    expect(companyId, 'company id should be in the operator URL').toBeTruthy();

    // ALL STATIONS, and the target is read off the page rather than named here.
    // This spec runs serially after the completion tests, which finish steps on
    // the seeded job — so any fixture job number written into this file is a
    // claim about mutable state that the tests ahead of it are free to change.
    // The whole plant is the broadest list there is, and whatever sits at the
    // top of it is a row the readiness RPC really returned.
    await page.goto(`/operator/${companyId}/jobs?scope=plant`);
    await expect(page.getByRole('button', { name: 'All Stations' })).toBeVisible({
      timeout: 30_000,
    });

    // Each job card is a CardActionArea, so it is a button; the station group
    // headings are plain text. Filtering buttons by the card's "{job} · {part}"
    // separator therefore picks out a job row and never a heading or a control.
    const cards = page.getByRole('button').filter({ hasText: '·' });
    const firstCard = cards.first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    const jobNumber = ((await firstCard.textContent()) ?? '').split('·')[0].trim();
    expect(jobNumber, 'a card heading should start with a job number').toBeTruthy();

    const find = page.getByLabel('Find a job');

    // A query that matches keeps its row — asserted against live data, which is
    // the half a unit test over fixtures cannot cover.
    await find.fill(jobNumber);
    // Visible, not a count of one: a job with its operation ready at more than
    // one station legitimately shows a row per station on this lens.
    await expect(cards.filter({ hasText: jobNumber }).first()).toBeVisible();

    // A query that matches nothing empties the list and SAYS SO. This is the
    // assertion that matters: the failure mode is the unfiltered copy, which
    // claims there is no work for your station when the only fact available is
    // about the query.
    await find.fill('zzz-no-such-job-zzz');
    await expect(page.getByText(/No jobs match/)).toBeVisible();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText(/There is no ready or in-progress work/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Show all jobs' }).click();
    await expect(find).toHaveValue('');
    await expect(firstCard).toBeVisible();
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

    // Complete with the composer left empty — which must be allowed, and is now
    // structural rather than permitted: this button cannot write a note at all.
    const noteField = page.getByPlaceholder(/for this step/i);
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
