import { test, expect, type Page } from '@playwright/test';

/**
 * The machine logbook, end to end.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE CAN. The module's whole design rests on one
 * claim: open state is DERIVED, never stored. Unit tests prove the derivation
 * function is correct given an array; only this spec proves the array that
 * reaches it is the one the database actually returns, through the real insert,
 * the real trigger and the real RLS. A stored flag would be provable in a unit
 * test; this design has to be shown working against Postgres.
 *
 * It writes its own entries rather than reading seeded ones, deliberately. The
 * capture path is what the module is a bet on, and a spec that only read a
 * fixture would go green while capture was broken.
 *
 * It also pins the tab's own gate: the Maintenance tab appears only once a
 * station is selected, because a station IS a machine and there is no picker.
 */

const WC_INTERNAL = 'E2E Internal WC';

/** Unique per run: these entries accumulate in a shared local database. */
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

async function operatorHome(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();
  return companyId as string;
}

const maintenanceTab = (page: Page) => page.getByRole('button', { name: /^Maintenance$/ });
// Anchored: the reply composer's placeholder ('What did you do to fix it?')
// also starts with 'what did you do', so an unanchored regex matches both.
const composer = (page: Page) => page.getByPlaceholder(/what did you do, or what did you notice/i);
const replyComposer = (page: Page) => page.getByPlaceholder(/what did you do to fix it/i);
const addButton = (page: Page) => page.getByRole('button', { name: /add to log/i });
const openList = (page: Page) => page.getByTestId('machine-open-items');

/**
 * Select a station, then open its logbook.
 *
 * Every test does this rather than one doing it once: the station lives in
 * localStorage, and Playwright gives each test its own browser context, so a
 * selection made in an earlier test is simply not there. Skipping it would land
 * on the station picker and fail on a missing composer for a reason that has
 * nothing to do with the code.
 */
async function selectStationAndOpenLog(page: Page, companyId: string): Promise<void> {
  await page.goto(`/operator/${companyId}/jobs`);

  const picker = page.getByRole('button', { name: WC_INTERNAL });
  await expect(picker.or(maintenanceTab(page))).toBeVisible({ timeout: 30_000 });
  if (await picker.isVisible()) await picker.click();

  await expect(maintenanceTab(page)).toBeVisible({ timeout: 30_000 });
  await maintenanceTab(page).click();
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Machine Maintenance', () => {
  test('the Maintenance tab appears only once a station is selected', async ({ page }) => {
    const companyId = await operatorHome(page);
    await page.goto(`/operator/${companyId}/jobs`);

    // Wait for one of the two states before asserting — a not-yet-rendered page
    // reports "no tab" for the wrong reason.
    const picker = page.getByRole('button', { name: WC_INTERNAL });
    await expect(picker.or(maintenanceTab(page))).toBeVisible({ timeout: 30_000 });

    if (await picker.isVisible()) {
      // No station yet: the tab must not be offered. There is no machine to have
      // a logbook for.
      await expect(maintenanceTab(page)).toHaveCount(0);
      await picker.click();
    }

    await expect(maintenanceTab(page)).toBeVisible({ timeout: 30_000 });
  });

  test('an entry written on the floor lands on the machine timeline', async ({ page }) => {
    const companyId = await operatorHome(page);
    await selectStationAndOpenLog(page, companyId);

    const body = `E2E way lube topped up ${stamp()}`;
    await composer(page).fill(body);
    await addButton(page).click();

    await expect(page.getByText(body)).toBeVisible({ timeout: 30_000 });

    // It survives a reload, i.e. it was written rather than only rendered.
    await page.reload();
    await expect(page.getByText(body)).toBeVisible({ timeout: 30_000 });
  });

  test('a flagged item pins once, and logging the fix moves it into the log', async ({
    page,
  }) => {
    const companyId = await operatorHome(page);
    await selectStationAndOpenLog(page, companyId);

    const observation = `E2E way cover drags ${stamp()}`;
    await composer(page).fill(observation);
    await page.getByRole('checkbox', { name: /needs attention/i }).click();
    await addButton(page).click();

    // Exactly once, and pinned: an entry never renders twice. While it is
    // outstanding it lives in the pinned block and nowhere else.
    //
    // `exact` matters from here on: getByText matches substrings, and every
    // entry this spec writes shares the `E2E ` prefix, so a loose locator would
    // count a neighbouring run's entry as a second copy of this one and the
    // one-appearance invariant would stop being what this asserts.
    await expect(page.getByText(observation, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(openList(page).getByText(observation)).toBeVisible({ timeout: 30_000 });

    // The reply opens INLINE, under the item it answers — no banner, no mode on
    // the composer at the top.
    //
    // Scoped to THIS test's item, not `.first()`. Notes are append-only and the
    // local stack is shared across runs, so any earlier run that died between
    // flagging and fixing leaves its open item behind — and every open item
    // carries a button with this name. CI always starts clean, so `.first()`
    // went green there while failing locally on a strict-mode violation.
    const myItem = openList(page)
      .getByTestId('machine-open-item')
      .filter({ hasText: observation });
    await myItem.getByRole('button', { name: /log the fix/i }).click();

    const fix = `E2E replaced the wiper ${stamp()}`;
    await replyComposer(page).fill(fix);
    // Within the item, only the reply's submit is left: opening the reply hides
    // that item's own opener, which is exactly the ambiguity this asserts away.
    await myItem.getByRole('button', { name: /^log the fix$/i }).click();

    await expect(page.getByText(fix)).toBeVisible({ timeout: 30_000 });

    // It MOVED rather than vanished: gone from the pinned block, still on the
    // page. A log that loses rows stops being a log.
    await expect(openList(page).getByText(observation)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(observation, { exact: true })).toHaveCount(1, { timeout: 30_000 });

    // The fix reads as a REPLY: below what it answers, and indented from it.
    // Asserted geometrically because that is exactly the claim — a reader
    // recognises a reply by where it sits, not by any text it contains.
    const fixEl = page.getByText(fix, { exact: true });
    await expect(fixEl).toBeVisible({ timeout: 30_000 });

    const rootBox = await page.getByText(observation, { exact: true }).boundingBox();
    const replyBox = await fixEl.boundingBox();
    expect(rootBox, 'the resolved observation should still be on the page').not.toBeNull();
    expect(replyBox, 'the fix should be on the page').not.toBeNull();
    expect(replyBox!.y).toBeGreaterThan(rootBox!.y);
    expect(replyBox!.x).toBeGreaterThan(rootBox!.x);

    // And it stays moved after a reload — proving the state came from the
    // resolving row rather than from anything held in the page.
    await page.reload();
    await expect(openList(page).getByText(observation)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(observation, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(fix)).toBeVisible({ timeout: 30_000 });
  });

  test('the open list names the observation and the date, never who filed it', async ({ page }) => {
    // The surveillance guardrail, checked in a browser rather than only in jsdom.
    // A list of open items with names down the side is a list of who reports the
    // most problems.
    const companyId = await operatorHome(page);
    await selectStationAndOpenLog(page, companyId);

    const observation = `E2E coolant smells off ${stamp()}`;
    await composer(page).fill(observation);
    await page.getByRole('checkbox', { name: /needs attention/i }).click();
    await addButton(page).click();
    await expect(openList(page).getByText(observation)).toBeVisible({ timeout: 30_000 });
    // The author's name is on the entry card below, one tap away — not here.
    await expect(openList(page).getByText('E2E Test User')).toHaveCount(0);
  });
});
