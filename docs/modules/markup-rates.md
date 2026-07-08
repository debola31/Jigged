# Markup Rates Module

## Overview

A **markup rate** is a named pattern of quantity break-points + markup percentages that can be applied to a part to materialize its pricing tiers. The resulting tiers resolve to a sell price for **both made and bought parts** — markup is applied to the routing/BOM cost for made parts and to the procurement-tier cost for bought parts. Markup rates are company-scoped, and one rate per company can be marked as the default for new parts.

**Applying a rate creates a live link, not a one-time snapshot.** When a rate is applied to a part, the part's pricing tiers are materialized from the rate's breakpoints *and* `parts.markup_rate_id` is set to that rate. The link is the source of truth for propagation:

- **Editing** a rate cascades to every part currently linked to it — each linked part's tiers are re-derived from the new breakpoints (`cascadeRateUpdateToParts`).
- **Deleting** a rate breaks the link (`ON DELETE SET NULL` clears `parts.markup_rate_id`) but leaves each affected part sitting on its **last-applied markup** — the tiers that rate produced survive; only the live link is severed.

> Two lower-level artifacts (`types/markupRates.ts` JSDoc and the `markup_rates` table `COMMENT`) still describe the feature's original snapshot-only design and are stale relative to this live-cascade behavior. Correcting them is tracked in **#550**; the canonical semantic is the live link described here.

**Priority:** Built; in production.

**Dependencies:** [Parts](parts.md) (parts link to markup rates via `parts.markup_rate_id`).

---

## Data Model

### `markup_rates` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `company_id` | uuid | FK → `companies` |
| `name` | text | Required, unique per company |
| `breakpoints` | jsonb | Array of `{qty: int>0, markup_percent: number}`, sorted by qty ascending |
| `is_default` | boolean | At most one row per company has `is_default=true` (partial unique index) |
| `created_at` / `updated_at` | timestamptz | |

Per-company seeded patterns (inserted by the `seed_default_markup_rates()` trigger, which fires `AFTER INSERT ON companies` — so every new company starts with them; the table + trigger live in the baseline migration): **Default** (1× 25%, `is_default=true`), **Volume tiers** (1× 25%, 10× 22%, 100× 18%, 1000× 15%), **Premium small batch** (1× 40%, 10× 32%).

### Part linkage

- `parts.markup_rate_id uuid REFERENCES markup_rates(id) ON DELETE SET NULL`
- Index: `idx_parts_markup_rate_id`
- Applying a rate to a part materializes the rate's breakpoints into `part_pricing_tiers` **and** sets `parts.markup_rate_id` — a live link, not a detached copy. The link drives the UI ("Markup: <RateName>" chip) and is what makes an edit to the rate cascade back to the part. `ON DELETE SET NULL` means deleting the rate breaks the link while leaving those materialized tiers (the part's last-applied markup) in place.

---

## Pages

### List — `/dashboard/{companyId}/markup-rates`

AG Grid with columns:

- **Name** (pinned left, 240px)
- **Breakpoints** (flex; monospaced mini-list rendering each `qty: markup%` line)

Row height is dynamic (24px base + 16px per breakpoint line). The default rate is pinned to the top and non-selectable — instead of a checkbox it shows a **"Default"** chip.

**Search:** name only, debounced 300ms.

**Actions:**
- Click / Enter on a row → edit (`/markup-rates/{rateId}/edit`)
- New → `/markup-rates/new`
- Bulk delete (confirmation copy explains parts keep their last-applied tiers once the link is severed)
- Export CSV from selection

**Empty states:** "No rates yet" when the table is empty; a warning banner reading "No default rate set" when rates exist but none has `is_default=true`.

### Create / Edit — `/markup-rates/new` and `/markup-rates/{rateId}/edit`

The same `MarkupRateForm` component in `mode="create" | "edit"`. Fields:

- **Name** — required, validated unique-per-company via `checkMarkupRateNameExists`
- **Breakpoints table** — qty (int > 0) and markup_percent (number); add/remove rows; auto-sorted by qty on save
- **Is default** — toggle; promoting to default demotes the previous default in the same transaction (`clearOtherDefaults` in the access layer)

Save triggers `createMarkupRate` or `updateMarkupRate`.

---

## Behavior

