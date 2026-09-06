# Interaction Standards

> **Reviewed & condensed 2026-08-03** (#634). 3,537 → 4,075 words (`wc -w`) — **it got
> longer, on purpose.** This doc is normative and machine-enforced
> ([`scripts/interactionStandardsCheck.ts`](../scripts/interactionStandardsCheck.ts)) and 11
> source files cite it, so there was little safe to cut: collapsing the two all-green
> "Current state vs this standard" audits saved ~170 words, and the corrections found by
> checking it against the code cost ~600.
> **Four corrections, marked inline:** §4's job-delete example (the UI still enforces guards
> the doc called removed); §4's invoiced-line lock (the "View invoice" button it cited does
> not exist, and a *cancelled* line is disabled with no visible reason at all); and §1's
> "recently deleted / restore" affordance (never built — the durable path is
> `reviveArchivedCustomerByName`). Also added: `describe` names on every test citation. The
> note-surface rules that were mis-filed inside the §1 audit were promoted to their own
> normative subsection, not deleted. Kept deliberately: every citation, every withdrawn
> argument, every named gap, the pricing-tier "doesn't touch existing quotes" mechanics, the
> as-built inventory of which surfaces carry `SaveStatus` and how the exit guard is wired,
> and both 2026-07-31 corrections.

How destructive actions and saving should behave across the app, so users build
one reliable mental model instead of re-learning each screen. Backed by
Nielsen Norman Group, Material Design 3, GOV.UK, Apple HIG, and Carbon (linked
inline). Treat this as the rule; flag deviations in review.

---

## 1. Destructive actions (delete / remove)

**Rule of thumb:** keep the *visual* identical everywhere; scale the *friction*
to the consequence.

