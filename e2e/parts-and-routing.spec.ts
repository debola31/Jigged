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

  test('create part, add routing with operations, verify cost and pricing isolation', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Create a new part ──

    await navigateTo(page, 'Parts');
    await expect(page).toHaveURL(/\/parts/);

    /*
     * Parts is the item master and carries NO quantities — that is the rule the `is_stocked`
     * removal established, and these four assertions are what hold it.
     *
     * Asserted here rather than in a jsdom unit test on purpose: there is no AG-Grid-in-jsdom
     * precedent in this repo, and a grid rendered by a real browser is the only place a column
     * header's absence means anything. Negative assertions are weak, so they are pinned where
     * they are cheap and honest rather than given a fragile test file of their own.
     */
    await expect(page.getByRole('button', { name: /Count Inventory/i })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /^Stock$/i })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /On hand/i })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /^Status$/i })).toHaveCount(0);

    // "Add Part" navigates to the create-mode part workspace (/parts/new) —
    // the create modal was retired in the parts re-architecture. Identity
    // fields render directly on the page (the create view = the saved view).
    await page.getByRole('button', { name: /Add Part/i }).click();
    await expect(page).toHaveURL(/\/parts\/new/, { timeout: 15_000 });

    // Fill part name (required) — Source defaults to 'made', which the routing
    // steps below need.
    await page.getByLabel(/Part Name/i).fill(partName);

    // Fill description
    await page.getByLabel(/Description/i).fill(partDescription);

    // Pick a primary unit. The parts_requires_unit DB constraint makes
    // primary_unit NOT NULL for every part, and the create gate enforces the
    // same rule client-side. UnitOfMeasurementSelect wraps an MUI Autocomplete:
    // fill the input to open + filter; the 'each' option renders as "Each (ea)".
    const unitCombobox = page.getByRole('combobox', { name: /Unit of measurement/i });
    await expect(unitCombobox).toBeVisible();
    await unitCombobox.fill('each');
    await page.getByRole('option', { name: /Each \(ea\)/i }).first().click();

    // Submit — the create gate's primary action is "Create part".
    await page.getByRole('button', { name: /Create part/i }).click();

    // The workspace redirects (router.replace) into the live part page
    // (`/parts/{partId}?from=parts`). Anchor on the partId path segment.
    await expect(page).toHaveURL(/\/parts\/(?!new)[^/?]+/, { timeout: 15_000 });

    // The sticky part header renders the part name as the page heading.
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

    // The inline editor autofocuses the Work center field, which now opens its
    // dropdown automatically (openOnFocus). Target the combobox by role — the
    // open listbox shares the field's accessible name, so getByLabel would be
    // ambiguous. Type to filter to `E2E Internal WC` and pick it explicitly:
    // the seed (e2e/global-setup.ts) creates both an Internal and an External
    // WC, and the external one would reshape the editor to vendor-price fields
    // (no Cycle minutes per unit) and break the next assertion.
    const workCenterField = page.getByRole('combobox', { name: /^Work center$/ });
    await workCenterField.fill('E2E Internal WC');

    const listbox = page.getByRole('listbox');
    const internalWcOption = listbox.getByRole('option', { name: /E2E Internal WC/ });
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

    // ── Step 3b: A staged pricing edit survives a sibling panel's auto-save ──
    //
    // The reported bug: type a Min qty in the Pricing card, then edit an
    // operation. The routing auto-save bumps the page-wide refreshKey, which
    // used to re-seed the tier rows from the DB and silently revert the typed
    // value. Pricing and Operations sit side by side, so the user watches it
    // happen. See interaction-standards.md §2, invariant 1.

    const pricingCard = page
      .locator('.MuiCard-root')
      .filter({ has: page.getByRole('heading', { name: /^Pricing$/ }) });

    // Tier row inputs are Min qty / Markup % / Unit price, in that order.
    const minQty = pricingCard.getByRole('textbox').first();
    await expect(minQty).toBeVisible({ timeout: 15_000 });
    await minQty.fill('250');

    // The staged state is announced by the sticky footer, not a grey caption.
    await expect(pricingCard.getByText(/unsaved change/i)).toBeVisible();

    // Now make the sibling save that used to wipe it: change the operation's
    // cycle time, exactly like the customer did.
    await page.getByRole('button', { name: /Edit operation/i }).first().click();
    await page.getByLabel(/Cycle minutes per unit/i).fill('5');
    // In edit mode the row editor's primary action is "Save changes"
    // ("Add to routing" is the create-mode label).
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByText(/All changes saved/i)).toBeVisible({ timeout: 15_000 });
    // Confirm the sibling save actually landed before judging its effect on us.
    // The new cycle time renders in both the panel summary line and the row, so
    // take the first match rather than tripping strict mode.
    await expect(page.getByText(/run 5 min\/unit/i).first()).toBeVisible({ timeout: 15_000 });

    // The staged tier edit is still there, and still staged.
    await expect(minQty).toHaveValue('250');
    await expect(pricingCard.getByText(/unsaved change/i)).toBeVisible();

    // Commit it, then prove it actually reached the database rather than only
    // the UI — the reload-after-save convention from docs/testing/README.md.
    await pricingCard.getByRole('button', { name: /Save pricing/i }).click();
    await page.reload();

    const minQtyAfterReload = page
      .locator('.MuiCard-root')
      .filter({ has: page.getByRole('heading', { name: /^Pricing$/ }) })
      .getByRole('textbox')
      .first();
    await expect(minQtyAfterReload).toHaveValue('250', { timeout: 15_000 });

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
