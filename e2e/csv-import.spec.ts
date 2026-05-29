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

    // ── Step 6: Handle the two import dialogs ──
    //
    // The current import page can show up to two dialogs after Continue:
    //
    //   1. "Some Fields Not Mapped" — triggered when any optional schema
    //      field (e.g. Category, Notes) isn't mapped from the CSV. The
    //      test-parts.csv fixture only maps part_name + description, so
    //      this dialog fires every run. Primary action: "Proceed Anyway"
    //      (calls handleValidate); secondary: "Go Back".
    //   2. ConflictDialog — only opens if validate-against-DB finds dup
    //      rows or row-level validation errors. For a fresh local
    //      Supabase the seed creates E2E-MFG-001/RAW-001/SUB-001 (NOT
    //      E2E-CSV-00*), so the import CSV doesn't conflict and this
    //      dialog typically does NOT show — handleValidate goes straight
    //      to executeImport.
    //
    // Both dialogs share role="dialog", so disambiguate by heading text.
    const unmappedDialog = page.getByRole('dialog', { name: /Some Fields Not Mapped/i });
    if (await unmappedDialog.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await unmappedDialog.getByRole('button', { name: /Proceed Anyway/i }).click();
    }

    // Conflict dialog is opportunistic — fires when validate-against-DB
    // finds dup part_name rows (e.g. when re-running the spec against a
    // local Supabase that already has the imported parts from a prior
    // run). Title is "Issues Detected" per ConflictDialog.tsx; primary
    // action is "Import {N} Parts".
    const conflictDialog = page.getByRole('dialog', { name: /Issues Detected/i });
    if (await conflictDialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await conflictDialog.getByRole('button', { name: /^Import \d+ Parts/i }).click();
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