### Visual affordance — uniform
- The destructive control is the same everywhere: an **error-colored trash
  icon shown at rest** (MUI `color="error"`), not grey-until-hover. A color's
  meaning must be consistent app-wide ([NN/g — Consistency & Standards](https://www.nngroup.com/articles/consistency-and-standards/)).
- **Color is the constant: every delete is red (`color="error"`) at rest.** Red
  reliably means "destructive" app-wide — a delete must never read grey, or it
  becomes indistinguishable from a benign edit (this is why the grey note-delete
  was a bug). Edit/neutral icons stay grey; the red-vs-grey contrast is the point.
- **Fill scales emphasis, not color** — a two-tier glyph:
  - **Solid `DeleteIcon`** — whole-record/entity deletes that should feel
    deliberate: detail-page header deletes (part, customer, job, quote, vendor,
    work-center…), list-row record deletes, and the danger confirm button in
    dialogs.
  - **Hollow `DeleteOutlineIcon`** — low-emphasis sub-item deletes inside an
    editor: BOM materials, pricing tiers, routing operations, quote line items,
    part notes. Use the shared [`components/common/DeleteIconButton`](../components/common/DeleteIconButton.tsx),
    which bakes in the hollow icon + `color="error"` so it can't be hand-rolled grey.
- **Position — delete sits last.** In a header/toolbar action row the delete
  control is always the **rightmost** item, set apart from the benign actions, so
  the destructive option is predictably located and not crowded next to common
  ones ([NN/g — consequential options near benign ones](https://www.nngroup.com/articles/proximity-consequential-options/)).
- Enforced by [`scripts/interactionStandardsCheck.ts`](../scripts/interactionStandardsCheck.ts),
  driven by [`__tests__/standards/interactionStandards.test.ts`](../__tests__/standards/interactionStandards.test.ts)
  (`describe`: *interactionStandardsCheck — grey-delete rule*, and
  *interactionStandardsCheck — repo is clean*, which scans `components/` + `app/`):
  a delete icon set to `text.secondary` fails CI. (Glyph choice is a per-call-site
  judgment, deliberately **not** machine-enforced.)
- Keep it low-emphasis (ghost icon, no filled-red background) for in-context row
  deletes ([Carbon — Button usage](https://carbondesignsystem.com/components/button/usage/)).
- Never rely on red **alone** — pair it with an icon/label/confirmation copy.
  Severity is carried by what happens *after* the click, not a redder red
  ([GOV.UK — Button](https://design-system.service.gov.uk/components/button/)).

### Confirmation friction — scaled, NOT uniform
Uniform confirmation dialogs cause **confirmation fatigue** — users reflex-click
"Confirm," which strips the *one* dialog that matters of its power
([NN/g — Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/)).
But fatigue bites at *high delete frequency*; our nested part-editors are edited
occasionally, so a small confirm is cheap insurance here, not a fatigue source.
Scale by impact + reversibility — with one audience floor (below) that overrides
the generic "low-stakes ⇒ no dialog" advice.

| Target | Stakes | Treatment |
|---|---|---|
| **High-impact / hard to reverse** — e.g. delete a whole **Part**, which **archives** it (soft-delete via `deleted_at`, [`bulkDeleteParts`](../utils/partsAccess.ts)) and never blocks | High | **Confirmation dialog**, danger style, consequences stated, Delete kept away from Cancel ([NN/g — proximity](https://www.nngroup.com/articles/proximity-consequential-options/)). This is [`DeleteImpactDialog`](../components/common/DeleteImpactDialog.tsx), which states the impact (quotes/jobs that reference the part, other parts whose cost will change) — a warning, never a block. See [Architecture §16](architecture.md#16-deletion--archiving-policy). |
| **Immediately-persisted row delete** — BOM material row, routing operation row (auto-saved on change), note / comment | Low–med | **Lightweight confirmation dialog** — same shape as the Part delete, less copy ([`NoteDeleteDialog`](../components/notes/NoteDeleteDialog.tsx) for notes). This is the safety-net *floor*; see the audience note for why NOT an Undo snackbar. |
| **Staged (explicit-Save) edit** — pricing-tier removal | Low | **No dialog.** Removal is in-memory until the user clicks Save; the dirty-state indicator + the option to walk away unsaved *is* the safety net. |

Two facts that keep those rows from being re-litigated:

- **A note / comment delete is a HARD delete.** `notes` and `part_comments` carry no
  `deleted_at`, so this sits outside the Architecture §16 archive standard and there
  is no restore — which is exactly why it takes the dialog ([#628](https://github.com/debola31/Jigged/issues/628)).
- **A pricing-tier removal is not the financial hazard it looks like.** It does not
  alter existing quotes: line items snapshot `unit_price`, and the `source_tier_id`
  FK is `ON DELETE SET NULL`.

> **Audience floor — why not "inline delete + Undo snackbar":** our users are
> 50–60, and on the operator surface they are on their own phone on a shop floor with
> divided attention (see [the device model](../CLAUDE.md#who-uses-what-on-what--the-device-model)
> — not tablets, which the docs used to assume). Auto-dismissing
> snackbars are a documented accessibility/usability liability for exactly this
> profile: WCAG 2.2.1 (Level A) treats a short auto-dismiss window as a timing
> limit when the toast is the *only* recovery path ([W3C](https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html));
> Material Design 3 itself says web auto-dismiss snackbars are "inaccessible for
> people with low vision or who require additional time" ([M3 — Snackbar](https://m3.material.io/components/snackbar/guidelines));
> GitHub Primer lists toasts as "not recommended for use" ([Primer](https://primer.style/accessibility/patterns/accessible-notifications-and-messages/));
> and a 2023 systematic review of 40 older-adult studies recommends *increasing*
> on-screen feedback time ([JMIR 2023](https://mhealth.jmir.org/2023/1/e43186)).
> NN/g frames Undo as a *complement* to a dialog, not a replacement. So a
> destructive, immediately-persisted row delete keeps its dialog; only replace a
> dialog when recovery is **durable** — soft-delete plus a real way back, which for
> catalog entities is *revive by reusing the name*
> ([`softDeleteCustomer`](../utils/customerAccess.ts), plus the
> `reviveArchivedCustomerByName` path `createCustomer` takes on a `23505`, plus the
> reassurance `DeleteImpactDialog` renders when `revivableByName`: "You can bring it
> back anytime by re-creating or re-importing the same name") — never a timed toast.
>
> *(Correction 2026-08-03: this previously named a "recently deleted / restore"
> affordance as "the pattern already used for customers". No Trash / Restore /
> Permanent-delete UI exists anywhere —
> [Architecture §16](architecture.md#16-deletion--archiving-policy) lists it as
> deliberately deferred past v1. Name-reuse revival is the durable path that does
> exist; its helper is `reviveArchivedCustomerByName`, private to
> `utils/customerAccess.ts`, not an exported `reviveArchivedCustomer`.)*

### Note surfaces — the one place the standard splits by available width, not stakes

Note / comment **edit + delete** affordances are shaped per surface:

| Surface | Affordance | Why |
|---|---|---|
| **Operator** — job feed, Playbook sheet, machine logbook | One 48px overflow (kebab) → Edit / Delete ([`NoteActionsMenu`](../components/notes/NoteActionsMenu.tsx)) | Note headers already carry author + optional step chip + timestamp and already wrap at 375px; two more 48px targets push every header onto a third line. MUI `MenuItem`s clear 48px, so the touch floor is met at the point of *choice* — which is where it matters, since a mis-tap on a kebab is harmless and a mis-tap on a bare trash icon is not. |
| **Office** — part Activity ([`HistoryTab`](../components/parts/workspace/tabs/HistoryTab.tsx)) | Destructive control **shown at rest** as an error-coloured trash icon, plain edit icon beside it, delete rightmost | Burying delete in a kebab here would regress the red-at-rest and delete-sits-last rules above. Desktop has the width and the hover; the phone constraint does not apply. |
| **Office** — the job activity rail ([`JobActivityNoteRow`](../components/jobs/activity/JobActivityNoteRow.tsx)) | The kebab, **not** the office icons-at-rest shape | The exception that proves the split is about WIDTH, not about who is looking. This is an office surface with a phone's constraint: the rail is 320px at `lg`, so a note's content column is ~288px and two 48px targets at rest would take a sixth of it on every row. The rule below settles it — the kebab is the default for a new note surface, and icons-at-rest is what a wide pane earns. |
| **The operator's own work list** (`/operator/[companyId]/my-work`) | Same kebab, **plus: the row body must stay inert** | See below. |

The work list is the only note surface whose row also has to disclose *content* —
the "Viewed by" reader list, which cannot live in a menu
([NN/g — contextual menus reveal *actions*](https://www.nngroup.com/articles/contextual-menus-guidelines/)).
The naive shape (tap the row to expand, kebab for actions) is a **split-button row**,
and NN/g measured across **136 participants and 11 mobile prototypes** that users "tap
fairly equally on both the accordion icon and the accordion label"
([NN/g — accordion icons](https://www.nngroup.com/articles/accordion-icons/)) — i.e.
roughly a coin flip on every tap, with a delete menu as one of the outcomes. So the two
disclosures sit at **opposite ends** of the row (readers on the eye at far left, actions
in the overflow at far right) and nothing between them is tappable. `NoteActionsMenu`
also carries an optional third item, "Open J-0042", listed **first** so delete still sits
last; this list is the only place a note is the only route back to its job.

> **If you are adding a note surface:** the kebab is the rule. Only add a second
> disclosure if that surface has *content* to reveal as well as actions — and if it
> does, make the row body inert rather than letting it compete with the menu.

### As-built (verified 2026-08-03)

Every gap this section once tracked is closed: red-at-rest everywhere (CI-scanned),
confirmation dialogs on the Part delete, BOM material, routing operation and every
note / comment surface, staged-only removal for pricing tiers. Two closures worth
remembering — the routing-operation delete auto-saves on change, so before its dialog it
was a silent unrecoverable delete ([`RoutingOperationsList`](../components/routings/RoutingOperationsList.tsx));
and the part Activity tab used to delete a comment on a single click with no confirmation.

**Withdrawn:** "drop the BOM dialog and add Undo snackbars to BOM / tier / operation" —
wrong because of the audience floor above; ephemeral Undo is not our pattern, and
dialogs stay on destructive row deletes. Issues [#394](https://github.com/debola31/Jigged/issues/394)
/ [#396](https://github.com/debola31/Jigged/issues/396) were closed with this rationale.

---

## 2. Saving

**Rule:** pick the model by **what is being edited**, apply it the same way
everywhere, always show status, and never let one section destroy another's
work ([GitHub Primer — Saving](https://primer.style/product/ui-patterns/saving/), [GitLab Pajamas — Saving & feedback](https://design.gitlab.com/patterns/saving-and-feedback/)).

### The three modes

| Mode | Applies to | Commits on | Indicator |
|---|---|---|---|
| **Auto-save** | a single, independently-valid, non-financial value: identity fields, transaction notes, preferred vendor | blur (text/number) or change (toggle/select) | `SaveStatus` |
| **Row editor → Save/Cancel**, then persists immediately | a multi-field record only valid as a *set*: routing operations, BOM materials, unit conversions | the editor's own Save | `SaveStatus` on the panel |
| **Staged explicit Save** | **financial** data — anything that moves money downstream: pricing tiers, procurement cost tiers, costing **batch size** | the card's Save button | dirty row accent + sticky footer (below) |

Auto-save is wrong for financial data ([GitLab](https://design.gitlab.com/patterns/saving-and-feedback/), [Figma — autosave pitfalls](https://www.figma.com/blog/behind-the-feature-autosave/)); a row
editor is the right shape for a record whose fields are meaningless
individually, and it is what Polaris recommends for independently-editable
sections of one page.

> **"Financial" means downstream effect, not field type.** `compute_part_cost_at_qty`
> values a part as a made child at exactly this quantity in **every parent's BOM**
> (`v_child_val_qty := v_bom.child_costing_batch_quantity`), so a fat-fingered
> 30 → 300 silently re-costs every parent and flows into their quoted prices.
> The test is not "is this a price?" but **"can a typo here change what a
> customer is charged?"** If yes, it stages behind a Save button.
>
> **Withdrawn:** "batch size is a costing assumption, not a price, so it can auto-save"
> — wrong because of the BOM re-cost path above. It stays explicit-Save.

- **One shared indicator:** [`components/common/SaveStatus.tsx`](../components/common/SaveStatus.tsx)
  — "Saving… / Saved", in an `aria-live="polite"` region. Reuse it on every
  saving surface; don't hand-roll per-section badges.
- Never mix auto-save and explicit-save **within one form/section** in a way the
  user can't predict — that's the direct cause of "did it save?" ([Primer](https://primer.style/product/ui-patterns/saving/)).
  If one control in a staged card genuinely belongs in auto-save mode (the
  preferred-vendor picker in the bought-part Cost card), give it its own
  bordered block and its own `SaveStatus` so the two models read as two
  sections, not one ambiguous card.

### Invariant 1 — section isolation

> **A save in one section must never discard unsaved draft state in another.** A
> refresh signal may invalidate **derived / read-only** data (computed costs,
> rollups, breakdowns). It must never re-seed **user-editable draft** state or
> clear a dirty flag.

The failure it prevents, which cost a real customer real work: the part page
broadcasts one page-wide `refreshKey` after every mutation, and `PartPricing`
consumed it by re-seeding its editable tier rows from the database and calling
`setDirty(false)` — so typing a new Min qty and *then* editing an operation, two
cards side by side, silently reverted the typed value. The old rule only forbade
mixing models *within* a section and said nothing about one section reaching
into another.

The fix shape: gate the draft re-seed on "not dirty" (and on the record not
having actually changed), while leaving the derived-data refetches on the
refresh signal untouched. See `PartPricing.tsx`'s load effect, and the
regression tests in
[`__tests__/components/parts/PartPricing.test.tsx`](../__tests__/components/parts/PartPricing.test.tsx)
(`describe`: *PartPricing — staged tier edits survive sibling saves*) and
[`__tests__/components/parts/PartProcurementPricingPanel.test.tsx`](../__tests__/components/parts/PartProcurementPricingPanel.test.tsx)
(`describe`: *PartProcurementPricingPanel — part-level tiers, explicit save*).

### Invariant 2 — exit guard

> **Leaving a surface that holds staged changes must confirm, not discard.**
> That includes in-app navigation and **tab switches**, not just page unload —
> conditionally-rendered tabs unmount their panels, which is silent data loss
> wearing a different hat.

Attach the guard **only while genuinely dirty** and remove it on save, so it
never produces the false positive that trains users to click through
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)).
`PartWorkspace` owns this: staged-save panels report dirty state up via
`onDirtyChange`, and a tab switch while dirty raises a Keep-editing / Discard
dialog. Covered by
[`__tests__/components/parts/workspace/PartWorkspaceExitGuard.test.tsx`](../__tests__/components/parts/workspace/PartWorkspaceExitGuard.test.tsx)
(`describe`: *PartWorkspace — unsaved-changes exit guard*).

### Making "unsaved" visible

A dirty indicator only works if it is seen. The original one — `variant="caption"`
in `text.secondary`, at the bottom of the tier table, next to a `size="small"`
button — was not, and that is *why* the change was still unsaved when the wipe
hit. Attention is on the field being typed, not the card chrome
([NN/g — Change Blindness](https://www.nngroup.com/articles/change-blindness/):
put feedback next to where the user is working); users routinely miss a separate
commit button beside a field they just filled in
([Baymard — avoid "Apply" buttons](https://baymard.com/blog/checkout-usability-apply-buttons)).

**Every staged explicit-Save surface shows both signals. No exceptions** — a
staged surface with only a Save button and no unsaved marker is the
inconsistency that teaches users the markers elsewhere are decoration. Both are
persistent; never a timed toast (§1's audience floor).

- **At the changed input** — mark *where* the change is, not just that one
  exists, using the shared status ladder below. An unsaved edit is the middle
  rung; it is *not* a mistake and must not read as one — red is reserved for
  broken on purpose (`design-system.md` §"subtractive vs destructive").
- **At the section** — [`components/common/UnsavedChangesBar`](../components/common/UnsavedChangesBar.tsx):
  a sticky bar naming the count with **Discard** and **Save**. Use the shared
  component; do not hand-roll one. It is rendered only when dirty rather than
  disabled-and-visible — with nothing to save the action is genuinely
  irrelevant, not blocked (§4 rule 3), and a permanently-present Save button
  carries no signal. Its *appearance* is what tells the user work is pending.

Name the commit button after the thing (`Save pricing`, `Save costs`,
`Save batch size`), not a generic "Save" — the bar can be far from the field
that owns it.

### The row status ladder — same colours, geometry follows the container

One colour scale carries "what is the state of this row/field", everywhere:

| Colour | Means | Example |
|---|---|---|
| `error.main` | **Broken** — blocks something downstream | a BOM material with no cost on file; an operation missing a labor rate |
| `warning.main` | **Wants your attention** — not wrong yet | an unsaved edit; a placeholder operation with no work centre chosen |
| `divider` / `transparent` | Fine | everything else |

**The colours are the standard; the geometry is whatever the container
supports** — a bordered card row takes a `1px` colored border
(`RoutingOperationRow`, `PartBomPanel`), a table row takes a `3px` colored left
accent, since you cannot cleanly border a `<tr>` (the pricing tiers). A
standalone field takes a colored outline. Don't read a specific border width as
part of the rule.

> **Corrected 2026-07-31.** This section previously described "the `3px` left
> accent the incomplete BOM **and routing** rows use". The routing rows never
> used a left accent — [`RoutingOperationRow`](../components/routings/RoutingOperationRow.tsx)
> has always drawn a full `1px` border. Only `PartBomPanel` had the left accent,
> and it has since moved to the bordered-card shape to match the operation rows
> it sits beside. The colour ladder was, and remains, genuinely shared.

### Dirty state is derived, never latched

> Compare the live values against a snapshot of what they were seeded from.
> Never set a `dirty` flag on first keystroke and wait for a save to clear it.

Latched flags survive the user undoing their own edit, so typing 1 → 10 → 1
leaves the bar demanding a save that would write nothing. **A bar that nags over
a no-op is a bar users learn to click past** — which recreates the exact
inattention this section exists to prevent. Deriving it also makes Discard
trivial and keeps the row markers, the bar, and the exit guard from ever
disagreeing with each other.

Where a save deliberately does *not* refresh its parent (the batch size does
not), keep the baseline **locally** and advance it on save — reading it off a
stale prop leaves the field looking dirty forever.

### As-built (verified 2026-08-03), and the one open gap

Shipped and regression-tested: `SaveStatus` on the auto-save and row-editor surfaces
(identity, routing, BOM, procurement, transaction notes); section isolation in both
tier tables, with a regression test that fails if the guard is removed; the exit
guard — tab-switch confirmation **plus** a conditional `beforeunload`, both driven by
`onDirtyChange` reporting into `PartWorkspace`; derived-not-latched dirty state and a
shared `UnsavedChangesBar` on **all three** staged surfaces —
pricing tiers, procurement cost tiers, and batch size (the last holdout, which had a
lone Save button and no unsaved marker at all, precisely the "some cards prompt you,
some don't" inconsistency that started this work).

- ❌ **Undo-after-save for pricing — still not pursued.** GitLab Pajamas advises
  against auto-saving financial data ([Pajamas](https://design.gitlab.com/usability/saving-and-feedback)),
  so explicit Save stays. With an explicit Save button **plus** a visible dirty
  indicator, a separate post-save Undo is redundant — the deliberate action *is*
  the safeguard, and a tier is trivially re-edited and re-saved (and doesn't
  touch existing quotes; see §1).

  > **Corrected 2026-07-31 (second correction).** This section previously also
  > carried a 🔻 item deprioritizing a navigation guard, on the grounds that
  > *"the honest dirty-state indicator is the real protection."* **That claim is
  > now falsified.** A customer lost a staged tier edit with the dirty indicator
  > present and working — because (a) a sibling panel's save wiped the draft
  > without any navigation at all, and (b) the indicator was too quiet to be
  > read. Both halves are now addressed: invariant 1 removes the wipe, invariant
  > 2 adds the guard, and the row accent + sticky footer make the state legible.
  >
  > The old entry's one surviving argument — that `beforeunload` shows only a
  > generic, non-customizable message
  > ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event))
  > — is real but is an argument for *also* guarding in-app exits with a dialog
  > that can name what's at stake, not for guarding nothing. A generic warning
  > still beats silent loss.

- ❌ **Known gap:** in-app *route* navigation (breadcrumb, links in the
  completeness banner) is still unguarded. Next.js App Router exposes no
  router-event hook, so covering it means intercepting link clicks; that is
  deliberately not built rather than half-built. The tab switch — by far the
  most common way to leave — is guarded.

---

## 3. Completeness (parts)

A part is **incomplete** when it isn't priceable (no cost basis yet —
`get_priceable_part_ids`). Surface this as a first-class, **localized** signal,
not a status column:
- An inline ⚠ marker next to the part name (parts list) + a legend, with a
  Complete/Incomplete filter.
- On the part page: a guidance banner **plus** per-row highlights at the source
  (operation missing a labor rate; BOM material with no cost) — show users
  *where* to fix it, not just that something's wrong ([NN/g — form errors](https://www.nngroup.com/articles/errors-forms-design-guidelines/), [GOV.UK — validation](https://design-system.service.gov.uk/patterns/validation/)).

---

## 4. Unavailable actions (keep-visible-and-explain, not hide/disable)

When an action can't be performed in the current state, prefer (in order):

1. **Keep it visible; explain on attempt.** Leave the control where users expect
   it and tell them what's wrong when they try — more discoverable and accessible
   than hiding or graying out. A *disabled* button isn't focusable, so keyboard /
   screen-reader users never learn it exists or why, and a hover tooltip hides the
   reason ([NN/g — Why Disabled Buttons Hurt UX](https://www.nngroup.com/videos/why-disabled-buttons-hurt-ux-and-how-to-fix-them/), [NN/g — Disabled Accessibility: the pragmatic approach](https://www.nngroup.com/articles/disabled-accessibility-the-pragmatic-approach/), [Smashing — Disabled Buttons](https://www.smashingmagazine.com/2021/08/frustrating-design-patterns-disabled-buttons/)).
   Example: Delete shows on **every** job, in any production status.
   [`deleteJob`](../utils/jobsAccess.ts) **archives** it (soft-delete via `deleted_at`)
   rather than hard-deleting, so it **always succeeds** — presented through a
   consequence-summary dialog, never a confirm→error two-step. The former
   *records-of-value* guards (which blocked a job that had a shipment or a QuickBooks
   invoice) were **removed** from the access layer: archive preserves that history
   intact, so there is nothing left to block (see
   [Architecture §16](architecture.md#16-deletion--archiving-policy)).

   > **Corrected 2026-08-03 — the UI has not caught up with the access layer.** This
   > doc (and [Architecture §16](architecture.md#16-deletion--archiving-policy)'s jobs
   > row) described the above as fully shipped. `deleteJob` does archive, but the job
   > **detail page** still enforces the old guards and still lies about the outcome:
   > `handleDeleteClick` in [`app/dashboard/[companyId]/jobs/[jobId]/page.tsx`](../app/dashboard/[companyId]/jobs/[jobId]/page.tsx)
   > refuses on a shipment count or a QuickBooks invoice link, and its confirm dialog
   > says the delete "permanently removes the job and all of its parts, operations,
   > notes, and attachments. This cannot be undone." Both statements are false against
   > the access layer, and it is a hand-rolled dialog rather than `DeleteImpactDialog`.
   > **Named gap, not a standard — the rule above is the target.**

   The keep-visible-and-explain rule still governs genuinely-blocked actions — see the
   invoiced-line lock in rule 2.
2. **Disable only for a stable lock** whose disabled state is itself meaningful,
   paired with a *visible* reason (not hover-only); prefer `aria-disabled` so it
   stays focusable. Example: once invoiced in QuickBooks, a job's line price is
   locked with a 🔒 adornment **and** the helper text "Invoiced — price locked"
   ([`JobEditForm`](../components/jobs/JobEditForm.tsx)) — the reason is on screen,
   not in a tooltip. The invoice itself is reachable from the job toolbar's
   **Invoices (N)** menu ([`InvoicesMenu`](../components/jobs/InvoicesMenu.tsx)),
   which deep-links each one.

   > **Corrected 2026-08-03.** This example previously claimed a visible
   > "View invoice" **button** signalling the lock. No such control exists: the job
   > page fetches `qbInvoiceLink` but only reads it to gate Delete and never renders
   > it; the links live in the `Invoices (N)` menu. Two further caveats on the lock
   > itself — it uses a real `disabled` prop, not `aria-disabled`, so the "prefer
   > `aria-disabled`" sentence above is the target rather than the as-built; and
   > `priceLocked = isCancelled(p) || qtyInvoiced(p) > 0`, while the 🔒 and the
   > helper text render only when `qtyInvoiced(p) > 0`. **Named gap:** a *cancelled*
   > line is therefore disabled with a blank helper text and no icon — a disabled
   > control with no visible reason, exactly what this rule forbids.
3. **Hide only when the action is irrelevant in this context** — the user's role
   or this object can *never* do it — not when it's merely temporarily blocked.
   Hiding a temporarily-unavailable control hurts learnability: users can't tell
   it exists, or assume it's never available ([Jakob Nielsen — Inactive Controls: Show, Disable, or Hide?](https://www.uxtigers.com/post/inactive-buttons)).

Avoid: a confirm dialog that ends in an error ("are you sure?" → "can't do that")
— two steps to a dead-end. Resolve via rule 1.

### Worked example — a shop whose subscription lapsed (rule 1)

The billing write-gate blocks every write in Postgres, so *every* create and save
button on the dashboard is a control whose press will be refused. It is the largest
"unavailable action" surface in the app, and the temptation is rule 3 — hide the New
buttons — or rule 2, disable them. Both are wrong here: this is not irrelevant to the
user and not a permanent property of the object. It is temporary, and **the user can
unlock it themselves**.

So it is rule 1 throughout:

- The controls stay exactly as they are — visible, focusable, pressable. No
  `disabled`, no hiding, on any of the ~90 write surfaces.
- Pressing one produces
  [`ErrorAlert`](../components/common/ErrorAlert.tsx), which says *why* in plain
  words and carries the fix — a **Subscribe** button, for the one role that can use
  it. That is the "explain on attempt" half.
- [`SubscriptionRequiredNotice`](../components/billing/SubscriptionRequiredNotice.tsx)
  adds the explanation *before* the attempt on the five create routes, so nobody
  fills a whole form to find out. It is an explanation, **not** a disable — the form
  and its submit are untouched.

Two details generalise beyond billing:

- **The reason must fit the role.** Only an admin can subscribe (`/settings` is
  behind `AdminGuard`; the Stripe routes 403 everyone else), so the button renders
  only for them. Showing it to a `user` would be precisely the confirm-then-error
  two-step above. Everyone else gets copy naming who *can* act.
- **Never assert a negative you haven't confirmed.** Entitlement starts unresolved,
  and unresolved reads as "cannot write" — so both components render nothing until
  it loads. Otherwise every healthy shop sees a subscription warning flash on every
  page load, which is the "couldn't check is never denied" rule from
  [CLAUDE.md](../CLAUDE.md) in UI form.

---

## 5. Waiting (added 2026-08-16)

**Added after three separate bug reports from one shop, all the same shape:** a
button that only greys out during a multi-second round trip reads as a dropped
click. §4 already forbade a disabled control with no visible reason — a busy
button is exactly that — but §4 is framed around *unavailable* actions, so
nothing named the *in-progress* case. Before this rule the entire app contained
**zero** buttons that showed progress; the convention did not exist to be
followed.

### The threshold decides, and the threshold is the call

Feedback is keyed to how long the wait actually is, per
[NN/g — Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/):

| Wait | What the control does | Why |
|---|---|---|
| **< 1s** — local state, Supabase CRUD | Disable to stop a double-submit. **No spinner.** | Under 1s the user's flow of thought is unbroken; NN/g: *"no special feedback is necessary."* A spinner here is noise that makes a fast app feel busy. |
| **1–10s** — any third-party hop: Conductor's Web Connector, Intuit, Stripe, Anthropic, FedEx | The **pressed** control shows a spinner and its label names what it is waiting for | Past 1s the user notices; past ~3s with no signal they assume the click was lost |
| **> 10s** — Web Connector cold, or QuickBooks closed | Also say **where** the wait is and that it may run long | 10s is the limit of attention. "Reading your accounts from QuickBooks on the shop computer" makes a 30s pause legible; "Loading…" does not |

Measured, not guessed: a Conductor round trip is ~0.5s warm, **3–10s cold**, and
~30s longer when QuickBooks is shut ([quickbooks-desktop.md](modules/quickbooks-desktop.md)).

### Four invariants, each learned from a real defect

1. **Only the pressed control speaks.** `pending` is per-button, never a shared
   `busy`. A neighbour that greys out *and* claims to be working is a worse lie
   than silence. Callers pass `disabled={busy} pending={which === 'mine'}`.
2. **The label names the wait**, because "Loading…" hides the one fact that makes
   a long pause make sense. Shipped: *"Creating setup link…"*, *"Reading
   accounts…"*, *"Opening QuickBooks…"*.
3. **A hand-off keeps spinning.** When success navigates away — the QBO OAuth
   redirect — do **not** clear the indicator; an idle button mid-redirect looks
   like the click was lost. Everything else clears on success.
4. **Always clear on failure.** A spinner left running after an error makes retry
   impossible. Asserted in
   [`QuickBooksIntegrationCard.test.tsx`](../__tests__/components/settings/QuickBooksIntegrationCard.test.tsx)
   → *"restores the button when starting the connection fails"*.

### Accessibility is a conformance requirement here, not polish

[WCAG 2.2 SC 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
is **Level AA** and covers exactly this — status messages *"on the waiting state
of an application, on the progress of a process"* must be programmatically
determinable **without receiving focus**. A silent spinner is an AA gap.
`BusyButton` sets `aria-busy` and renders `pendingDetail` in a `role="status"`
region, so following the rule satisfies the criterion by construction.

### Use the shared component

[`components/common/BusyButton`](../components/common/BusyButton.tsx) makes
`pendingLabel` **required**, so the label cannot be forgotten — the same trick as
`DeleteIconButton` making the destructive colour unsettable.

**Enforced**, by rule 4 of
[`interactionStandardsCheck.ts`](../scripts/interactionStandardsCheck.ts): inside
a QuickBooks surface, a `<Button disabled={…busy…}>` fails the build.

The check is **deliberately narrow**, and the scoping is the interesting part.
`disabled={busy}` appears ~260 times across ~77 files, nearly all sub-second
Supabase writes where a spinner would be wrong — flagging those yields a check
nobody trusts and an allowlist that swallows the rule. The first draft scoped by
*import* and flagged nine buttons on the job page, which imports `quickbooksAccess`
merely to list invoice links. Scoping by **path** to the integration surfaces is
the closest honest proxy for "this control calls out". Buttons that only flip
local state (`onClick={() => setDialogOpen(true)}`) are skipped: opening a dialog
waits for nothing.

**So the rule is prose beyond those surfaces.** Widen `THIRD_PARTY_SURFACES` when
another integration grows a UI; until then, this is a rule you apply rather than
one you will be caught violating.
