import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: Quote → Job → Complete workflow
 *
 * Prerequisites (in test company):
 * - At least 1 customer exists
 * - At least 1 part with a routing exists
 */
test.describe('Quote to Job workflow', () => {
  test('create quote, approve, convert to job, complete operations, ship', async ({
    page,
  }) => {
    // Go to dashboard first to extract companyId from URL
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Create a new quote ──

    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);

    // Click "New Quote" button
    await page.getByRole('button', { name: /New Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/new/);

    // Select a customer (MUI Autocomplete)
    const customerField = page.getByRole('combobox', { name: /Select Customer/i });
    await customerField.click();
    await customerField.fill('');
    // Pick the first customer option (skip the "Create New Customer" option)
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasNot: page.getByText(/Create New/i) })
      .first()
      .click();

    // Select a part (MUI Autocomplete)
    const partField = page.getByRole('combobox', { name: /Select Part/i });
    await partField.click();
    await partField.fill('');
    // Pick the first part option (skip "Create New Part")
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasNot: page.getByText(/Create New/i) })
      .first()
      .click();

    // Fill quantity
    await page.getByLabel(/Quantity/i).fill('10');

    // Save as draft
    await page.getByRole('button', { name: /Save as Draft/i }).click();

    // Should redirect to the quote detail page
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // Verify the quote was created — quote number should be visible
    await expect(page.getByText(/Q-\d+/)).toBeVisible();

    // ── Step 2: Send for approval ──

    await page.getByRole('button', { name: /Send for Approval/i }).click();
    // Status should change to "Pending Approval"
    await expect(page.getByText(/Pending Approval/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 3: Approve the quote ──

    await page.getByRole('button', { name: /Approve/i }).click();
    await expect(page.getByText(/Approved/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 4: Convert to job ──

    await page.getByRole('button', { name: /Convert to Job/i }).click();

    // Wait for the Convert to Job dialog
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Convert to Job/i)).toBeVisible();

    // Wait for routing check to complete
    // Either "Routing found with N operations" (success) or "No routing defined" (warning)
    await expect(
      dialog.getByText(/Routing found|No routing defined/i).first()
    ).toBeVisible({ timeout: 15_000 });

    // If no routing, we can't proceed — skip the rest
    const hasRouting = await dialog.getByText(/Routing found/i).isVisible().catch(() => false);
    if (!hasRouting) {
      test.skip(true, 'Test part has no routing — cannot convert to job');
    }

    // Click "Create Job"
    await dialog.getByRole('button', { name: /Create Job/i }).click();

    // Should redirect to the new job detail page
    await expect(page).toHaveURL(/\/jobs\/[^/]+$/, { timeout: 15_000 });

    // Verify job was created
    await expect(page.getByText(/J-\d+/)).toBeVisible();

    // ── Step 5: Start the job ──

    // Job should be in "Pending" status initially
    await expect(page.getByText(/Pending/i).first()).toBeVisible();

    // If there are operations, the job might auto-start. Check for operations panel.
    const hasOperations = await page.getByText(/Operations/i).isVisible();

    if (!hasOperations) {
      // No operations — click "Start Job" manually
      await page.getByRole('button', { name: /Start Job/i }).click();
      await expect(page.getByText(/In Progress/i)).toBeVisible({ timeout: 10_000 });
    }

    // ── Step 6: Complete operations (if present) ──

    // Look for operation "Start" buttons in the operations panel
    const startButtons = page.getByRole('button', { name: /^Start$/i });
    const startCount = await startButtons.count();

    if (startCount > 0) {
      // Start the first operation
      await startButtons.first().click();
      await expect(page.getByText(/In Progress/i).first()).toBeVisible({
        timeout: 10_000,
      });

      // Complete the first operation
      const completeBtn = page.getByRole('button', { name: /^Complete$/i }).first();
      await completeBtn.click();

      // Complete Operation modal
      const completeDialog = page.getByRole('dialog');
      await expect(completeDialog).toBeVisible();
      await expect(completeDialog.getByText(/Complete Operation/i)).toBeVisible();

      // Click "Complete" in the modal (leave actual hours empty to use estimates)
      await completeDialog.getByRole('button', { name: /^Complete$/i }).click();

      // Wait for the modal to close and operation to be marked complete
      await expect(completeDialog).toBeHidden({ timeout: 10_000 });

      // If there are more operations, start and complete each one
      let nextStart = page.getByRole('button', { name: /^Start$/i });
      while ((await nextStart.count()) > 0) {
        await nextStart.first().click();

        const complBtn = page.getByRole('button', { name: /^Complete$/i }).first();
        await complBtn.click();

        const dlg = page.getByRole('dialog');
        await expect(dlg).toBeVisible();
        await dlg.getByRole('button', { name: /^Complete$/i }).click();
        await expect(dlg).toBeHidden({ timeout: 10_000 });

        nextStart = page.getByRole('button', { name: /^Start$/i });
      }
    }

    // ── Step 7: Job should be completed (auto or manual) ──

    // After all operations are done, the job should auto-complete
    // or we need to complete it manually
    const completedChip = page.getByText(/Completed/i);
    const markCompleteBtn = page.getByRole('button', { name: /Mark Complete/i });

    if (await markCompleteBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await markCompleteBtn.click();
    }

    await expect(completedChip.first()).toBeVisible({ timeout: 15_000 });

    // ── Step 8: Ship the job ──

    await page.getByRole('button', { name: /Mark Shipped/i }).click();
    await expect(page.getByText(/Shipped/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
