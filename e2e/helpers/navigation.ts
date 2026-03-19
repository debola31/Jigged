import { Page, expect } from '@playwright/test';

/**
 * Navigate to a module via the sidebar.
 * Sidebar items have their module name as primary text (e.g., "Quotes", "Parts").
 */
export async function navigateTo(page: Page, moduleName: string) {
  await page.getByRole('navigation').getByText(moduleName, { exact: true }).click();
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
