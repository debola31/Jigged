# Plan — derive select result types instead of hand-writing them

**Status: proposed, not started.** This is the direction that replaces "delete
[`scripts/schemaEmbedCheck.ts`](../../scripts/schemaEmbedCheck.ts)", which was proposed on a
premise that turned out to be false. Everything below was measured on 2026-08-07 against
`@supabase/postgrest-js` 2.105.1; the measurements are quoted so the next person can re-run them
rather than trust them.

Contract this serves: [architecture.md §6.1](../architecture.md).

---

## 1. The problem, stated correctly

A PostgREST `.select()` string can reference a column that no longer exists. Three mechanisms
could catch it, and it matters which one actually does.

**`tsc` catches more than the repo believed.** The record said supabase-js's type-level parser
"silently widens" past some breadth/depth, and that `QUOTE_DETAIL_SELECT` therefore "produces
nothing". Re-measured: the parser resolves that select fully and yields

```
SelectQueryError<"column 'bogus_quote_col' does not exist on 'customer_contacts'.">[]
```

three levels down. Nothing widens.

**What actually silences it is how we consume the row.** `SelectQueryError<M>` is
`{ error: true } & M` — a *type*, not a compile error. It fails a build only where type-checked
code reads that field. Every access function casts instead, and whether the cast surfaces the
error is decided by the hand-written target type:

| Site | Cast | Target type declares relations | Injected bad column |
|---|---|---|---|
| [`jobsAccess.ts:283`](../../utils/jobsAccess.ts) | `data as JobWithRelations` | **required** | **`tsc` errors** |
| [`quotesAccess.ts:333`](../../utils/quotesAccess.ts) | `data as QuoteWithRelations` | **optional** (`customers?`, `customer_contacts?`) | silent |

One `?` is the entire difference. An `as unknown as` row cast erases it unconditionally.

So drift detection is currently a property of how permissively someone hand-wrote a type years
ago — not a guarantee, and invisible at the call site.

## 2. The fix

Stop hand-writing result shapes. Derive them:

```ts
import type { QueryData } from '@supabase/supabase-js';

const jobDetailQuery = (id: string) =>
  getSupabase().from('jobs').select(`…`).eq('id', id).single();

export type JobDetail = QueryData<ReturnType<typeof jobDetailQuery>>;
```

The derived type is exact by construction, so a dropped column can no longer be absorbed by a
permissive hand-written shape.

**Viability — measured, 313 select sites enumerated.** `QueryData` resolves the deepest and
widest selects in the repo with no `TS2589`, including `QUOTE_DETAIL_SELECT`,
`QUOTE_LIST_SELECT` (with `{ count: 'exact' }`), the 4-level `getJobWithRelations` select
([`jobsAccess.ts:248`](../../utils/jobsAccess.ts), 820 chars),
[`shipmentsAccess.ts:192`](../../utils/shipmentsAccess.ts), and ShipmentForm's job embed.
`${…}` interpolation is preserved as a template-literal type — **no `as const` needed**.

Two limits, both real:

- **Four selects are built with string `+` concatenation, which widens the argument to `string`.**
  postgrest-js's `Query extends string` then collapses and `QueryData` degrades to
  `GenericStringError[]` — with no error at the definition. These are **unvalidated today too**,
  for the same reason, which makes them a finding in their own right rather than migration debt:
  [`operatorAccess.ts:1966`](../../utils/operatorAccess.ts) (1,129 chars — the largest select in
  the repo), [`operatorAccess.ts:2216`](../../utils/operatorAccess.ts),
  [`dashboardAccess.ts:665`](../../utils/dashboardAccess.ts),
  [`inventoryLocationsAccess.ts:853`](../../utils/inventoryLocationsAccess.ts). Fix is mechanical
  — join the fragments into one template literal; the cost is the inline `//` comments between
  the `+` operands, which move above the call. That is the complete set (a scan for `let`-declared,
  `: string`-annotated, ternary and call-expression select arguments found no others).
- **`TS2589` is absent at the `QueryData` boundary but returns one derivation later.** A recursive
  helper over a deep derived row (`DeepPartial<…>`, a recursive `NonNullable` map) does blow the
  instantiation limit. Non-recursive derivations (`Pick`, `Omit`, `Paths`) are fine. Don't build
  recursive utility types on these rows.

## 3. What this does NOT buy — read before deleting anything

**Keep `schemaEmbedCheck.ts`.** The earlier plan had it deleted at the end of this migration.
That is wrong, and the reason is the most important sentence in this document:

**Foreign-key hints are not type-checked at all.** Measured:

```ts
from('jobs').select('id, notes!notes_TOTALLY_MADE_UP_fk(id, body)')
// infers: { id: string; notes: { id: string; body: string | null }[] }[]
// zero tsc errors, even when every field is read. PostgREST 400s at runtime.
```

On a hint miss, postgrest-js's `FindMatchingHintTableRelationships` falls back to matching by
relation *name* instead of emitting an error, so a fabricated hint compiles to a plausible type —
byte-identical to the correct-hint type when the relation is to-many by name anyway. There are 16
live non-keyword hints in `utils/`, across two naming conventions (`_fkey` on older tables, `_fk`
on newer), and a fabricated hint has already reached a preview deploy once. The scanner's
`unknown-constraint` check is the only thing in this repo covering that class.

