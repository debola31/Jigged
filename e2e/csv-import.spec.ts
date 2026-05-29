import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';
import path from 'path';

/**
 * E2E: CSV Import workflow
 *
 * Prerequisites:
 * - FastAPI backend must be running (for AI column analysis)
 * - Test company must exist
 *
 * AI provider: the orchestration layer (see `e2e/run-stack.mjs`,
 * launched via the `test:e2e:local` npm script and the E2E CI workflow)
 * starts `e2e/mocks/anthropic-server.mjs` on port 9876 and sets
 * `ANTHROPIC_BASE_URL` so the FastAPI backend's Anthropic SDK calls land
 * there instead of api.anthropic.com. The mock returns a canned mapping
 * for the test-parts.csv fixture.
 */
test.describe('CSV Import workflow', () => {
  test('import parts from CSV file', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Navigate to Parts → Import ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    await page.getByRole('button', { name: /Import/i }).click();
    await expect(page).toHaveURL(/\/parts\/import/);

    // ── Step 2: Upload CSV file ──

    // The file input is hidden — use setInputFiles to bypass
    const fileInput = page.locator('input[type="file"][accept=".csv"]');
    await fileInput.setInputFiles(path.join(__dirname, 'fixtures/test-parts.csv'));

    // Verify rows were loaded
    await expect(page.getByText(/3 rows loaded/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 3: Click "Analyze CSV" ──
    // (The customer-match mode picker was removed in PR 1; parts no longer
    // link to customers, so the upload step jumps straight to AI analysis.)

    await page.getByRole('button', { name: /Analyze CSV/i }).click();

    // Wait for AI analysis to complete (this may take several seconds)
    // The stepper should advance past "AI Analysis"
    await expect(page.getByText(/AI is mapping/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 5: Review mappings ──

    // Wait for the review step to appear (AI analysis complete)
    await expect(
      page.getByRole('button', { name: /Continue to Import/i })
    ).toBeVisible({ timeout: 60_000 });

    // Click "Continue to Import"
    await page.getByRole('button', { name: /Continue to Import/i }).click();

    // ── Step 6: Handle validation/conflicts ──

    // Wait for validation to complete
    // If there are conflicts, a dialog appears — confirm to proceed
    const conflictDialog = page.getByRole('dialog');
    const hasConflicts = await conflictDialog
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (hasConflicts) {
      // Click "Confirm" to proceed with import
      await conflictDialog.getByRole('button', { name: /Confirm/i }).click();
    }

    // ── Step 7: Wait for import to complete ──

    await expect(page.getByText(/Import Complete/i)).toBeVisible({ timeout: 60_000 });

    // Verify at least some rows were imported
    await expect(page.getByText(/Imported/i)).toBeVisible();

    // ── Step 8: Navigate to parts list to verify ──

    await page.getByRole('button', { name: /View Parts/i }).click();
    await expect(page).toHaveURL(/\/parts/, { timeout: 10_000 });

    // At least one of the imported parts should be visible
    await expect(page.getByText('E2E-CSV-001')).toBeVisible({ timeout: 15_000 });
  });
});
