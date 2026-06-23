# Markup Rates Module

## Overview

A **markup rate** is a named pattern of quantity break-points + markup percentages that can be applied to a part to materialize its pricing tiers. The resulting tiers resolve to a sell price for **both made and bought parts** — markup is applied to the routing/BOM cost for made parts and to the procurement-tier cost for bought parts. Markup rates are company-scoped, snapshot-applied (deleting the rate keeps the tiers it produced), and one rate per company can be marked as the default for new parts.

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

Per-company seeded patterns (from migration 20260428): **Default** (1× 25%), **Volume tiers** (1× 25%, 10× 22%, 100× 18%, 1000× 15%), **Premium small batch** (1× 40%, 10× 32%).

### Part linkage

- `parts.markup_rate_id uuid REFERENCES markup_rates(id) ON DELETE SET NULL`
- Index: `idx_parts_markup_rate_id`
- When a part is linked to a rate, the rate's breakpoints are **copied** into `part_pricing_tiers` (snapshot semantics). The link itself is for UI ("Markup: <RateName>" chip) and for re-applying the rate when its breakpoints change.

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
- Bulk delete (with snapshot-semantics confirmation copy)
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

- **Snapshot semantics on delete.** Deleting a rate clears the FK on parts (`ON DELETE SET NULL`) but leaves their pricing tiers intact. The UI confirmation message reflects this: "Parts that previously had a deleted rate applied keep their pricing tiers."
- **Re-apply on edit.** Updating a rate's breakpoints triggers `cascadeRateUpdateToParts(companyId, rateId)` — sequentially copies the new breakpoints into each linked part's pricing tiers and collects per-part failures.
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

## See also

- [Parts](parts.md) — markup rates materialize part pricing tiers.
- [Quotes](quotes.md) — quote line items snapshot pricing tiers; markup-rate identity is not preserved on the quote line.
