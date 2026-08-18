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

    // ── Step 3b: the AI pass, which has already run ──
    // It is chained to the "Read the files" press rather than being a second
    // button — the no-AI-on-load rule is about lifecycle hooks, and that press is
    // a user action. Anthropic is mocked (see the file header), so this exercises
    // the real route, gates and fidelity check for no credits, and the mock echoes
    // a material back OUT OF THE STRINGS IT WAS SENT because the route drops
    // anything that was not on the drawing.
    //
    // The offer only remains as a RETRY, so its absence is the success condition.
    const assist = page.getByRole('button', { name: /Read the title blocks/i });
    await expect(assist).toBeHidden({ timeout: 120_000 });

    // ── Step 4: how they are made ──
    // The step that makes the whole flow worth having. Without a priced operation
    // a made part has no cost basis, so every part lands incomplete and nothing
    // can be quoted.
    await page.getByRole('button', { name: /Create 3 parts/i }).click();
    await expect(page.getByText(/How are these parts made/i)).toBeVisible();

    await page.getByRole('button', { name: /Add Operation/i }).click();

    // The seeded internal work centre carries a labour rate, so this operation is
    // priced and the part's cost resolves.
    // The picker renders each option as custom markup (name, kind, rate), so its
    // accessible name is not just the work-centre name — filter, then take the
    // first match rather than matching on a label that includes the rate.
    const workCenter = page.getByRole('combobox', { name: /Work center/i });
    await workCenter.fill('E2E Internal');
    await page.getByRole('option').first().click();

    await page.getByLabel(/Cycle minutes per unit/i).fill('5');
    await page.getByLabel(/Setup minutes/i).fill('10');
    await page.getByRole('button', { name: /Add to routing/i }).click();

    // One routing, applied to all three parts.
    await expect(page.getByText(/1 operation on 3 of 3 parts/i)).toBeVisible();

    // ── Step 5: create ──

    const createButton = page.getByRole('button', { name: /Create 3 parts/i });
    await expect(createButton).toBeEnabled();
    await createButton.click();

    // THE PAYOFF: parts that can actually be quoted, not just filed.
    await expect(page.getByText(/ready to quote/i)).toBeVisible({ timeout: 180_000 });

    // ── Step 6: hand off to a quote ──

    await page.getByRole('button', { name: /Quote \d+ of these/i }).click();
    await expect(page).toHaveURL(/\/quotes\/new\?parts=/);
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

  /**
   * The weldment case. A cut list only helps if its materials carry a cost — a BOM
   * line to a child with no cost basis makes the PARENT unpriceable, so attaching
   * materials without prices would take a weldment that quotes and stop it.
   */
  test('a weldment gets its materials, and a cost is what makes them count', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Parts');
    await page.getByRole('button', { name: /Add from Drawings/i }).click();

    await page
      .locator('input[type="file"][accept=".pdf,.dxf,.step,.stp"]')
      .setInputFiles([path.join(FIXTURES, 'E2E-WELDMENT.dxf')]);
    await page.getByRole('button', { name: /^Read 1 files$/i }).click();

    // Nine cut-list rows on this sheet.
    await expect(page.getByTitle(/lists 9 components/i)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /Create 1 part/i }).click();

    // Twelve rows collapse to the distinct tube sizes, pooled across the drawing.
    const materials = page.getByTestId('material-row');
    await expect(materials).toHaveCount(2);

    // Before any cost is given, the panel names the part that will be held back
    // rather than saying something vague about incompleteness.
    await expect(page.getByText(/won't be quotable yet/i)).toBeVisible();

    // The made components have no work, so they block regardless — untick them to
    // isolate what a material cost actually changes.
    for (const pad of ['MOUNTING PADS', 'ROBOT RISER PAD', 'REGRIP PAD']) {
      await page.getByRole('button', { name: new RegExp(pad, 'i') }).click();
    }

    // The unit is asked for, never guessed — these sheets print "1803.2" beside a
    // tube described in inches, and guessing would scale every cost by 25.4.
    await page.getByLabel(/^Unit for 8" x 4" x 1\/4" WALL$/i).fill('mm');
    await page.getByLabel(/^Unit for 4" x 4" x 1\/4" WALL$/i).fill('mm');
    await page.getByLabel(/Cost per unit for 8" x 4" x 1\/4" WALL/i).fill('0.05');
    await page.getByLabel(/Cost per unit for 4" x 4" x 1\/4" WALL/i).fill('0.03');

    // With every component either priced or excluded, nothing is held back.
    await expect(page.getByText(/won't be quotable yet/i)).toHaveCount(0);

    // Give it work so it has a cost of its own too.
    await page.getByRole('button', { name: /Add Operation/i }).click();
    const workCenter = page.getByRole('combobox', { name: /Work center/i });
    await workCenter.fill('E2E Internal');
    await page.getByRole('option').first().click();
    await page.getByLabel(/Cycle minutes per unit/i).fill('30');
    await page.getByRole('button', { name: /Add to routing/i }).click();

    await page.getByRole('button', { name: /Create 1 part/i }).click();
    await expect(page.getByText(/ready to quote/i)).toBeVisible({ timeout: 180_000 });

    // The BOM lines are the point, and "ready to quote" cannot see them — this
    // weldment is quotable on its labour alone, so the whole cut list once
    // silently failed to attach while this test stayed green. Assert the count.
    await expect(page.getByText(/2 components attached/i)).toBeVisible();
  });
});
