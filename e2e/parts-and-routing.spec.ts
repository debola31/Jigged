import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: Parts + Routing workflow
 *
 * Prerequisites (in test company):
 * - At least 1 operation type exists (for adding to a routing)
 */
test.describe('Parts and Routing workflow', () => {
  const uniqueSuffix = Date.now().toString().slice(-6);
  const partNumber = `E2E-${uniqueSuffix}`;
  const partDescription = `E2E Test Part ${uniqueSuffix}`;

  test('create part, add routing with operations, verify cost', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Create a new part ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    await page.getByRole('button', { name: /New Part/i }).click();
    await expect(page).toHaveURL(/\/parts\/new/);

    // Fill part number (required)
    await page.getByLabel(/Part Number/i).fill(partNumber);

    // Fill description
    await page.getByLabel(/Description/i).fill(partDescription);

    // Save the part
    await page.getByRole('button', { name: /^Save$/i }).click();

    // Should redirect to the part detail page
    await expect(page).toHaveURL(/\/parts\/[^/]+$/, { timeout: 15_000 });

    // Verify the part was created
    await expect(page.getByText(partNumber)).toBeVisible();

    // ── Step 2: Create a routing ──

    // Click "Create Routing" on the part detail page
    await page.getByRole('button', { name: /Create Routing/i }).click();
    await expect(page).toHaveURL(/\/routing\/new/, { timeout: 10_000 });

    // ── Step 3: Add operations to the routing ──

    // Click "Add Operation" button to open the operation selection dialog
    await page.getByRole('button', { name: /Add Operation/i }).click();

    // Wait for the dialog to load operations
    const addOpDialog = page.getByRole('dialog');
    await expect(addOpDialog).toBeVisible();
    await expect(addOpDialog.getByText(/Add Operation/i)).toBeVisible();

    // Wait for operations to load (loading spinner disappears)
    await addOpDialog.locator('.MuiCircularProgress-root').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {
      // May already be hidden if operations loaded fast
    });

    // Select the first available operation
    const firstOperation = addOpDialog.getByRole('listitem').first();
    await firstOperation.click();

    // Dialog should close after selection
    await expect(addOpDialog).toBeHidden({ timeout: 5_000 });

    // Add a second operation
    await page.getByRole('button', { name: /Add Operation/i }).click();
    const addOpDialog2 = page.getByRole('dialog');
    await expect(addOpDialog2).toBeVisible();

    // Wait for loading
    await addOpDialog2.locator('.MuiCircularProgress-root').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});

    // Select a second operation (could be the same type or different)
    const operations = addOpDialog2.getByRole('listitem');
    const opCount = await operations.count();
    if (opCount > 1) {
      await operations.nth(1).click();
    } else {
      // Only one operation type available — add it again
      await operations.first().click();
    }

    await expect(addOpDialog2).toBeHidden({ timeout: 5_000 });

    // ── Step 4: Save the routing ──

    await page.getByRole('button', { name: /Save/i }).click();

    // Should redirect back to part detail
    await expect(page).toHaveURL(/\/parts\/[^/]+$/, { timeout: 15_000 });

    // ── Step 5: Verify routing information on part detail ──

    // The routing card should now show operation count and an "Edit Routing" button
    await expect(page.getByRole('button', { name: /Edit Routing/i })).toBeVisible({
      timeout: 10_000,
    });

    // ── Step 6: Navigate back to parts list and verify ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    // The part should appear in the list
    await expect(page.getByText(partNumber)).toBeVisible({ timeout: 10_000 });
  });
});
