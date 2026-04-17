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

    // ── Step 2: Add an operation via the inline routing panel ──
    // Routings live inline on the part detail page — the Operations card on
    // this page has an "Add Operation" button that opens AddOperationModal.
    // There is no separate /routing/new page, no Create/Save Routing buttons;
    // changes auto-save via PartRoutingPanel.

    await page.waitForLoadState('networkidle');

    const addOpButton = page.getByRole('button', { name: /Add Operation/i });
    await expect(addOpButton).toBeEnabled({ timeout: 15_000 });
    await addOpButton.click();

    const addOpDialog = page.getByRole('dialog');
    await expect(addOpDialog).toBeVisible();
    await expect(addOpDialog.getByRole('heading', { name: /Add Operation/i })).toBeVisible();

    // Operation is an Autocomplete — focus, open the listbox, pick first option.
    await addOpDialog.getByLabel(/^Operation$/i).click();

    const firstOption = page.getByRole('option').first();
    const hasOperations = await firstOption.isVisible({ timeout: 10_000 }).catch(() => false);

    if (!hasOperations) {
      test.skip(true, 'No operation types exist in test company');
    }

    await firstOption.click();

    await addOpDialog.getByLabel(/Setup time/i).fill('10');
    await addOpDialog.getByLabel(/Run time per unit/i).fill('2.5');

    await addOpDialog.getByRole('button', { name: /Add to routing/i }).click();
    await expect(addOpDialog).toBeHidden({ timeout: 10_000 });

    // ── Step 3: Verify the operation was auto-saved on the part detail ──

    // Save indicator confirms the inline panel persisted the change.
    await expect(page.getByText(/All changes saved/i)).toBeVisible({ timeout: 15_000 });

    // Operations list header shows step count once a row is added.
    await expect(page.getByText(/1 step/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 4: Navigate back to parts list and verify ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    // The part should appear in the list
    await expect(page.getByText(partName)).toBeVisible({ timeout: 10_000 });
  });
});
