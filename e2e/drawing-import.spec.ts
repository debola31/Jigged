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
 * - No feature flag. The surface ships on for every company, so there is nothing
 *   to seed and nothing to forget.
 *
 * Fixtures are REAL drawings from a customer package, because the bugs this flow
 * had were all things synthetic files do not do: an ATTDEF prompt in group code 3,
 * a part number split across numbered tags, a cut-list cell wrapping onto two
 * lines.
 */

const FIXTURES = path.join(__dirname, 'fixtures/drawings');

/**
 * SERIAL, and it has to be. Every spec here creates parts named after the SAME
 * fixture drawings, so two workers running them at once race on
 * `parts_unique_per_company` — one wins, the other's rows fail, and the failure
 * reads like a bug in the import rather than in the test. Re-runs across a shared
 * local database are fine on their own: the second pass resolves to "known" and
 * updates.
 */
test.describe.configure({ mode: 'serial' });

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

    // ── The workspace ──
    // Deterministic + pdf.js, so allow for the PDF parse but no network.
    const rows = page.getByTestId('drawing-row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });

    // What we made of the folder, said once, before any table is scanned.
    await expect(page.getByText(/3 parts from 4 files\./i)).toBeVisible();

    // The extractor read this drawing's title block: the part number is the one on
    // the sheet, not the filename we copied it to.
    await expect(page.getByRole('textbox', { name: /Part name for E2E-DRAW-1/i })).toHaveValue(
      '1011770',
    );

    // ── The drawing, beside the row it produced ──
    // Checking a package is a comparison, so both have to be on screen. No upload:
    // the row still holds the File, so this is an object URL.
    await expect(page.getByTestId('drawing-file-panel')).toHaveCount(0);
    await page.getByRole('button', { name: /Open the drawing for 1011770/i }).click();
    const panel = page.getByTestId('drawing-file-panel');
    await expect(panel).toBeVisible();
    // E2E-DRAW-1 arrived as a DXF and a PDF, so both are offered and the PDF —
    // the sheet a person reads — is the one shown.
    await expect(panel.getByRole('button', { name: /^pdf$/i })).toBeVisible();
    // Rendered through pdf.js so it can zoom and pan, not handed to a browser frame.
    await expect(panel.locator('canvas')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('button', { name: /Zoom in/i })).toBeVisible();
    await panel.getByRole('button', { name: /Hide the drawing/i }).click();
    await expect(page.getByTestId('drawing-file-panel')).toHaveCount(0);

    // ── Routing by tapping stations, no numbers ──
    // Which stations a part visits is recall; how long it takes there is a
    // consensus the shop may not have reached. So the fast path asks only the
    // first, and the part comes out routed but NOT costed.
    // Operations are opt-in: the screen opens as a plain list of parts, because
    // filing is the whole job for most imports.
    await page.getByRole('checkbox', { name: /Add operations/i }).check();

    // Work is entered ON a part, then spread — "apply this to the other 30" reads
    // as a consequence of something concrete.
    await page.getByRole('button', { name: /Set up E2E-DRAW-1/i }).click();

    // Search filters the strip in place — no dropdown, no second surface.
    await page.getByRole('textbox', { name: /Search work centres/i }).first().fill('E2E Internal');
    await page.getByTestId('station-option').first().click();
    await expect(page.getByTestId('route-step')).toHaveCount(1);

    await page.getByRole('button', { name: /Apply this routing to the other 2 parts/i }).click();
    await expect(page.getByText(/3 routed/i)).toBeVisible();

    // ── Filing is the outcome ──
    // No quote hand-off: a part is only quotable once someone says how long its
    // stations take, and an untimed operation is deliberately not a cost basis.
    await page.getByRole('button', { name: /^Create 3 parts$/i }).click();
    // "created" on a fresh database, "updated" when the suite has run before —
    // both are the flow finishing, and pinning one made the second run a failure.
    await expect(page.getByText(/3 (created|updated)/i)).toBeVisible({ timeout: 180_000 });

    // Routed, not costed — so the flow must NOT claim these are ready to quote.
    await expect(page.getByText(/ready to quote/i)).toHaveCount(0);
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
    await page.getByRole('button', { name: /^Read 1 file$/i }).click();

    await expect(page.getByTestId('drawing-row')).toHaveCount(1, { timeout: 60_000 });
    // Healthy row: review by exception means no chip at all.
    await expect(page.getByText(/looks like a scan/i)).toHaveCount(0);
  });

  /**
   * Materials are the SHOP's answer, not the drawing's.
   *
   * A cut list only exists on the odd weldment, so inferring meant "Add materials"
   * had nothing to offer for most of a package. Any part can take a material now —
   * and a material with no cost basis is deliberately NOT attached, because a BOM
   * line to a child nothing can price takes its parent from quotable to not.
   */
  test('a part gets a material, and a cost is what makes it count', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Parts');
    await page.getByRole('button', { name: /Add from Drawings/i }).click();

    await page
      .locator('input[type="file"][accept=".pdf,.dxf,.step,.stp"]')
      .setInputFiles([path.join(FIXTURES, 'E2E-WELDMENT.dxf')]);
    await page.getByRole('button', { name: /^Read 1 file$/i }).click();

    await expect(page.getByTestId('drawing-row')).toHaveCount(1, { timeout: 60_000 });

    await page.getByRole('checkbox', { name: /Add materials/i }).check();
    await page.getByRole('checkbox', { name: /Add operations/i }).check();
    await page.getByRole('button', { name: /Set up E2E-WELDMENT/i }).click();

    // One line is offered rather than an empty panel — the common case is that a
    // part is made of something.
    await expect(page.getByTestId('material-line')).toHaveCount(1);

    // A NEW material: nothing knows what it costs, so the field appears and says
    // what happens if it is left blank.
    await page.getByLabel(/New material name/i).fill('4140 BAR 2 IN');
    await page.getByLabel(/^Quantity$/i).fill('3');
    await page.getByLabel(/^Unit$/i).fill('ft');
    await expect(page.getByText(/1 material, 1 without a cost/i)).toBeVisible();
    await expect(page.getByText(/cannot be quoted/i)).toBeVisible();

    await page.getByLabel(/Cost per unit for 4140 BAR 2 IN/i).fill('12.5');
    await expect(page.getByText(/1 material\./i)).toBeVisible();

    // Give it TIMED work, so this part really does resolve to a cost — the full
    // editor is a click away for anyone who already knows the numbers.
    await page.getByRole('button', { name: /Set times and rates/i }).first().click();
    await page.getByRole('button', { name: /Add Operation/i }).click();
    const workCenter = page.getByRole('combobox', { name: /Work center/i });
    await workCenter.fill('E2E Internal');
    await page.getByRole('option').first().click();
    await page.getByLabel(/Cycle minutes per unit/i).fill('30');
    await page.getByRole('button', { name: /Add to routing/i }).click();

    await page.getByRole('button', { name: /^Create 1 part$/i }).click();
    await expect(page.getByText(/ready to quote/i)).toBeVisible({ timeout: 180_000 });

    // The BOM line is the point, and "ready to quote" cannot see it — this part is
    // quotable on its labour alone, so a material that silently failed to attach
    // would leave this test green. Assert the count.
    await expect(page.getByText(/1 component attached/i)).toBeVisible();
  });
});
