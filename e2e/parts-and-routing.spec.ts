import { test, expect } from '@playwright/test';
import { navigateTo, waitForGridLoaded } from './helpers/navigation';

/**
 * E2E: Parts + Routing workflow
 *
 * Prerequisites (in test company):
 * - At least 1 work center exists (for adding to a routing)
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

    // "Add Part" now opens an inline PartFormModal instead of navigating to
    // /parts/new — scope all field interactions to the dialog so we don't
    // accidentally match the (off-screen) parts list behind it.
    await page.getByRole('button', { name: /Add Part/i }).click();
    const partFormDialog = page.getByRole('dialog');
    await expect(partFormDialog).toBeVisible();

    // Fill part name (required) — Source defaults to 'made' (the modal's
    // default), which is what the rest of this spec needs to exercise the
    // routing panel.
    await partFormDialog.getByLabel(/Part Name/i).fill(partName);

    // Fill description
    await partFormDialog.getByLabel(/Description/i).fill(partDescription);

    // Pick a primary unit. The parts_requires_unit DB constraint (added in
    // 20260602000000_fix_cost_error_part_name_and_unit_canonicalization)
    // makes primary_unit NOT NULL for every part, and PartForm gates submit
    // on the same rule client-side — without this, validation blocks Create
    // and the modal never closes.
    await partFormDialog.getByLabel(/Unit of measurement/i).click();
    await page.getByRole('option', { name: /^each$/i }).first().click();

    // Submit — primary action is "Create" (was "Save" in the route-based form).
    await partFormDialog.getByRole('button', { name: /^Create$/i }).click();

    // After creation the modal closes and we land on the part detail page
    // (`/parts/{partId}?from=parts`). Anchor on the partId path segment.
    await expect(page).toHaveURL(/\/parts\/(?!new)[^/]+/, { timeout: 15_000 });

    // Verify the part was created. The part detail page renders the part
    // name in the page heading AND inside the BOM panel's descriptive copy
    // ("Parts consumed when manufacturing this <name>."), so a bare
    // getByText trips strict mode — scope to the heading.
    await expect(page.getByRole('heading', { name: partName })).toBeVisible();

    // ── Step 2: Add an operation via the inline routing editor ──
    // The routing panel is embedded on the part detail page — no navigation needed.

    await page.waitForLoadState('networkidle');

    // Empty-state hint confirms the panel loaded with no operations yet.
    await expect(
      page.getByText(/Click "Add Operation" to start building this routing/i)
    ).toBeVisible({ timeout: 10_000 });

    // Click "Add Operation" (in the Operations card header) — opens an inline
    // editor row at the bottom of the Operations list (no dialog).
    await page.getByRole('button', { name: /Add Operation/i }).click();

    // Open the Work center autocomplete. Pick `E2E Internal WC` explicitly
    // — the seed (e2e/global-setup.ts) creates both an Internal and an
    // External WC, alphabetical sort puts the External one first, and
    // selecting an external WC reshapes the editor to vendor-price fields
    // (no Cycle minutes per unit), which would break the next assertion.
    await page.getByLabel(/^Work center$/).click();

    const listbox = page.getByRole('listbox');
    const internalWcOption = listbox.getByRole('option', { name: /E2E Internal WC/ });
    const hasInternalWc = await internalWcOption
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (!hasInternalWc) {
      test.skip(true, 'E2E Internal WC missing from test company (seed should have created it)');
    }

    await internalWcOption.click();

    // Editor requires at least one of cycle / setup minutes before save will
    // commit (see RoutingOperationRowEditor validation). Fill cycle minutes.
    await page.getByLabel(/Cycle minutes per unit/i).fill('2');

    // Confirm: "Add to routing" (the inline editor's primary action)
    await page.getByRole('button', { name: /Add to routing/i }).click();

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
    // The /\/parts/ pattern would also match /parts/{id}; require the path
    // to end at /parts so we know we actually left the detail page.
    await expect(page).toHaveURL(/\/parts(?:\?|$)/);

    // Wait for AG Grid to finish loading before asserting on cell content —
    // otherwise the assertion races against the loading overlay and trips
    // strict mode against any DOM Next.js still has cached from the
    // previous /parts/{id} route.
    await waitForGridLoaded(page);

    // Filter the grid to the new part. AG Grid virtualizes rows, so a bare
    // getByText won't find the row when accumulated E2E-* parts from prior
    // CI runs push it outside the viewport. The search box also exercises
    // the server-side query path (getAllParts with an ilike filter), which
    // is what we actually want to verify here.
    await page.getByPlaceholder(/Search parts/i).fill(partName);

    // The part should appear in the (now-filtered) grid.
    await expect(
      page.locator('.ag-root-wrapper').getByText(partName).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
