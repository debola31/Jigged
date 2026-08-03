# Design System

> **Condensed 2026-08-03 · 4,546 → 4,079 words (`wc -w`).** Cut: ~1,400 words restating CLAUDE.md
> (principles 1–5, component-usage rules, list/create-edit/import layouts, mobile requirements,
> WCAG); the ~450-word theme-provider example and the `WorkOrderCard` sample; pasted
> `<Card>`/`<TextField>` snippets; the unused MUI 0–24 elevation ladder; a Do's/Don'ts list that
> repeated CLAUDE.md. Roughly **950 words of new, code-verified correction** went back in, which is
> why the net cut is modest — the pre-correction equivalent is ~3,130. Kept deliberately: every
> withdrawn argument, every measured value, every citation.
>
> **Nine corrections, marked inline.** Largest: the steel-blue-centre gradient this doc called
> "CRITICAL … must be present on all pages" was removed app-wide for a 4.11:1 contrast failure; the
> drawn storage board behind "tile-and-sheet" was deleted in `db58ae8`; and the pasted `statusColors`
> map named nine job statuses that do not exist.
>
> **Values live in [`lib/theme.ts`](../lib/theme.ts).** This file holds rationale and the decisions
> no token can express. Delegated: principles / component usage / list-create-import layouts /
> mobile / WCAG → [CLAUDE.md](../CLAUDE.md#design-system-jigged-manufacturing-data-platform-material-ui);
> destructive actions + saving → [interaction-standards.md](interaction-standards.md); logo,
> marketing palette, voice → [brand-guide.md](brand-guide.md).

Material-UI **v7.3.6** *(this doc previously said "MUI v5+")*, Material Design 3, single dark theme,
no light/dark toggle. The dark theme is the one visual decision carrying direct user validation — a
manufacturing user's verdict on it was *"pretty fucking awesome"* — which is why there is no toggle
and no second theme to keep in sync.

---

## The app canvas

*(Corrected 2026-08-03. This doc specified `linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439
100%)` as "CRITICAL", "the visual signature", "must be present on all pages", and claimed it matched
`lib/theme.ts`. It was replaced app-wide.)*

**Withdrawn:** the steel-blue-centre canvas gradient (`#4682B4` at 50%) — wrong because white body
text directly on the steel measured **4.11:1** app-wide. The deep-indigo base restores **15:1+**.

Two layers, both `backgroundAttachment: fixed` — the canvas stays put rather than repainting on every
scroll frame:

| Layer | Where | What |
|---|---|---|
| **Global substrate** | [`ThemeProvider.tsx`](../components/providers/ThemeProvider.tsx) | `#111439` + `linear-gradient(135deg, #111439 0%, #1a1f4a 50%, #111439 100%)` + one steel `radial-gradient` whose centre is pushed off-screen above the fold. Marketing pages keep this bare. |
| **Workspace canvas** | [`AppAmbientBackdrop.tsx`](../components/layout/AppAmbientBackdrop.tsx) — `fixed`, `aria-hidden`, `pointer-events: none` | A lit steel-indigo `linear-gradient(158deg, …)` + a steel aurora off the top-right and a teal one off the bottom-left. Dashboard and operator shells only. |

Constraints, each preventing a specific failure:

- **Auroras fade to zero-alpha of their own colour, never to `transparent`** — `transparent` is
  transparent *black*, so the interpolation bands a lighter grey mid-fade. Exactly the bug the
  rewrite fixed.
- **The lightest point stays under the contrast threshold.** Grey secondary labels on bare canvas
  keep ~**5.9:1**; the top-right bloom tops out around `#426289` (white ≈ **6.4:1**), and that corner
  carries white text/icons only.
- **The bar is set by the room, not the desk.** Shop floors run **500–1000 lux** of fluorescent
  light and the operator surface is a phone held under it, so contrast that merely passes in a dim
  office fails where the app is actually read. Treat the numbers above as hard limits, not WCAG
  minimums to squeak past.
- **Deliberately 2D** — no 3D scene, no looping video behind live data; both read as distracting.
  The marketing hero keeps its own video. Cost evidence against real 3D:
  [`inventory.md` §5.5](modules/inventory.md#55-locations-keep-them-visual-change-when-they-appear)
  (#421 spike).
- **Opaque cards are the readability firewall** — what lets the canvas be rich at all.

The **brand** gradient is a separate artifact:
[`marketingStyles.ts`](../components/marketing/marketingStyles.ts) `BRAND_GRADIENT`
(amber → steel → teal), [brand-guide.md §3](brand-guide.md). Gradient *text* is for large display
type only — a left-to-right sweep passes through its steel stop (≈4.3:1) and fails small-text
contrast, so eyebrows use solid `EYEBROW_COLOR` `#7FB3E0` (8:1 on indigo).

**Known leftover:** [the operator login page](../app/operator/[companyId]/login/page.tsx) still
paints the retired steel-centre gradient — not a contrast failure (its text sits on an opaque
`rgba(17,20,57,0.95)` Paper), but the one surface out of step.

## Glass cards

`MuiCard` defaults to `elevation={2}`; the theme does the rest. Just write `<Card>`.

| Token | Value | Why |
|---|---|---|
| Background | `rgba(32, 38, 82, 0.78)` | A **deep** indigo panel — a pale surface on the lit canvas goes washed-out/muddy. White text sits ~**13:1**. |
| Blur | `blur(15px)` (+ `WebkitBackdropFilter`) | Frosted, so the lit canvas glows through faintly. |
| Border | `1px solid rgba(255,255,255,0.20)` | The hairline does edge definition, not a lightness step. **0.18 nearly vanished** on the dark canvas; **0.28**, crisp on a small card, read as a bright frame around full-width tables (Jobs/Parts/Quotes wrap an AG Grid in a Card, so that Card edge *is* the table's outer border). AG Grid's internal row lines keep a fainter **0.12** ([`agGridTheme.ts`](../lib/agGridTheme.ts)). |

*(The `lib/theme.ts` header comment still quotes the pre-rewrite "Card Opacity (0.55)" / "border rgba
white 0.15"; the `MuiCard` block below it is authoritative.)*

Elevations in use: **0, 1, 2** (default), **3** (auth/emphasis), **4** (`/admin` AppBar). 5–24 unused;
dialogs and menus get solid `#111439` / `#1a1f4a` overrides instead.

---

## Buttons

**Every button answers two questions: what rank is it (→ `variant`), and is it destructive
(→ `color`)?** Those are the only two axes. Do **not** reach for `success` / `warning` / `info`
*fills* to brighten an ordinary action — those are status-chip colours (see
[Status Colors](#status-colors)); on an action button they mislead. A green button reads as *already
done* — exactly the trap we hit with green "Complete" / "Mark Received" buttons.

`color` is almost always **omitted** (theme default `primary`). `size="large"` is never needed — the
theme floors every button at a **48px** touch target.

| Rank | Style | Use for |
|---|---|---|
| **Primary** | `variant="contained"` (blue) | The main action on the surface: Save, Create, Add, Submit, Convert, Mark Complete, Mark Received, Record |
| **Secondary** | `variant="outlined"` (white-on-transparent) | Alternate / less-committing actions: Import, Edit, empty-state CTAs |
| **Tertiary / dismiss** | `variant="text"` | Cancel, Back, Close, Skip, Undo |

**Destructive → `color="error"` (red), always.** Delete / Remove-record / Cancel-job / Void /
Disconnect / Logout: `contained error` for the final confirm, `outlined` / `text error` at rest. Use
[`DeleteIconButton`](../components/common/DeleteIconButton.tsx) for the trash affordance —
[interaction-standards.md §1](interaction-standards.md#1-destructive-actions-delete--remove).

**Theme overrides that keep the ranks legible on the canvas** (`MuiButton`): `outlined` is
transparent with a **35%** white border and **85%** white text, hover brightening the border to
**60%**; `text` uses `primary.light` `#6FA3D8` with underline-on-hover, a lighter blue that holds
against both the dark and steel-lit portions. Consequence: **outlined and text buttons are re-coloured
by the theme regardless of `color`** — which is why the sanctioned outlined exceptions below pass the
CI scan automatically.

**Grouped secondary actions share one variant** — never an `outlined` beside a `text`. Rank within
the set by order, weight, an icon, or a count, not by giving one a border and the other none.

### Sanctioned semantic-colour exceptions

- **Send-to-vendor waypoint** — "Mark Sent Out" is `outlined color="warning"`: a reversible "parts
  left the shop" step, deliberately amber, paired with a blue primary "Mark Received"
  ([`OutsideWorkPanel`](../components/jobs/OutsideWorkPanel.tsx),
  [`OperationCard`](../components/jobs/OperationCard.tsx)).
- **Fill state** — `success.main` for "has stock", a hollow `text.disabled` outline for "empty"
  (`FillDot`, a 7px dot). Read as *status*, not good/bad: an empty bin isn't a failure, it's the
  [two-bin kanban](https://businessmap.io/blog/two-bin-kanban-system) signal that something needs
  ordering. **Never a percentage or a gauge** — we do not know a shelf's capacity, so "72% full"
  would be an invented number carrying the confidence of a measured one. Binary is the honest
  resolution; [`inventory.md` §5.5](modules/inventory.md#55-locations-keep-them-visual-change-when-they-appear)
  decision 5. *(`display: inline-block` on that dot is load-bearing: a bare `<span>` defaults to
  `display: inline`, ignores width/height, and renders at zero width while every unit test passes —
  jsdom has no layout engine.)*
- ~~Segmented mode selectors may colour options semantically (add = success / remove = error /
  adjust = info)~~ — **removed 2026-08-03: no such control exists.** The stock verbs are buttons, not
  a `ToggleButtonGroup`, and the repo's only coloured `ToggleButton` is `value="confirm"` on the
  vendor-import screen. Unbuilt, not a standing exception.

### Subtractive vs destructive

**No stock verb is red** (revised 2026-07-29). **Withdrawn:** "Remove is `color="error"` because it
is subtractive" — wrong because *subtractive* describes the arithmetic and *destructive* describes
the risk, and the headline question is the second. Removing stock is reversible and **writes** an
append-only ledger row rather than destroying one. And red is simultaneously our enforced Delete
colour: painting the module's most-pressed button red spends the danger signal on a routine act, the
way an alert that fires on every row stops being an alert.

**Order is fixed; weight varies.** The four always appear as **Add, Remove, Move, Adjust**, on every
surface, all `variant`-only — one `contained`, the rest `outlined`, none carrying a `color`. Which is
filled is decided by frequency per surface, and is *not* a property of the verb:

| Surface | Primary | Why |
|---|---|---|
| Operator bin view ([`…/inventory/locations/[locationId]/page.tsx`](../app/operator/[companyId]/inventory/locations/[locationId]/page.tsx)) | **Remove** | Stock arrives in bulk once (really receiving's job, J6) and leaves in small amounts on every job, all shift |
| Admin part page ([`PartLocationInventory`](../components/parts/PartLocationInventory.tsx)) | **Add** | Until J6 exists this is how stock gets in, and an owner here isn't the one consuming it |

**Do not reorder to emphasise.** Consistency governs *recognition* — where a control is, what it's
called, what it does — and that must not move. Emphasis governs *intent*, legitimately different for
an operator at a shelf and an owner at a desk. Stable position is what a daily user's hand learns;
the filled button is what a first-timer's eye finds. Red still means destructive on these pages — the
part's Delete (archive) affordance.

### Enforcement

[`scripts/interactionStandardsCheck.ts`](../scripts/interactionStandardsCheck.ts) fails CI on any
`contained <Button>` with a `success` / `warning` / `info` fill (`button-color` rule), any
value-shaped placeholder (`placeholder` rule), and any grey delete icon (`grey-delete` rule).
`color={expr}` is left to review. Genuine exceptions go in that scanner's `ALLOWLIST` (currently
empty).

Tests — [`__tests__/standards/interactionStandards.test.ts`](../__tests__/standards/interactionStandards.test.ts):
`interactionStandardsCheck — button-color rule` (5 it) ·
`interactionStandardsCheck — placeholder rule` (4 it) ·
`interactionStandardsCheck — grey-delete rule` (3 it) ·
`interactionStandardsCheck — repo is clean` (1 it).

---

## Callouts & insets (no decorative accent borders)

Define a callout / inset (instructions, notes, highlighted rows) with a **subtle full border**
(white ~8%) and/or a neutral translucent background — the same "subtle white border defines edges"
treatment cards use. **Do not** use a decorative coloured side-accent (e.g. a 3px `primary.main` left
stripe): it reads as generic, templated web styling and cuts against "substantial, not playful —
industrial". Reserve a coloured border for a *semantic* signal (a red edge on an alert state), never
as decoration.

```tsx
// ✅ neutral inset
<Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
           border: '1px solid rgba(255,255,255,0.08)' }}>…</Box>

// ❌ decorative coloured side-accent
<Box sx={{ borderLeft: '3px solid', borderColor: 'primary.main' }}>…</Box>
```

`automation-pending (#367)` — unenforced.

## Form validation & required-field feedback

When a submit/save button is disabled because the form is incomplete, **tell the user what's still
missing** — a greyed-out button with no explanation is a dead end. The standard is an inline notice,
**not** a hover tooltip.

> **Withdrawn (2026-07-31, rule unchanged):** "hover is unavailable because the app runs on shop-floor
> tablets" — wrong because forms are an **admin-surface** concern (office computer, mouse), so hover
> *is* available; see [the device model](../CLAUDE.md#who-uses-what-on-what--the-device-model). The
> rule stands on the stronger argument it always had: a hover tooltip is **undiscoverable** (you must
> already suspect there is something to hover over) and **unreachable by keyboard**. True of a mouse
> user at a desk too. *(The docstring inside `MissingFieldsNotice.tsx` still carries the withdrawn
> tablet reason.)*

- **[`MissingFieldsNotice`](../components/common/MissingFieldsNotice.tsx)** — render just above the
  submit button with an `items: string[]` of blocking reasons (returns `null` when empty), computed
  from the same conditions that drive the button's `disabled`. Callers:
  [`FeedbackDialog`](../components/feedback/FeedbackDialog.tsx),
  [`UnitOfMeasurementSelect`](../components/parts/UnitOfMeasurementSelect.tsx),
  [`ConflictDialog`](../components/import/ConflictDialog.tsx). *(This doc cited `ConvertToJobModal`,
  `MaterialRowEditor` and `CompanyShippingSettingsCard`; the first two exist but don't use the
  notice, the third never existed.)*
- **Field-level markers** — also set `required` and `error`/`helperText` on the blocking inputs, so
  the error is visible at the field, not only in the summary.
- **Typed inputs** — validate with [`lib/validators`](../lib/validators.ts) (`isValidEmail`,
  `isValidPhone`, `isValidPostalCode`, `parseOptionalNumber`, `parseOptionalInteger`,
  `normalizePhone`, `numberToInputString`); never re-implement an email regex or number parser per
  form. Phone fields use `type="tel"`; numeric fields set `inputMode` (`'numeric'` / `'decimal'`).
- **Addresses** — [`CountrySelect`](../components/common/CountrySelect.tsx) +
  [`StateSelect`](../components/common/StateSelect.tsx) (US states / CA provinces, free-text fallback
  elsewhere), never free-text country/state. City stays free text; validate postal codes per country.

### Placeholders

**A placeholder must never resemble real data.** Our users are 50–60 year old shop owners; a greyed
`25` in an empty Markup % field reads as a *pre-filled value*, not a hint, and ships wrong quotes.
**Withdrawn:** the original wording justified this "on tablets" — wrong about the device and
irrelevant to the point, which is how a low-contrast number reads to anyone.

**Banned:** bare numbers (`placeholder="1"`, `"25"`); currency/value-shaped strings
(`"$0.00"`, `"e.g. 5.50"`) or any computed value (`placeholder={suggestedUnitPrice}`). These fields
already carry a column header or `label`, so the placeholder adds only confusion — prefer `label` +
`helperText`.

**Allowed** — placeholders that can't be mistaken for entered data: search prompts
(`"Search parts…"`), true format hints (`"customer@example.com"`, `"Suite, unit, etc."`), action
prompts (`"Note about this part…"`).

Enforced — see [Enforcement](#enforcement) above.

### Status Badges

**Use [`StatusChip`](../components/common/StatusChip.tsx) for every on/off/lifecycle status badge —
never a hand-rolled `<Chip variant=…>`.** It derives the variant so status chips look identical
everywhere (previously inconsistent: QuickBooks "Connected" was filled while Billing "Active" was
outlined):

- a **semantic colour** (`info` / `success` / `warning` / `error` / `primary` / `secondary`) → **filled**
  (draws the eye: Active, Connected, Trial, Overdue…);
- the neutral **`default`** → **outlined** (de-emphasised "off" states: No subscription, Not
  connected, Not set up).

Pass the semantic `color`; `size="small"` is the default. Enforcement is the component itself
(`variant` is not an accepted prop) — `automation-pending (#367)` for a lint against raw `<Chip>`.

**Exempt (intentionally custom, do not force onto `StatusChip`):** chips with a bespoke palette for a
domain reason — stock level ([`StockStatusChip`](../components/inventory/StockStatusChip.tsx)), part
classification ([`PartClassificationChips`](../components/parts/PartClassificationChips.tsx)),
work-centre kind — and the `HOT` rush badge ([`JobHotBadge`](../components/jobs/JobHotBadge.tsx)),
which deliberately mutes to outlined for historical jobs. These use custom hex/rgba, not the semantic
palette, and are not on/off status badges.

### Tabs vs. segmented toggles (role-based)

Pick by **what the control does**, not by preference:

- **MUI `Tabs`** (underline indicator) — **switching between named content views** of a section:
  Admins / Users / Operators on Team; Internal / External on Work Centers; Directory / Outside work
  on Vendors; the part-workspace sections ([`PartHeaderBar`](../components/parts/workspace/PartHeaderBar.tsx)).
  Use `icon` + `iconPosition="start"`. Scales to 3–5 views.
- **MUI `ToggleButtonGroup`** (segmented pill) — a **compact binary/ternary mode or filter applied to
  the same content**: My Station / All Stations; made / bought; Added / Removed / Adjusted on part
  history; This step / All part. Use the shared
  [`highContrastToggleSx`](../lib/highContrastToggleSx.ts) so the pill reads on the navy surface —
  selected is filled `primary.main` + bold, unselected is a dashed 0.7-opacity border.

Rule of thumb: if picking an option **changes which list/panel is shown**, it's a view → Tabs. If it
**filters or re-modes the panel you're already looking at**, it's a toggle → pill. Don't build the
same switch two different ways across pages.

---

## Row-and-sheet: one tap target, a sheet that owns every action

*(Was "Tile-and-sheet". Corrected 2026-08-03: the drawn storage board it described was deleted in
`db58ae8` for [`LocationTable`](../components/inventory/locations/LocationTable.tsx), an indented
table. The sheet survives as
[`LocationDetailSheet`](../components/inventory/locations/board/LocationDetailSheet.tsx) — whose own
header comment still describes the deleted drawing.)*

**Withdrawn:** the drawn board — wrong because on a real shop it drew almost nothing. A node's `kind`
only changes the rack border, and the whole tile body was gated behind `children.length > 0` because
**118 of 121** of Contour's legacy locations are flat. It was already a grid of labels with worse
density than a table, no sorting, no bulk anything, and could draw only three levels where the
generator permits four.

**Withdrawn:** "a list is out because Cabinet 1 alone exploded into 15 rows" — wrong because that was
an artefact of the **wizard**, not of lists: the cabinet template generates 1 × 5 × 2 = 16 nodes in
one pass. Stop defaulting to it and a flat shop's whole table is **12–18 rows**. Twelve of twelve
surveyed tools present locations as a tree or table, none draws them — convergent evolution, not user
research, and **no user has ever been observed using any storage UI here**, board or table.

**The surviving standard.** Where rows or tiles are dense enough that per-element controls would have
to shrink below the **48px** floor, make the whole row/tile one tap target and give a sheet every
action. The forcing measurement: a compartment drawn ~**6px** tall, raised to 48px, turned a
5-row × 2-side cabinet into a ~**500px** tile.

**Everywhere else, prefer ordinary rows with buttons — the extra tap is a real cost**, paid here only
because the alternative was losing the depiction entirely. Reach for a sheet when the row's *value is
what it depicts*, not merely when a row has several actions. It also matches the operator bin view's
existing drill-down, so the two surfaces read the same way.

| Layer | Role |
|---|---|
| Row / tile | One tap target, one accessible name carrying the summary. Mouse affordance only — the name stays a real `<button>`, so the row is keyboard- and screen-reader-reachable without pretending a `<tr>` is a control. |
| Elements inside it | Depict only — fill state, names. Never interactive. (Nesting interactive elements inside a `CardActionArea` is also an a11y violation.) |
| Detail sheet (right-anchored `Drawer`) | Every action, drill-down into children, and a **lazily-loaded** contents list — one request per node opened, never one per row rendered. |

**One gesture, one meaning.** The whole row opens the place; expanding is the *chevron's* job. Making
a parent row expand instead gives one gesture two meanings depending on whether a row happens to have
children, and costs parent rows their drawer — where rename, print QR, photo and history live.

**A photo carries identity, not state** — *this is the shelf you're standing at*, versus what's in
it. Photos live in the sheet, not the table: the list is the find-one-name-among-121 view and has to
stay cheap, and a private-bucket thumbnail costs a signed URL. Resolve them in one batched
`getSignedUrls` ([`storageHelpers.ts`](../utils/storageHelpers.ts)), never one request per row.

## Setup pages need a recurring job, or say what they're for

A page whose every control is one-time setup has nothing to bring anyone back, and a first-time reader
can't tell what it's *for* — they see the controls, not the purpose. That's how Storage landed on
review: Add storage, Subdivide, Rename, Print labels, and no answer to "what am I supposed to do
here?" Two fixes, prefer the first:

1. **Give it the recurring job it's missing.** Storage's is counting and putting away — so `Count all
   parts` is in the toolbar, `Count here` is the sheet's first action and the only one offered for
   the `Unassigned` bucket. Better than explaining: it makes the page worth returning to rather than
   merely legible.
2. **Say plainly what the page is and isn't** — one or two sentences: what you're looking at, and
   where the adjacent thing happens instead ("adding and removing stock happens on the part itself").
   Naming what a page *doesn't* do is often the more useful half.

Reusable test, from [`inventory.md` §5.11](modules/inventory.md#511-design-for-the-sustain-not-the-setup):
**if every control on a page is something you do once, the page has no reason to be visited twice.**
Both fixes as-built in [`LocationsManager.tsx`](../components/inventory/locations/LocationsManager.tsx).

---

## Scales

**Typography** — DM Sans (`var(--font-dm-sans)`, loaded in [`app/layout.tsx`](../app/layout.tsx)),
system stack as fallback, `textTransform: 'none'` on buttons.
*(This doc previously said "system font stack"; brand-guide.md §4 still does.)*

| | h1 | h2 | h3 | h4 | h5 | h6 | body1 | body2 | caption |
|---|---|---|---|---|---|---|---|---|---|
| size | 2.5rem / 40px | 2rem / 32px | 1.75rem / 28px | 1.5rem / 24px | 1.25rem / 20px | 1rem / 16px | 1rem / 16px | 0.875rem / 14px | 0.75rem / 12px |
| use | Page titles | Section headings | Subsections | Card titles | Component headings | Small headings | Body | Secondary body (`#C8CCD4`) | Helper text |

**Spacing** — MUI 8px base via `theme.spacing(n)`: 1 = 8px, 2 = 16px, 3 = 24px, 4 = 32px, 6 = 48px,
8 = 64px. Use `sx={{ p: 3 }}`, never `padding: '24px'`.

**Core colours**

| Token | Hex | Role |
|---|---|---|
| Steel Blue (`primary.main`) | `#4682B4` | CTAs, links, accents |
| Light Blue (`primary.light`) | `#6FA3D8` | Hover states; the `text` button colour |
| Dark Blue (`primary.dark`) | `#3A6B94` | Pressed states |
| Deep Indigo | `#111439` | Background base; dialog paper |
| Raised Indigo | `#1a1f4a` | Menus, popovers, autocomplete paper |
| Neutral Gray (`secondary.main`) | `#B0B3B8` | Disabled, subtle UI |
| Muted Label Gray (`text.secondary`) | `#C8CCD4` | Secondary text / `body2`. **Lightened from `#B0B3B8`**, which lost contrast on the lighter end of the card surface — labels like "Customer PO" were hard to read. Holds **≥4.5:1** across the whole card surface. |

### Status Colors

`success` `#10b981` (finished, quality passed) · `warning` `#f59e0b` (approaching deadlines, needs
attention) · `error` `#ef4444` (late, critical) · `info` `#3b82f6` (active work, informational).

*(This doc pasted a `statusColors` map keyed `requested / approved / in_progress / quality_checked /
shipped / delivered / invoiced / complete / overdue`. No such constant exists in the codebase, and
those are not the job statuses.)* Job status → palette slot is configuration and lives with the type
it describes: [`types/job.ts`](../types/job.ts) → `PRODUCTION_STATUS_CONFIG` (`not_started` default ·
`in_progress` info · `completed` success · `cancelled` error), `FULFILLMENT_STATUS_CONFIG`,
`JOB_LIFECYCLE_STAGE_CONFIG`; rendered by
[`JobStatusChip.tsx`](../components/jobs/JobStatusChip.tsx), which wraps `StatusChip`.

---

## Detail-page layout patterns

CLAUDE.md covers list, create/edit and import pages. This covers **detail pages** — one record of one
entity. Three patterns; don't mix them. **Pick by what the user came to do, not by entity size:** a
*reference* entity is opened to read settings and see relations, not to drive anything; a
*workflow / document* entity is opened to act on a process (ship, cancel, send PDF) or to step through
a child collection (operations, line items); a *workspace* is opened to keep editing the record
itself. As-built, verified 2026-08-03:

| Pattern | Entities | Shape |
|---|---|---|
| **A — Reference entity** | Customers, Vendors | Back + Edit/Delete row → **title card** (name + identity chips inline on one row) → `<Grid container>` of two `size={{ xs: 12, md: 6 }}` cards, both `sx={{ height: '100%' }}` so their bottoms align → optional full-width footer. |
| **B — Workflow / document entity** | Jobs, Quotes | **No title card**: entity number + status pill + badges inline on one row (`flex` + `gap: 2`) — don't stack the pill on its own line below the title, it looks orphaned. Metadata summary above, then the **full-width workhorse panel** (operations, line items), the reason the user opened the page. |
| **C — Maturity-adaptive workspace** | Parts | Sticky identity header + URL-addressable tabs (`?tab=`), edited in place with auto-save on blur; no Edit mode, no `/parts/{id}/edit` route. Owned by [`modules/parts.md` § "Part detail workspace"](modules/parts.md). |

*(Corrections 2026-08-03: this doc put **Parts** and **Work Centers** under Pattern A. Parts became
Pattern C; Work Centers stacks full-width cards with no `md=6` split, as does the Quotes body —
Quotes holds its metadata in one full-width card with an internal `sm=6 / md=4` grid. It also
promised a **QR code in the `md=6` right slot, "always visible, no toggle"** on both patterns;
**no detail page renders a QR code** — QR survives only on printed location-label and job-traveler
PDFs and in the scanner. Real right-hand slots: Jobs → `JobBillingShippingCard`, Customers →
contacts, Vendors → address.)*

**Deviation is fine for** content-driven branching (Parts' stocked vs made-to-order) and document
chrome (Quotes' Email / View PDF). **Known gap:** Work Centers fits none of the three — it is a
reference entity whose right-hand slot never had content, so Pattern A collapsed to two stacked
full-width cards. New detail pages default to one of the three; if none fits, that's a signal to push
back on the content shape — not to invent a fourth.

---

## Resources

[Material-UI](https://mui.com/) · [MUI component API](https://mui.com/material-ui/api/button/) ·
[Material Design 3](https://m3.material.io/) ·
[MDN — CSS gradients](https://developer.mozilla.org/en-US/docs/Web/CSS/gradient)