Second, smaller: **a derived type is a derivation, not an assertion.** A `SelectQueryError` inside
one still only fails the build at a type-checked *read*. Reading a sibling field, `JSON.stringify`,
or `.length` all stay silent, and `__tests__` is excluded from `tsconfig`, so a test-only read
never counts. One live instance today: `shipment_line_items.shipment_id`
([`shipmentsAccess.ts:130`](../../utils/shipmentsAccess.ts), `:206`) is embedded and read nowhere
outside the hand-written type this migration would delete.

What the migration *does* subsume are the scanner's two documented blind spots: bare top-level
columns (skipped by design) and `${…}` interpolations (skipped with a warning).

## 4. Cost — where it actually is

**Not in shared types.** The intuition was that the expensive cases are types serving several
different selects. Measured, that is rare: of the types checked, only `JobWithRelations`
(list vs detail) and `QuoteWithRelations` (`QUOTE_LIST_SELECT` vs `QUOTE_DETAIL_SELECT`) genuinely
span different shapes, and splitting them into per-select aliases does **not** remove the cast.

**The cost is per-type divergence between the hand-written type and what any select can return.**
Four classes, each needing a decision per type:

| Class | Example |
|---|---|
| enum/text narrowing | generated `string` → `ProductionStatus`, `FreightTerms`, `WorkCenter['kind']` |
| `jsonb` narrowing | generated `Json` → `AddressSnapshot`, `ContactSnapshot`, `PricingBasisSnapshot` |
| nullability tightening | `created_at: string \| null` generated vs `string` hand-written |
| hydrated non-DB fields | `completed_by_name`, `match_source`, `created_by_member`, `primary_contact` |

The idiom for the first two already exists — narrow one field at the boundary
(`toCreditStatus` in [`customerAccess.ts`](../../utils/customerAccess.ts),
`toBillToParty` in [`customerCarrierAccountsAccess.ts`](../../utils/customerCarrierAccountsAccess.ts)).
Hydrated fields become an intersection: `QueryData<…>[number] & { completed_by_name: string | null }`.

**Consumer count is a poor proxy for cost.** The hand-written name can be retained as an alias
(`export type JobWithRelations = QueryData<…>[number] & {…}`), so consumers change only where the
inferred shape genuinely differs.

**Scale.** `utils/` holds ~176 cast expressions. The high-count types are mostly *single-shape* and
therefore the easy ones: `PartRow` (13), `WorkCenter` (7, all on one `WORK_CENTER_COLUMNS`),
`InventoryLocation` (6), `Vendor` (5), `CustomerAddress` (4), `CompanyMember` (4),
`VendorContact` (4). Out of scope entirely: RPC-result casts (`StockMutationResult`,
`TransferResult`, `PutAwayResult`) — those functions are declared `Returns: Json`, which `QueryData`
cannot reach.

## 5. Staging

Each step is independently shippable and independently valuable. **Steps 1-2 are worth doing even
if the rest is never scheduled.**

| # | Step | Why it stands alone |
|---|---|---|
| 1 | Respell the 4 `+`-concatenated selects as single template literals | They are unchecked *today*; this alone puts them under the type parser |
| 2 | Add a type-checked read (or a derived-type assertion) for `shipment_line_items.shipment_id` | Closes the one live never-read embed column |
| 3 | Migrate one single-shape type end-to-end — **`WorkCenter`** — as the reference commit | 7 sites, one select constant, no sharing; proves the idiom and the narrowing pattern |
| 4 | Sweep the remaining single-shape types (`PartRow`, `InventoryLocation`, `Vendor`, `CustomerAddress`, `CompanyMember`, `VendorContact`) | Mechanical once step 3 fixes the idiom |
| 5 | `JobWithRelations` and `QuoteWithRelations` — the two genuinely multi-shape types | Hardest; do last, with the alias trick to spare consumers |
| 6 | Slim `schemaEmbedCheck.ts` to the FK-hint check only, *if* step 4-5 leave every embed column with a type-checked reader | **Conditional.** Do not do this speculatively |

Verification at every step: `pnpm exec tsc --noEmit -p tsconfig.json`, `pnpm lint`,
`pnpm test --run`. Step 3 additionally wants `pnpm exec vitest run __tests__/schema/embedCheck.test.ts`
to confirm the scanner still passes on the rewritten constants.

**Regression check that proves each step worked** — inject a bogus column into the migrated
select, confirm `tsc` now fails *without* any cast in the way, revert. If it does not fail, the
step did not achieve anything, whatever the diff looks like.

## 6. Open question for whoever picks this up

Steps 3-5 are a lot of mechanical work whose payoff is "a class of silent bug becomes loud". The
honest alternative is to do steps 1-2 (which fix live gaps), keep the scanner as-is, and stop.
That is a defensible place to stop, and better than starting step 5 and abandoning it halfway —
a half-migrated type is worse than either end state, because the alias hides which half you are in.