- **Edit cascades to linked parts.** Updating a rate's breakpoints triggers `cascadeRateUpdateToParts(companyId, rateId)` — it re-derives each linked part's pricing tiers from the new breakpoints (sequential per-part, collecting per-part failures). This is the live-link half of the semantic: an edit to the rate flows through to every part whose `markup_rate_id` points at it.
- **Delete breaks the link, keeps the value.** Deleting a rate clears the FK on parts (`ON DELETE SET NULL`) but leaves their pricing tiers intact — each affected part stays on its last-applied markup, just no longer linked to any rate. The UI confirmation message reflects this: "Parts that previously had a deleted rate applied keep their pricing tiers."
- **Auto-apply default on new parts.** Part creation invokes `applyDefaultRateToPart(companyId, partId)`. Non-fatal: if no default rate exists or it has empty breakpoints, the part is created without tiers.
- **Bulk apply.** From the Parts list, a multi-select bulk action calls `bulkApplyMarkupRate(companyId, partIds, rateId)` via the `bulk_apply_markup_rate` RPC, 200 parts per chunk, with a progress callback. Returns `{updated, failed[], priceUncomputed}`.

---

## Access Layer

`utils/markupRatesAccess.ts`:

| Function | Purpose |
|---|---|
| `getAllMarkupRates(companyId)` | List, ordered by name |
| `getMarkupRate(rateId)` | Single rate |
| `getDefaultMarkupRate(companyId)` | The default, or null |
| `createMarkupRate` / `updateMarkupRate` | Mutations; handle default promotion atomically |
| `applyRateToPart(companyId, partId, rateId)` | Copy breakpoints → `part_pricing_tiers`, set `parts.markup_rate_id` |
| `applyDefaultRateToPart(companyId, partId)` | Auto-apply default at part creation |
| `cascadeRateUpdateToParts(companyId, rateId)` | Per-part re-apply after a rate edit |
| `bulkApplyMarkupRate(companyId, partIds, rateId)` | Chunked RPC, 200/chunk, progress callback |
| `deleteMarkupRate`, `bulkDeleteMarkupRates` | Deletes (FK is `SET NULL`, no cascade block) |
| `normalizeBreakpoints` (helper) | Sorts by qty, drops non-positive entries |

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #346.

**List, search & filter**

- [ ] **Given** a company's markup rates, **when** the list loads, **then** rates come back scoped to `company_id` and ordered by name ascending — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'getAllMarkupRates' > 'selects from markup_rates filtered by company_id and ordered by name'`*.
- [ ] **Given** the loader returns no rows, **when** the list resolves, **then** the page renders an empty array rather than throwing — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'getAllMarkupRates' > 'returns [] when supabase returns null data'`*.
- [ ] **Given** the list, **when** the user types in the search box, **then** only non-default rates whose name contains the query (case-insensitive, 300ms-debounced) remain — *manual: search state in `app/dashboard/[companyId]/markup-rates/page.tsx` (`filteredRates`); automation-pending*.
- [ ] **Given** a company with a default rate, **when** the grid renders, **then** the default is pinned to the top, is non-selectable, and shows a **"Default"** chip in place of the row checkbox — *manual: `SelectionCellRenderer` + `pinnedTopRowData` in `app/dashboard/[companyId]/markup-rates/page.tsx`; automation-pending*.
- [ ] **Given** a company that has rates but none flagged `is_default`, **when** the list loads, **then** a "No default rate set" warning banner appears — *manual: `!defaultRate && rates.length > 0` banner in `app/dashboard/[companyId]/markup-rates/page.tsx`; automation-pending*.
- [ ] **Given** a company with no rates, **when** the list loads, **then** a "No markup rates yet" empty state with a **New Rate** call-to-action appears — *manual: empty-state card in `app/dashboard/[companyId]/markup-rates/page.tsx`; automation-pending*.

**Create (create -> save -> reload -> persists)**

- [ ] **Given** the New Rate form, **when** the user enters a name plus at least one `(min qty, markup %)` breakpoint and saves, **then** a `markup_rates` row is inserted and reloading the list shows it — *write path automation-pending (`createMarkupRate`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** a name already used by another rate in the company, **when** the user tries to save, **then** an inline "A rate with this name already exists." error blocks the write — *existence check verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'checkMarkupRateNameExists' > 'returns true when count > 0'`; the (company_id, name) unique constraint is the server-side backstop; form wiring automation-pending*.
- [ ] **Given** breakpoints entered out of order or with non-positive / non-finite quantities, **when** the rate is saved, **then** the stored array is floored-to-int, positive-only, and sorted by qty ascending — *automation-pending (`normalizeBreakpoints`)*.

