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
const composer = (page: Page) => page.getByPlaceholder(/what did you do/i);
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

  test('a noticed item opens, and logging the fix closes it without deleting anything', async ({
    page,
  }) => {
    const companyId = await operatorHome(page);
    await selectStationAndOpenLog(page, companyId);

    const observation = `E2E way cover drags ${stamp()}`;
    await composer(page).fill(observation);
    await page.getByRole('button', { name: 'noticed' }).click();
    await addButton(page).click();

    // Pinned in the open list AND present on the timeline: two occurrences of one
    // row, which is the shape the whole design turns on.
    await expect(page.getByText(observation)).toHaveCount(2, { timeout: 30_000 });

    await page.getByRole('button', { name: /log the fix/i }).first().click();
    const fix = `E2E replaced the wiper ${stamp()}`;
    await composer(page).fill(fix);
    await addButton(page).click();

    await expect(page.getByText(fix)).toBeVisible({ timeout: 30_000 });

    // Down to one occurrence: it left the OPEN list but stayed in the log. A log
    // that loses rows stops being a log.
    await expect(page.getByText(observation)).toHaveCount(1, { timeout: 30_000 });

    // And it is still closed after a reload — proving the state came from the
    // resolving row rather than from anything held in the page.
    await page.reload();
    await expect(page.getByText(observation)).toHaveCount(1, { timeout: 30_000 });
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
    await page.getByRole('button', { name: 'noticed' }).click();
    await addButton(page).click();
    await expect(page.getByText(observation)).toHaveCount(2, { timeout: 30_000 });

    await expect(openList(page).getByText(observation)).toBeVisible();
    // The author's name is on the entry card below, one tap away — not here.
    await expect(openList(page).getByText('E2E Test User')).toHaveCount(0);
  });
});
