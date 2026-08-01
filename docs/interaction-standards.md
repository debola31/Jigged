# Interaction Standards

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
- Enforced by [`__tests__/standards/interactionStandards.test.ts`](../__tests__/standards/interactionStandards.test.ts):
  a delete icon set to `text.secondary` fails CI. (Glyph choice is a per-call-site
  judgment, not machine-enforced.)
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
| **High-impact / hard to reverse** — e.g. delete a whole **Part**, which **archives** it (soft-delete via `deleted_at`) and never blocks | High | **Confirmation dialog**, danger style, consequences stated, Delete kept away from Cancel ([NN/g — proximity](https://www.nngroup.com/articles/proximity-consequential-options/)). This is [`DeleteImpactDialog`](../components/common/DeleteImpactDialog.tsx), which states the impact (quotes/jobs that reference the part, other parts whose cost will change) — a warning, never a block. See [Architecture §16](architecture.md#16-deletion--archiving-policy). |
| **Immediately-persisted row delete** — BOM material row, routing operation row (auto-saved on change) | Low–med | **Lightweight confirmation dialog** — same shape as the Part delete, less copy. This is the safety-net *floor*; see the audience note for why NOT an Undo snackbar. |
| **Staged (explicit-Save) edit** — pricing-tier removal | Low | **No dialog.** Removal is in-memory until the user clicks Save; the dirty-state indicator + the option to walk away unsaved *is* the safety net. |

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
> dialog when recovery is **durable** — a soft-delete + "recently deleted /
> restore" affordance (the pattern already used for customers, `softDeleteCustomer`)
> — never a timed toast.

### Current state vs this standard
- ✅ Part delete: red icon + confirmation dialog.
- ✅ Row deletes (BOM / tier / operation): red icons at rest.
- ✅ Shared `DeleteIconButton` + a CI source-scan test enforce red-at-rest.
- ✅ BOM material delete: confirmation dialog (correct — keep it).
- ✅ Routing-operation delete: now gated by a confirmation dialog. It auto-saves
  on change, so without this it was a silent, unrecoverable delete — the one real
  gap, now closed.
- ✅ Pricing-tier removal: staged behind explicit Save; recoverable by not saving,
  and it does **not** alter existing quotes (line items snapshot `unit_price`; the
  `source_tier_id` FK is `ON DELETE SET NULL`), so it is not the financial hazard
  it appears to be.
- 🔄 **Superseded:** the earlier target of "drop the BOM dialog + add Undo
  snackbars to BOM/tier/operation" is reversed after UX research (the audience
  floor above). We keep dialogs on destructive row deletes; ephemeral Undo is not
  our pattern. Issues #394 / #396 were closed with this rationale.

---

## 2. Saving

**Rule:** pick the model by **what is being edited**, apply it the same way
everywhere, always show status, and never let one section destroy another's
work ([GitHub Primer — Saving](https://primer.style/product/ui-patterns/saving/), [GitLab Pajamas — Saving & feedback](https://design.gitlab.com/patterns/saving-and-feedback/)).

### The three modes

| Mode | Applies to | Commits on | Indicator |
|---|---|---|---|
| **Auto-save** | a single, independently-valid, non-financial value: identity fields, transaction notes, costing **batch size**, preferred vendor | blur (text/number) or change (toggle/select) | `SaveStatus` |
| **Row editor → Save/Cancel**, then persists immediately | a multi-field record only valid as a *set*: routing operations, BOM materials, unit conversions | the editor's own Save | `SaveStatus` on the panel |
| **Staged explicit Save** | **financial** data that feeds quotes: pricing tiers, procurement cost tiers | the card's Save button | dirty row accent + sticky footer (below) |

Auto-save is wrong for financial data ([GitLab](https://design.gitlab.com/patterns/saving-and-feedback/), [Figma — autosave pitfalls](https://www.figma.com/blog/behind-the-feature-autosave/)); a row
editor is the right shape for a record whose fields are meaningless
individually, and it is what Polaris recommends for independently-editable
sections of one page. This leaves the part page with exactly **two**
explicit-Save surfaces, both tier tables — so a Save button reliably means
"this is money."

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

This is the rule the standard was missing, and its absence cost a real customer
real work. The part page broadcasts one page-wide `refreshKey` after every
mutation; `PartPricing` consumed it by re-seeding its editable tier rows from
the database and calling `setDirty(false)`. So typing a new Min qty and *then*
editing an operation — two cards sitting side by side — silently reverted the
typed value. The old rule only forbade mixing models *within* a section, and
said nothing about one section reaching into another.

The fix shape: gate the draft re-seed on "not dirty" (and on the record not
having actually changed), while leaving the derived-data refetches on the
refresh signal untouched. See `PartPricing.tsx`'s load effect, and the
regression test in
[`__tests__/components/parts/PartPricing.test.tsx`](../__tests__/components/parts/PartPricing.test.tsx).

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
dialog.

### Making "unsaved" visible

A dirty indicator only works if it is seen. The original one — `variant="caption"`
in `text.secondary`, at the bottom of the tier table, next to a `size="small"`
button — was not, and that is *why* the change was still unsaved when the wipe
hit. Attention is on the field being typed, not the card chrome
([NN/g — Change Blindness](https://www.nngroup.com/articles/change-blindness/):
put feedback next to where the user is working), and users routinely miss a
separate commit button beside a field they just filled in
([Baymard — avoid "Apply" buttons](https://baymard.com/blog/checkout-usability-apply-buttons)).

Two signals, both persistent (never a timed toast — see §1's audience floor):

- **At the row** — the same `3px` left accent the incomplete BOM and routing
  rows use, one rung down that ladder: `error.main` = broken, **`warning.main` =
  wants your attention**, `transparent` = fine. An unsaved edit is the middle
  rung; it is *not* a mistake and must not read as one. Red is reserved for
  broken on purpose (`design-system.md` §"subtractive vs destructive").
- **At the card** — a sticky footer that appears only when dirty, naming the
  count and offering **Discard** and **Save**. It is hidden when clean rather
  than disabled-and-visible: with nothing to save the action is genuinely
  irrelevant, not blocked (§4 rule 3), and a permanently-present Save button
  carries no signal. Its *appearance* is what tells the user work is pending.

### Current state
- ✅ `SaveStatus` adopted in identity, routing, BOM, procurement, transaction
  notes. Pricing + procurement tiers are explicit-Save.
- ✅ **Section isolation** enforced in both tier tables, with a regression test
  that fails if the guard is removed.
- ✅ **Exit guard**: tab-switch confirmation + conditional `beforeunload`, both
  driven by `onDirtyChange` reporting into `PartWorkspace`.
- ✅ **Batch size auto-saves on blur.** It used to have its own Save button
  inside the Cost card — a third staged-save surface for a value that is a
  costing assumption, not a price. Moving it to auto-save is what makes "a Save
  button means money" true rather than approximately true.
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
  >
  > **Known gap:** in-app *route* navigation (breadcrumb, links in the
  > completeness banner) is still unguarded. Next.js App Router exposes no
  > router-event hook, so covering it means intercepting link clicks; that is
  > deliberately not built rather than half-built. The tab switch — by far the
  > most common way to leave — is guarded.

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
   Example: Delete shows on **every** job, in any production status. It now
   **archives** the job (soft-delete via `deleted_at`) rather than hard-deleting, so
   it **always succeeds** — presented through a consequence-summary dialog, never a
   confirm→error two-step. The former *records-of-value* guards (which blocked a job
   that had a shipment or a QuickBooks invoice) were **removed**: archive preserves
   that history intact, so there is nothing left to block (see
   [Architecture §16](architecture.md#16-deletion--archiving-policy)). The
   keep-visible-and-explain rule still governs genuinely-blocked actions — see the
   invoiced-line lock in rule 2.
2. **Disable only for a stable lock** whose disabled state is itself meaningful,
   paired with a *visible* reason (not hover-only); prefer `aria-disabled` so it
   stays focusable. Example: once invoiced in QuickBooks, "Edit line" is disabled
   with a 🔒 icon **and** a visible "View invoice" button signalling the lock.
3. **Hide only when the action is irrelevant in this context** — the user's role
   or this object can *never* do it — not when it's merely temporarily blocked.
   Hiding a temporarily-unavailable control hurts learnability: users can't tell
   it exists, or assume it's never available ([Jakob Nielsen — Inactive Controls: Show, Disable, or Hide?](https://www.uxtigers.com/post/inactive-buttons)).

Avoid: a confirm dialog that ends in an error ("are you sure?" → "can't do that")
— two steps to a dead-end. Resolve via rule 1.