**Edit (edit -> save -> reload -> persists)**

- [ ] **Given** an existing rate, **when** an admin edits its name and/or breakpoints and saves, **then** reloading the edit page shows the persisted values — *write path automation-pending (`updateMarkupRate`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** a non-default rate, **when** the admin flips the "Set as default rate" switch, **then** it becomes the default and the previously-default rate is demoted (partial unique index `markup_rates_one_default_per_company` keeps it to one per company) — *automation-pending (`clearOtherDefaults` invoked from `updateMarkupRate`)*.
- [ ] **Given** a rate linked to parts, **when** the admin edits its breakpoints and saves, **then** every part whose `markup_rate_id` points to it has its pricing tiers re-derived from the new breakpoints — *automation-pending (`cascadeRateUpdateToParts`)*.

**Apply to parts**

- [ ] **Given** a company with a default rate, **when** a new part is created, **then** the default's breakpoints are materialized into the part's `part_pricing_tiers` and `parts.markup_rate_id` is linked to the default (a live link, so later edits to the default cascade to the part); **when** no default exists (or it has no breakpoints), the part is created without tiers (non-fatal) — *default lookup verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'getDefaultMarkupRate' > 'queries by company_id + is_default=true'`; apply path automation-pending (`applyDefaultRateToPart`)*.
- [ ] **Given** the parts list with parts multi-selected, **when** the user opens the "Set markup rate" dialog, **then** rates load and the default is auto-selected each time the dialog (re)opens — *verified by `__tests__/components/parts/BulkApplyMarkupRateDialog.test.tsx > 'BulkApplyMarkupRateDialog — load + auto-select on (re)open' > 'reloads rates and re-selects the default each time it reopens'`*.
- [ ] **Given** a chosen rate and a set of parts, **when** bulk-apply runs, **then** per-chunk RPC results (updated / priceUncomputed / failed) are aggregated across 200-part chunks — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'bulkApplyMarkupRate' > 'aggregates RPC results across chunks'`*.
- [ ] **Given** a chunk whose `bulk_apply_markup_rate` RPC errors, **when** bulk-apply processes it, **then** every part in that chunk is recorded as failed and the batch keeps going — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'bulkApplyMarkupRate' > 'records every part in a chunk as failed when the RPC errors'`*.
- [ ] **Given** an empty part-id list, **when** bulk-apply is called, **then** it short-circuits without hitting the RPC — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'bulkApplyMarkupRate' > 'short-circuits on empty partIds without calling RPC'`*.

**Delete**

- [ ] **Given** selected rate(s) on the list, **when** the user confirms bulk delete, **then** the rows are deleted via `.in('id', [...])` and the confirmation copy states that parts keep their pricing tiers — *delete call verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'bulkDeleteMarkupRates' > 'deletes using .in(id, [...])'`; the FK `ON DELETE SET NULL` behavior (tiers survive) is schema-enforced, reload-persistence automation-pending (#367)*.
- [ ] **Given** a single rate on its edit page, **when** the user confirms delete, **then** the rate is removed by id — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'deleteMarkupRate' > 'deletes by id'`*.
- [ ] **Given** an empty id list, **when** `bulkDeleteMarkupRates` is called, **then** it short-circuits and never touches the table — *verified by `__tests__/utils/markupRatesAccess.test.ts > 'markupRatesAccess' > 'bulkDeleteMarkupRates' > 'short-circuits on empty input'`*.

**Selection & export**

- [ ] **Given** one or more selected (non-default) rows, **when** the user clicks Export, **then** the selection is exported to CSV; the Export button is hidden when nothing is selected — *manual: `ExportCsvButton` gated on `selectedIds.length > 0` in `app/dashboard/[companyId]/markup-rates/page.tsx`; automation-pending*.

## See also

- [Parts](parts.md) — markup rates materialize part pricing tiers.
- [Quotes](quotes.md) — quote line items snapshot pricing tiers; markup-rate identity is not preserved on the quote line.
