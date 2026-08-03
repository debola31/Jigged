import { Page, expect } from '@playwright/test';

/**
 * Navigate to a module via the sidebar.
 * Sidebar items have their module name as primary text (e.g., "Quotes", "Parts").
 *
 * Scoped to the sidebar's `aria-label="Main navigation"` so it doesn't
 * clash with other nav landmarks on the page (e.g. MUI Breadcrumbs render
 * as `<nav>` and would otherwise produce a strict-mode violation when a
 * crumb has the same label as a sidebar item).
 */
export async function navigateTo(page: Page, moduleName: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByText(moduleName, { exact: true })
    .click();
  // Wait for navigation to settle
  await page.waitForLoadState('networkidle');
}

/**
 * Wait for AG Grid to finish loading rows.
 */
export async function waitForGridLoaded(page: Page) {
  // AG Grid removes the loading overlay once data is loaded
  await page.locator('.ag-root-wrapper').waitFor({ state: 'visible', timeout: 15_000 });
  // Wait until no loading overlay is visible
  await expect(page.locator('.ag-overlay-loading-center')).toBeHidden({ timeout: 15_000 });
}

/**
 * Put the operator on a station, if the station picker is showing.
 *
 * Tolerant of a station already being selected: the choice persists in
 * `localStorage`, so a second visit within one test renders the jobs list
 * instead of the picker.
 *
 * **Anchored on the picker's heading, not on the station's own button, and that
 * is the whole point.** The seed names the job operation after the work centre
 * (`global-setup.ts`: `operation_name: WC_INTERNAL_NAME`), the dispatch row
 * prints `Op: {operation_name}`, and both the picker card and the dispatch row
 * are `CardActionArea` buttons. Playwright matches accessible names by
 * substring, so `getByRole('button', { name: 'E2E Internal WC' })` matches BOTH
 * the moment a station is already selected — a strict-mode violation that
 * depends on test ordering, which is why it passed for months and then failed.
 * Same class of bug as `navigateTo` above, and the same fix: scope the query to
 * something only the intended surface has.
 *
 * The heading is safe to key on because the picker and the dispatch list are
 * mutually exclusive — the jobs page renders the picker only when no station is
 * selected, and hides the list and its toolbar while it does.
 */
export async function selectStationIfPickerShown(
  page: Page,
  stationName: string,
  settledMarker: ReturnType<Page['getByRole']>,
): Promise<void> {
  const pickerHeading = page.getByText('Select Your Station');
  // Wait for one of the two possible states before deciding: isVisible()
  // resolves immediately, so checking it straight after a goto reports "no
  // picker" on a page that has simply not rendered yet — and the station then
  // silently never gets selected.
  await expect(pickerHeading.or(settledMarker)).toBeVisible({ timeout: 30_000 });
  if (await pickerHeading.isVisible()) {
    // Unambiguous here: while the picker is up there are no dispatch rows to
    // collide with.
    await page.getByRole('button', { name: stationName }).click();
  }
}
