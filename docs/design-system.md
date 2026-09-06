# Design System

> **Condensed 2026-08-03 · 4,546 → 4,079 words (`wc -w`), then re-expanded to 5,764 by the inversion
> below.** Cut in the first pass: the ~450-word theme-provider example and the `WorkOrderCard`
> sample; pasted `<Card>`/`<TextField>` snippets; the unused MUI 0–24 elevation ladder; a Do's/Don'ts
> list. Roughly **950 words of code-verified correction** went back in. Kept deliberately: every
> withdrawn argument, every measured value, every citation.
>
> **Inverted 2026-08-03 (same day).** The first pass also cut ~1,400 words as "restating CLAUDE.md"
> and *delegated* principles, component usage, page layouts, mobile requirements and WCAG **to**
> CLAUDE.md. That was backwards: CLAUDE.md is loaded into every session whether or not anyone is
> touching UI, so the delegation parked the derivable half in the expensive place and left this file
> pointing at it. **This file now owns all six**, re-absorbed and verified against the code;
> CLAUDE.md keeps a pointer here. Four of the six arrived wrong — see [Reach &
> accessibility](#reach--accessibility) (the 48px claim and the WCAG level), [Scales](#scales) (the
> 16px body-text minimum) and [Glass cards](#glass-cards) (the elevation ladder).
>
> **Nine corrections from the first pass, marked inline.** Largest: the steel-blue-centre gradient
> this doc called "CRITICAL … must be present on all pages" was removed app-wide for a 4.11:1
> contrast failure; the drawn storage board behind "tile-and-sheet" was deleted in `db58ae8`; and the
> pasted `statusColors` map named nine job statuses that do not exist.
>
> **Values live in [`lib/theme.ts`](../lib/theme.ts).** This file holds rationale and the decisions
> no token can express. Elsewhere: destructive actions + saving →
> [interaction-standards.md](interaction-standards.md); logo, marketing palette, voice →
> [brand-guide.md](brand-guide.md); **which surface a change lands on** (office computer / operator
> phone / machine HMI) → [the device model in
> CLAUDE.md](../CLAUDE.md#who-uses-what-on-what--the-device-model), which every rule here about
> hover, density and touch depends on.

Material-UI **v7.3.6** *(this doc previously said "MUI v5+")*, Material Design 3, single dark theme,
no light/dark toggle. The dark theme is the one visual decision carrying direct user validation — a
manufacturing user's verdict on it was *"pretty fucking awesome"* — which is why there is no toggle
and no second theme to keep in sync.

---

## Principles

Four. They are not decoration on the theme — each is the reason a specific decision below went the
way it did, and the audience is what makes them non-obvious: 50–60 year old shop owners and
machinists, not designers.

| Principle | Because the reader is | Where it bites |
|---|---|---|
| **Professional, not trendy** | someone who reads novelty as *unfinished* | [Callouts & insets](#callouts--insets-no-decorative-accent-borders) — no decorative side-accents; [Placeholders](#placeholders) — nothing that could pass for entered data |
| **Substantial, not playful** | in a shop, looking at money and schedule | [Glass cards](#glass-cards) — a deep opaque panel, not a pale floating one; deliberately 2D, no 3D scene or video behind live data |
| **Readable in a bright room** | holding a phone under 500–1000 lux of fluorescent light | [The app canvas](#the-app-canvas) — contrast measured against the room, not the desk |
| **One dark theme, no toggle** | one validated look, not two kept in sync | the paragraph above — the only visual decision here carrying direct user validation |

**Named gap:** nothing checks any of the four. They earn their place only by being cited at the
decisions they produced, which is the sole way a reader can tell whether a new screen honours them.

---

**Count what a person can act on, not what the system writes.** A generator that inserts 4 rows and
8 bins has created 12 rows in a table and **8 places** someone can put something in; the rows are
structure and cannot hold stock. "Create 12 locations" followed by eight usable spots overstates a
shop's storage by every container it owns. Say the number that survives contact with the job.

## Writing UI

**MUI components, always** — `Button`, `TextField`, `Card`, `Paper`, `Box`, `Typography`, `List` /
`ListItem` / `ListItemButton` / `ListItemText`, `Alert`, `CircularProgress`, `Chip`, `Container`,
`Grid`, `Stack`. When you need semantic markup, reach for the **`component` prop**
(`<Card component="li">`, `<Box component="form">`) rather than dropping to a raw element — it keeps
the theme applied *and* the HTML semantic, and it is what the repo already does far more often than
it writes a bare `<div>`.

**Style with `sx`; there is no stylesheet.** The repo contains **no `.css` file at all** outside
`node_modules` — no global stylesheet, no CSS module, nothing imported by
[`app/layout.tsx`](../app/layout.tsx). That is a deliberate deviation from Next.js, which supports
both out of the box. A rule declared in CSS lives outside `lib/theme.ts` *and* outside every
component's `sx`, so it is invisible from the two places anyone looks when the dark palette breaks.
Keep it at zero.

**Never hardcode a colour or a pixel in a component.** `color="primary"`,
`sx={{ color: 'text.secondary', p: 3 }}`. Raw hex belongs in [`lib/theme.ts`](../lib/theme.ts) and in
the [sanctioned exempt chips](#status-badges) — nowhere else.

**Let theme defaults be the default.** `<Card>` already carries elevation 2, the glass fill and the
hairline; `<TextField>` is already outlined and 48px tall. Most call sites still pass `elevation={2}`
explicitly — redundant rather than wrong, but it means a deliberate deviation doesn't stand out, so
don't add more.

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

**Withdrawn:** the ladder "2 = standard cards · 3 = auth cards **and modals** · 4 = **app bar,
floating elements**" — wrong at both ends. It omitted **0** and **1**, which are in use (flat
`Accordion`s and `Paper` insets; [`RoutingViewer`](../components/routings/RoutingViewer.tsx) and
[`UnitGridView`](../components/inventory/locations/UnitGridView.tsx) are `elevation={1}`). Elevation 4
describes exactly one surface,
[`app/admin/layout.tsx`](../app/admin/layout.tsx) — the operator app bar is `elevation={0}` and the
dashboard [`Header`](../components/layout/Header.tsx) isn't an `AppBar` at all. And modals never sat
on the ladder: `MuiDialog` takes a solid paper override instead, so its elevation is moot.

---

## Reach & accessibility

### The 48px floor

**Everything tappable is at least 48px in its smallest dimension.** That is a rule you have to
uphold, not a guarantee the theme gives you — and the difference is the single claim that was written
down wrong for as long as it existed.

**Corrected 2026-08-03.** "Touch targets: minimum 48px (theme enforces this)" overclaimed.
[`lib/theme.ts`](../lib/theme.ts) sets `minHeight: 48` on **three** components and nothing else:

| Control | Floored at 48? |
|---|---|
| `Button` · `TextField` (on `.MuiInputBase-root`) · `ListItemButton` | **Yes**, by `lib/theme.ts` |
| Operator bottom-nav actions | **Yes** — `minHeight: 56`, set by hand in [`app/operator/[companyId]/layout.tsx`](../app/operator/[companyId]/layout.tsx) |
| `IconButton`, including [`DeleteIconButton`](../components/common/DeleteIconButton.tsx) — which defaults to `size="small"` | **No.** MUI's own padding leaves it well under the floor |
| `Checkbox` · `Chip` · `Tab` · `ToggleButton` · a hand-rolled `<Box onClick>` or `CardActionArea` | **No.** Nothing constrains them |

**A dense grid of targets SCROLLS; it does not shrink.** When many tap targets have to sit together
— a cabinet 15 bins across, a calendar, a seat map — the tempting move is to divide the viewport by
the column count. Fifteen columns on a 390px phone is ~24px a cell, which is the WCAG 2.2 AA
*minimum* and fails its spacing clause besides. Keep the floor and let the container scroll
sideways in its own overflow box; the physical thing is wider than your hand too. Two mechanics make
that hold, and both are easy to get backwards:

- **Shrink disabled is the half that protects the floor.** `flex: 0 0 auto` with a `minWidth`, never
  `flex: 1` — a growable-and-shrinkable cell quietly fits itself to the phone.
- **Growth is bounded by content, not by the container.** `flex: 1 0 48px` looks right on a phone and
  gives each cell half a monitor on a 2-wide unit. Ask for the floor, then let the content decide.

**Named gap: nothing measures a target — and a unit test cannot.** jsdom has no layout engine, so a
component test can assert the *declaration* and never the rendered box. Every layout claim in this
section — the floor, the scroll container, a sticky column covering its row — needs a real browser at
a real width. Three defects in the storage grid (labels not covering their band, a truncated title, a
cell stretched to 790px) all passed a green suite and were found in ten minutes of driving the app.
[`interactionStandardsCheck.ts`](../scripts/interactionStandardsCheck.ts) scans for button colour,
value-shaped placeholders and grey delete icons — not size. An undersized tap target ships green.

**Where the gap is tolerable, and where it isn't.** Undersized `IconButton`s cluster on admin
surfaces, which are mouse-driven office computers, and a mouse hits a 30px target fine. On the
operator surface the floor is real and unforgiving — a phone, one-handed, sometimes gloved. That is
also the whole origin of [row-and-sheet](#row-and-sheet-one-tap-target-and-a-sheet-for-what-has-no-surface-of-its-own):
the forcing case was an element drawn ~6px tall that could not be raised to 48px in place.

### The operator surface is a phone

What the shell enforces, all in
[`app/operator/[companyId]/layout.tsx`](../app/operator/[companyId]/layout.tsx) unless noted:

- **Bottom navigation, not a sidebar** — five thumb-reachable slots, the only primary nav on the
  operator surface. Its `minWidth: '0px'` override is load-bearing, not tidying: MUI's 80px default
  made five slots demand 400px and clipped both *ends* at a 375px viewport. The measurement lives in
  the file; don't restate it, don't undo it.
- **The content column is capped at `maxWidth: 680`**, even in a desktop browser. Uncapped, a
  four-line movement row rendered ~1,900px wide with its text in the leftmost fifth — which is what
  made the activity feed read as sparse rather than dense.
- **Landscape is deliberate** — `orientation: 'any'` in [`app/manifest.ts`](../app/manifest.ts), so
  job details stay usable turned sideways. *(Its inline comment still says "on a tablet" — the
  withdrawn device assumption. The setting is right; the reason is stale.)*
- **QR scanning gets the viewport, not a framed box** —
  [`LocationScanner`](../components/scanner/LocationScanner.tsx) renders the camera at full width and
  height with `objectFit: 'cover'`.

### Contrast, keyboard, semantics

**The live standard is the one in [The app canvas](#the-app-canvas):** 4.5:1 body and 3:1 large text
as a *floor*, measured against a 500–1000 lux shop floor rather than an office monitor, and treated
as a hard limit rather than a number to squeak past. Every ratio in this file was measured by hand.

### `error.main` is not a text colour on a lifted surface

`#ef4444` is fine as a border, an icon or a fill. As **text** it clears the body floor only on the raw
page canvas — and text almost never sits on the raw canvas. Measured against the surfaces as painted
(sampled from the running app, because the cards are translucent over a gradient and a value derived
from `background.default` comes out darker than reality and flatters the result):

| Surface | `error.main` #ef4444 | `error.light` #fca5a5 |
|---|---|---|
| Page canvas `#111439` | 4.72:1 ✓ | 9.35:1 ✓ |
| Dialog paper | **4.47:1 ✗** | 8.87:1 ✓ |
| Card / paper | **3.70:1 ✗** | 7.33:1 ✓ |
| Warning-tinted card (Overdue) | **2.98:1 ✗** | 5.90:1 ✓ — but see below |

**So: `error.light` for error TEXT, `error.main` for everything else.** `error.light` passes on every
surface, so no per-site analysis is needed — you never have to work out which panel a message lands on.

Three usages are measured exempt and should stay on `error.main`: **icons** (non-text, SC 1.4.11 asks
3:1 and 3.70:1 clears it), **filled** error chips and **contained** error buttons (white on a red fill —
a different calculation, and lightening them would wash out the one affordance that should look
dangerous). A `MuiButton` override in [`lib/theme.ts`](../lib/theme.ts) handles text and outlined error
buttons automatically; `contained` is deliberately excluded.

### Red means broken; amber means behind

`warning` carries the same `main` / `light` split, and for the same reason — but the choice of *which*
status colour a surface uses is a separate decision from whether it is readable.

**Overdue work is amber, not red.** Andon is the convention a shop floor already runs on — green
running, amber needs attention, red stopped — and an overdue job is behind, not broken. Every shop has
late jobs; painting the dashboard red on an ordinary Tuesday spends the loudest signal on a normal
state and leaves nothing for a genuine failure. Red is kept for things that are actually wrong.

A practical bonus found while rendering it: `rgba(239,68,68,0.08)` over deep indigo goes muddy purple —
neither red nor navy. The amber tint stays neutral.

| On the Overdue card's amber tint | |
|---|---|
| `warning.main` #f59e0b | 4.89:1 — *passes*, unlike error.main, but 0.39 above a hard limit |
| `warning.light` #fbbf24 | **6.28:1**, measured as painted |

So `warning.light` for the text and `warning.main` for the rule and the tint. Note the asymmetry with
`error`: amber's `main` is readable as text and red's is not, because #ef4444 is unusually dark for its
hue — which is exactly why the rule is per-colour and measured rather than assumed.

Pinned by [`__tests__/lib/alertContrast.test.ts`](../__tests__/lib/alertContrast.test.ts), which computes
real WCAG ratios from the theme's own values against each surface above.

**Withdrawn:** the heading "Accessibility (WCAG 2.1 **Level A**)" — wrong twice. Level A imposes no
contrast requirement at all; 4.5:1 body / 3:1 large text are Level **AA** (SC 1.4.3). And 48px is not
a WCAG number in any version — WCAG 2.2 asks 24×24 CSS px at AA (SC 2.5.8) and 44×44 at AAA
(SC 2.5.5). 48px is the Material Design touch-target guideline, which is stricter, which is why we
keep it. Two standards were live in two files with nothing marking either dead; this is the survivor.

The rest of that block stands, because it is right and cheap:

- **Keyboard-reachable, with a visible focus indicator.** The
  [row-and-sheet](#row-and-sheet-one-tap-target-and-a-sheet-for-what-has-no-surface-of-its-own) rule that a row's name
  stays a real `<button>` — rather than a `<tr>` pretending to be a control — exists for this.
- **Semantic HTML and real ARIA labels.** Use MUI's `component` prop for the element, and label every
  icon-only control: [`DeleteIconButton`](../components/common/DeleteIconButton.tsx) makes
  `ariaLabel` a *required* prop precisely so it cannot be skipped.

**Named gap: there is no automated accessibility check.** No axe, no contrast assertion, no
target-size rule anywhere in the Vitest, Playwright or scanner layers. Contrast regressions are caught
by someone looking — which is how the 4.11:1 canvas survived as long as it did.

---

## Buttons

**Every button answers two questions: what rank is it (→ `variant`), and is it destructive
(→ `color`)?** Those are the only two axes. Do **not** reach for `success` / `warning` / `info`
*fills* to brighten an ordinary action — those are status-chip colours (see
[Status Colors](#status-colors)); on an action button they mislead. A green button reads as *already
done* — exactly the trap we hit with green "Complete" / "Mark Received" buttons.

`color` is almost always **omitted** (theme default `primary`). `size="large"` is never needed — the
theme floors every `Button` at a **48px** touch target. (One of only three components it floors; an
`IconButton` is not among them — [the 48px floor](#the-48px-floor).)

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
  ([`OperationCard`](../components/jobs/OperationCard.tsx)). *(Also cited `OutsideWorkPanel` until
  2026-08-23; that panel is deleted — the Vendors page is read-only now and the job page owns both
  buttons.)*
- **Fill state** — `success.main` for "has stock", a hollow `text.disabled` outline for "empty"
  (`FillDot`, a 7px dot). **Scoped to the dot, and 2026-08-10 is why that scope is written down:**
  the storage grid took the same rule to a 44px cell and rendered an occupied bin as a solid
  `success.dark` button with dark text, which is precisely the "reads as *already done*" failure the
  Buttons section warns about. On anything tap-sized the signal is a **tint plus a solid border**
  with ordinary text ([`UnitGridView`](../components/inventory/locations/UnitGridView.tsx)) — same
  hue, so it still scans across 180 cells, without borrowing a button's meaning. Read as *status*, not good/bad: an empty bin isn't a failure, it's the
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
  [`FeedbackDialog`](../components/feedback/FeedbackDialog.tsx) and
  [`UnitOfMeasurementSelect`](../components/parts/UnitOfMeasurementSelect.tsx). *(This doc cited
  `ConvertToJobModal`, `MaterialRowEditor` and `CompanyShippingSettingsCard`; the first two exist
  but don't use the notice, the third never existed. `ConflictDialog` was a third real caller until
  the per-entity CSV import wizards were removed.)*
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

### A text button on a TINTED band needs its colour checked

[`lib/theme.ts`](../lib/theme.ts) paints every text button `primary.light`
(`#6FA3D8`) regardless of its `color` prop — deliberately, because it is tuned for
the app's own gradient. **On a tinted surface it can fail WCAG AA, silently.**

Measured on the Jobs page's outside-work strip (an amber-tinted band):

| Foreground | At rest | On hover | AA needs |
|---|---|---|---|
| `primary.light` #6FA3D8 — the theme default | **3.83:1** | **3.03:1** | 4.5:1 |
| `warning.light` #fbbf24 | 5.27:1 | 4.93:1 | 4.5:1 |

Hover is the worse case and the easy one to miss: lightening the ground under a
light foreground costs contrast, whether it comes from MUI's own overlay or from
your `&:hover` background. **Check both states.**

**Sample the LIGHTEST pixel of the band, not its nominal colour.** The page
ground is a `135deg` gradient with an ambient radial glow on top, so a band's
real background varies across its own width — the numbers above come from its
right end, which is both the brightest point and where the action sits. The
first measurement of this band read 6.09/4.81 because it sampled the middle.

The fix is an `sx` colour drawn from the band's own semantic — which also ties
the action to the thing it belongs to — and a non-hue cue (an underline on a
text button, a chevron on a band), because hue alone is the same failure
`StatusDot` exists to avoid.

**A band that says one thing and does one thing should be one button.** The
strip started as a small text link parked at the far right of a ~1400px band;
it is now a single `ButtonBase` wrapping the whole row, so the target is the
band and there is no invisible boundary between a clickable region and an inert
one. Two conditions come with that, and they are what make it an improvement
rather than a bigger hit area: it must be a real `<button>` (a `Box` with an
`onClick` looks identical and is unreachable from the keyboard), and **nothing
inside it may be interactive** — a nested button is invalid HTML and splits the
row's accessible name. `ButtonBase` also ships no focus ring, so give it an
explicit `&:focus-visible` outline. If a second action is ever wanted on such a
band, it stops being a button first.

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

**In a LIST, use [`StatusDot`](../components/common/StatusDot.tsx) instead** — a 7px semantic dot
plus the plain label, taking the same `label` + `color` so the two forms can never disagree about
what green means. Chips stay on **detail** surfaces, where one status is the subject of the screen
rather than one cell in a scan.

*Why the split.* A filled pill is a **button-shaped object**. In a grid it appears once per row, a
dozen times down a page, on rows where the actual click target is the row itself — it reads as
something to press and stops the eye at every line. It also caps what a second fact can look like:
the jobs list briefly carried an "At vendor" chip beside the lifecycle one, and two chips in a 200px
cell wrapped onto a second line, making the busiest-looking rows the ones with the least to say.

*Why the label is not optional.* The dot's hue is the shortcut for someone scanning; **the word is
what survives when the hue does not land.** A colour-only treatment was considered and rejected on
exactly that: roughly one man in twelve has some red-green deficiency, and these lists are read
almost entirely by men over fifty, often under shop lighting. `default` renders **hollow**, mirroring
the chip's outlined neutral. `nowrap` means a status must fit its column — sizing one for a chip and
then dropping a dot in front clips the longest label.

**Exempt (intentionally custom, do not force onto `StatusChip`):** chips with a bespoke palette for a
domain reason — work-centre kind, and the Made/Bought source chip on the Parts grid. These use
custom hex/rgba, not the semantic palette, and are not on/off status badges.

`StockStatusChip` and `PartClassificationChips` were the other two named here. Both were deleted with
`parts.is_stocked`: the Parts grid gave up its On hand and Status columns (quantities are Storage's
job), which left the stock chip with no consumer, and the classification chip had already lost its
last one — with `is_stocked` gone it rendered a single Made/Bought chip that the grid draws inline
anyway. The part page's Inventory tab derives its own low-stock chip.

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

## Row-and-sheet: one tap target, and a sheet for what has no surface of its own

*(Was "Tile-and-sheet". Corrected 2026-08-03 when the drawn storage board was replaced by an
indented table, and again **2026-08-10** when the table was replaced by
[`StorageUnitList`](../components/inventory/locations/StorageUnitList.tsx) →
[`UnitGridView`](../components/inventory/locations/UnitGridView.tsx). The sheet outlived all three and
was then deleted itself, 2026-08-10, when the pane it kept opening over could simply show the
thing — see the correction below.)*

**Withdrawn:** the drawn board — wrong because on a real shop it drew almost nothing. A node's `kind`
only changes the rack border, and the whole tile body was gated behind `children.length > 0` because
**118 of 121** of Contour's legacy locations are flat. It was already a grid of labels with worse
density than a table, no sorting, no bulk anything, and could draw only three levels where the
generator permits four.

**Withdrawn:** "a list is out because Cabinet 1 alone exploded into 15 rows" — wrong because that was
an artefact of the **wizard**, not of lists: the cabinet template generates 1 × 5 × 2 = 16 nodes in
one pass. Twelve of twelve surveyed tools present locations as a tree or table, none draws them —
convergent evolution, not user research.

**Withdrawn 2026-08-10 — "stop defaulting to the wizard and a flat shop's whole table is 12–18
rows".** Wrong by an order of magnitude, and it was the table's founding claim. Contour built **237
locations, 216 of them leaves and 180 in a single cabinet**, deliberately, by hand. The generator was
never why storage got big; a shop with real storage is big. **Measuring the default rather than the
ceiling is the mistake worth carrying forward** — it is the same error in both directions, since the
board before it was justified on the same 12–18.

Storage is now a list of *units* that opens a *drawn* unit — which is the shape the original board
argument wanted, and which the flat-shop data of the time genuinely did not justify. The line that
stayed true throughout: **no user had ever been observed using any storage UI here.** One now has.

**The surviving standard.** Where rows or tiles are dense enough that per-element controls would have
to shrink below the **48px** floor, make the whole row/tile one tap target and give a sheet its
actions.

> **Corrected 2026-08-10 — "a sheet that owns EVERY action" is what to avoid.** The rule as written
> survives a list and breaks the moment anything in that list earns a surface of its own. Storage
> grew a page per unit, the unit's actions stayed in the shared sheet, and the result read as two
> products stitched together: opening a cabinet swapped the list in place under a toolbar that still
> acted on the list, while its own actions sat behind a `Manage` button that opened a drawer *over*
> the thing you were looking at.
>
> **Actions belong to the surface that shows the thing.** A sheet is for what has no surface of its
> own — a bin inside a cabinet, a row inside a grid. When something earns a page, its actions move
> onto that page and the sheet keeps only its children. The test is one question: *is the thing I am
> acting on the thing I am looking at?* The forcing measurement: a compartment drawn ~**6px** tall, raised to 48px, turned a
5-row × 2-side cabinet into a ~**500px** tile.

> **And then it came back, 2026-08-10 — which the rule above predicted rather than contradicted.**
> The sheet was deleted because it owned the *cabinet's* actions while the pane showed the cabinet.
> A **place** has no surface of its own and cannot get one: 180 bins do not each get a section under
> a grid. So clicking a cell opens a drawer holding that place's contents, its four verbs, and its
> history — the same rule, applied to the thing that genuinely has nowhere else to live.
>
> **The measurement that forced it back:** the contents had been put *under* the grid instead, so
> selecting a bin near the top of a 12-row cabinet left the answer below the fold — and scrolling
> the page to it moved the grid up under the cursor by about one row. Click Row 4, the page jumps,
> click again where Row 4 was, and you select Row 5. Reported as an off-by-one in the grid; the grid
> was aligned to half a pixel and every single click was correct. **A surface that scrolls the page
> to answer you will be blamed for the click it moved.**
>
> Two corollaries, both learned the same afternoon:
>
> - **One layer.** A drawer's own actions are **views inside it**, never dialogs over it. Two stacked
>   surfaces bury the subject under both, which is the failure the sheet was deleted for in the first
>   place. Give every view the same header and the same way back.
> - **A modal surface is opaque.** `background.paper` is `rgba(32, 38, 82, 0.78)` on purpose — a card
>   is meant to let the lit canvas through. A drawer covers the page, and at 78% the page reads
>   straight through it; on a 390px screen a full-width drawer over a full-width grid made both
>   illegible at once. Dialog and Menu already carried solid overrides for exactly this reason and
>   Drawer did not. Sticky headers inside one need `background.default`, not `paper`, or the rows
>   scroll through the heading.

**A filter must never hide what is about to be written — 2026-08-11.**

A batch form derives what it will write from **every** row, because the rule that a blank row is not
an instruction requires it. A filter narrows what is *rendered*. Left alone those two disagree, and
the disagreement is an invisible write: type a count into an o-ring, filter to "bearing", and the
button reads `Save 1 count` over a list showing nothing to save. It shipped that way in a drawer and
was caught in review before anyone used it.

The fix is structural, not a warning. **A row carrying a value is exempt from the filter**, so the
write set is on screen at the moment the button is pressed, at any filter and any scroll position.
Say it in the helper text too — *"Showing 2 of 57 — including 1 you have filled in"* — so the
exemption reads as deliberate rather than as a filter that does not work.

The general form: **whenever a control narrows a list that a submit reads in full, the submit's set
is the thing that must stay visible.** Filtering, paging and collapsing are all the same hazard.

**And do not paint the same list twice.** The place drawer rendered a read-only *What's here* above a
form whose rows were a strict superset of it — same names, same quantities, plus a field. On a
57-part put-away pile that is two full screens of the same information, with the verb you just
pressed a screen and a half above the rows it applies to. The read-only list now steps aside for the
verbs that list the same places, and stays only for `Add`, whose rows are the parts going *in*.

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
children, and costs parent rows their drawer — where rename, print QR and history live.

> **Withdrawn 2026-08-10 — "a photo carries identity, not state".** A place used to carry a photo,
> on the reasoning that *this is the shelf you're standing at* is a different fact from what is in
> it. Nobody ever took one: 0 of 313 locations, 0 objects in the bucket. Photos of the **material**
> moving through a place survive and are the ones that get used. The batching rule the paragraph
> carried is unaffected and still applies wherever private thumbnails are rendered in a list —
> resolve them in one `getSignedUrls` ([`storageHelpers.ts`](../utils/storageHelpers.ts)), never one
> request per row.

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

*(`lib/theme.ts` defines h1–h6, `body1`, `body2` and `button` only. `caption` — and `subtitle1` /
`subtitle2`, unused — are MUI's defaults, listed here because they render, not because we set them.)*

**Use the named variants; never set `fontSize` in `sx`.** `body1` (16px) is the floor for *primary*
body copy — the thing the user came to read. `body2` (14px) and `caption` (12px) sit below it on
purpose and are the documented homes for secondary and helper text.

**Withdrawn:** "Readable Text: minimum 16px font size for body text" — wrong as stated, and
contradicted by the very theme it was describing: `body2` is `0.875rem` (14px) in `lib/theme.ts`,
carries the `#C8CCD4` label colour, and is in use for secondary text throughout. What it was reaching
for is the rule above (don't shrink *primary* copy) plus the contrast floor — contrast, not size, is
what carries 14px in a bright room, which is why `text.secondary` was lightened to hold ≥4.5:1.

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

## Page layout patterns

**No page renders its own title.** [`Header`](../components/layout/Header.tsx) derives one from the
pathname, and [`PageTitleProvider`](../components/layout/PageTitleProvider.tsx) lets a page override
it with the record's identity (the part page sets the part number) — the app bar sticks, so that
identity stays visible while scrolling. An inline `<Typography variant="h4">Parts</Typography>` at the
top of a page is a duplicate that also *loses* the sticky behaviour it duplicates.

### Identity in the office chrome — two slots, two owners

**Workspace identity is top-left; person identity is top-right.** The sidebar's
[`CompanySwitcher`](../components/layout/CompanySwitcher.tsx) answers *which company*, and
[`AccountMenu`](../components/layout/AccountMenu.tsx) in the header answers *which account* — name
and avatar on screen at rest, with email and role a click away. Keep them apart; a second company
control in the header, or a user name in the sidebar, puts one question in two places.

**Read the person's name from `user_company_access.name`, never `user_metadata.first_name`.** The
header greeted people from auth metadata for months and rendered *nothing* for every account the two
sign-up paths didn't create, while the Team page showed the same name correctly off the membership
row. `user_company_access` is the source every access-granting path populates;
[`useCurrentMember`](../hooks/useCurrentMember.ts) is the way to read it. When the name is null,
lead with the email — do not synthesise one from its local part.

**Sign out lives in that menu, last, and `error.main` at rest.**
[interaction-standards.md §1](interaction-standards.md#1-destructive-actions-delete--remove) names
Logout destructive and puts the destructive option at the end, and both hold here — the old bare
header button was grey-until-hover, which this corrected. Burying it is not the kebab anti-pattern
that section warns about on office surfaces: that rule is about
record deletes shown red-at-rest, and signing out is recoverable by signing back in. At phone widths
it is a safety gain — the bare sign-out `IconButton` it replaced sat one mis-tap from ending the
session, right beside a button people press often.

**List pages** — `<Box>` with no padding (the layout supplies it) → one flex toolbar row → content.
The toolbar reads left to right: search `TextField` (`size="small"`), any selection-dependent bulk
actions, a `<Box sx={{ flex: 1 }} />` spacer, then `outlined` Import and `contained` New … pinned to
the right edge. Content is a `<Card>` wrapping an AG Grid, swapped for a centred empty-state card at
zero rows — which is why the Card hairline is tuned for full-width tables ([Glass cards](#glass-cards)).
Cleanest read: [`customers/page.tsx`](../app/dashboard/[companyId]/customers/page.tsx).

**Create / edit pages** — `<Box>` with no padding, no inline title, the form component rendered
directly. The form owns its own cards.

**Import pages** — `<Box>` with no padding, an `ArrowBackIcon` "Back" button at top left, content
below.

### Detail pages

One record of one entity. Three patterns; don't mix them. **Pick by what the user came to do, not by
entity size:** a *reference* entity is opened to read settings and see relations, not to drive
anything; a
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

**Deviation is fine for** content-driven branching (Parts' made vs bought) and document
chrome (Quotes' Email / View PDF). **Known gap:** Work Centers fits none of the three — it is a
reference entity whose right-hand slot never had content, so Pattern A collapsed to two stacked
full-width cards. New detail pages default to one of the three; if none fits, that's a signal to push
back on the content shape — not to invent a fourth.

---

## Resources

[Material-UI](https://mui.com/) · [MUI component API](https://mui.com/material-ui/api/button/) ·
[Material Design 3](https://m3.material.io/) ·
[MDN — CSS gradients](https://developer.mozilla.org/en-US/docs/Web/CSS/gradient)
