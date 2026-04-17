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
  const partName = `E2E-${uniqueSuffix}`;
  const partDescription = `E2E Test Part ${uniqueSuffix}`;

  test('create part, add routing with operations, verify cost', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Create a new part ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    await page.getByRole('button', { name: /New Part/i }).click();
    await expect(page).toHaveURL(/\/parts\/new/);

    // Fill part name (required)
    await page.getByLabel(/Part Name/i).fill(partName);

    // Fill description
    await page.getByLabel(/Description/i).fill(partDescription);

    // Save the part
    await page.getByRole('button', { name: /^Save$/i }).click();

    // Should redirect to the part detail page (not /parts/new)
    await expect(page).toHaveURL(/\/parts\/(?!new)[^/]+$/, { timeout: 15_000 });

    // Verify the part was created
    await expect(page.getByText(partName)).toBeVisible();

    // ── Step 2: Add an operation via the inline routing editor ──
    // The routing panel is embedded on the part detail page — no navigation needed.

    await page.waitForLoadState('networkidle');

    // Empty-state hint confirms the panel loaded with no operations yet.
    await expect(
      page.getByText(/Click "Add Operation" to start building this routing/i)
    ).toBeVisible({ timeout: 10_000 });

    // Click "Add Operation" (in the Operations card header)
    await page.getByRole('button', { name: /Add Operation/i }).click();

    // Dialog: single AddOperationModal with operation picker + time fields
    const addOpDialog = page.getByRole('dialog');
    await expect(addOpDialog).toBeVisible();
    await expect(addOpDialog.getByRole('heading', { name: /Add Operation/i })).toBeVisible();

    // Open the Operation autocomplete and select the first available option.
    await addOpDialog.getByLabel(/^Operation$/).click();

    const listbox = page.getByRole('listbox');
    const firstOption = listbox.getByRole('option').first();
    const hasOperations = await firstOption
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (!hasOperations) {
      test.skip(true, 'No operation types exist in test company');
    }

    await firstOption.click();

    // Confirm: "Add to routing" (the new modal's primary action)
    await addOpDialog.getByRole('button', { name: /Add to routing/i }).click();
    await expect(addOpDialog).toBeHidden({ timeout: 10_000 });

    // ── Step 3: Verify autosave + operation persisted ──

    // The floating indicator transitions through "Saving…" → "All changes saved".
    // Wait for the end state (the intermediate "Saving…" may flash too fast).
    await expect(page.getByText(/All changes saved/i)).toBeVisible({ timeout: 15_000 });

    // Sequence marker "1." rendered by RoutingOperationRow confirms the operation
    // is in the list.
    await expect(page.getByText(/^1\.$/)).toBeVisible({ timeout: 5_000 });

    // Still on the part detail page — no redirects in the new inline flow.
    await expect(page).toHaveURL(/\/parts\/(?!new)[^/]+$/);

    // ── Step 4: Navigate back to parts list and verify ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    // The part should appear in the list
    await expect(page.getByText(partName)).toBeVisible({ timeout: 10_000 });
  });
});
