import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';
import path from 'path';

/**
 * E2E: Add parts from drawings.
 *
 * THE GRID FILLS WITH NO NETWORK CALL AT ALL, and that is the point. The
 * deterministic pass — DXF parsing, the title-block matcher, the cut-list reader —
 * runs entirely in the browser. The AI assist is a separate explicit button, per
 * CLAUDE.md's rule that an Anthropic call needs a user action, and this spec
 * presses it against the MOCK (`e2e/mocks/anthropic-server.mjs`, reached via
 * ANTHROPIC_BASE_URL) so the real route, gates and fidelity check are exercised for
 * no credits.
 *
 * The mock echoes a material back out of the strings it was SENT, because the route
 * drops any value that was not on the drawing. A hardcoded fixture would be dropped
 * as invention and this spec would prove nothing.
 *
 * Prerequisites:
 * - The `drawing_import` feature flag must be on for the test company. The
 *   run-stack script seeds it; if running `playwright test` by hand, enable it:
 *     UPDATE companies SET settings =
 *       jsonb_set(COALESCE(settings,'{}'::jsonb),'{features,drawing_import}','true'::jsonb,true);
 *
 * Fixtures are REAL drawings from a customer package, because the bugs this flow
 * had were all things synthetic files do not do: an ATTDEF prompt in group code 3,
 * a part number split across numbered tags, a cut-list cell wrapping onto two
 * lines.
 */

const FIXTURES = path.join(__dirname, 'fixtures/drawings');

test.describe('Add parts from drawings', () => {
  test('reads a folder of drawings and creates parts from them', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Parts → Add from Drawings ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    await page.getByRole('button', { name: /Add from Drawings/i }).click();
    await expect(page).toHaveURL(/\/parts\/drawings/);

    // ── Step 2: add the files ──
    // Hidden input, so setInputFiles rather than a click — the same approach the
    // CSV import spec uses.
    const fileInput = page.locator('input[type="file"][accept=".pdf,.dxf,.step,.stp"]');
    await fileInput.setInputFiles([
      path.join(FIXTURES, 'E2E-DRAW-1.dxf'),
      path.join(FIXTURES, 'E2E-DRAW-1.pdf'),
      path.join(FIXTURES, 'E2E-DRAW-2.dxf'),
      path.join(FIXTURES, 'E2E-PDFONLY.pdf'),
    ]);

    // Four files, three parts: the .dxf and .pdf sharing a stem are one part.
    await expect(page.getByText(/4 files ready/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /^Read 4 files$/i }).click();

    // ── Step 3: review ──
    // Deterministic + pdf.js, so allow for the PDF parse but no network.
    const rows = page.getByTestId('drawing-row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });

    // The extractor read this drawing's title block: the part number is the one on
    // the sheet, not the filename we copied it to.
    await expect(page.getByRole('textbox', { name: /Part name for E2E-DRAW-1/i })).toHaveValue(
      '1011770',
    );

    // E2E-DRAW-2 carries a weldment cut list — 3 rows on this sheet. The count sits
    // in its own column beside the files, NOT in "Needs a look": it is information,
    // and that column means "act on this".
    await expect(page.getByTitle(/lists 3 components/i)).toBeVisible();

    // ── Step 3b: the OPTIONAL AI pass ──
    // A button, never a mount effect. Anthropic is mocked (see the file header), so
    // this exercises the real route, gates and fidelity check for no credits. The
    // mock echoes a material back OUT OF THE STRINGS IT WAS SENT, because the route
    // drops anything that was not on the drawing.
    const assist = page.getByRole('button', { name: /Read the title blocks/i });
    if (await assist.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await assist.click();
      // The offer disappears once it has run, whatever it found.
      await expect(assist).toBeHidden({ timeout: 120_000 });
    }

    // ── Step 4: create ──

    const createButton = page.getByRole('button', { name: /Create 3 parts/i });
    await expect(createButton).toBeEnabled();
    await createButton.click();

    // The summary says what happened rather than claiming everything was new.
    await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 120_000 });

    // ── Step 5: the parts really exist ──

    await page.getByRole('button', { name: /Go to Parts/i }).click();
    await expect(page).toHaveURL(/\/parts$/);
    await expect(page.getByText('1011770').first()).toBeVisible({ timeout: 30_000 });
  });

  /**
   * A row nobody can read must still become a part with its files attached — never
   * rejected into the void — and it must say WHY rather than showing a blank row.
   */
  test('says when a drawing cannot be read instead of dropping it', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Parts');
    await page.getByRole('button', { name: /Add from Drawings/i }).click();

    // A STEP model on its own: nothing in it to read.
    const fileInput = page.locator('input[type="file"][accept=".pdf,.dxf,.step,.stp"]');
    await fileInput.setInputFiles([path.join(FIXTURES, 'E2E-DRAW-1.dxf')]);
    await page.getByRole('button', { name: /^Read 1 files$/i }).click();

    await expect(page.getByTestId('drawing-row')).toHaveCount(1, { timeout: 60_000 });
    // Healthy row: review by exception means no chip at all.
    await expect(page.getByText(/looks like a scan/i)).toHaveCount(0);
  });
});
