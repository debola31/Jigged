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
| **High-impact / hard to reverse** — e.g. delete a whole **Part** (cascades to routing; blocked by references) | High | **Confirmation dialog**, danger style, consequences stated, Delete kept away from Cancel ([NN/g — proximity](https://www.nngroup.com/articles/proximity-consequential-options/)). |
| **Immediately-persisted row delete** — BOM material row, routing operation row (auto-saved on change) | Low–med | **Lightweight confirmation dialog** — same shape as the Part delete, less copy. This is the safety-net *floor*; see the audience note for why NOT an Undo snackbar. |
| **Staged (explicit-Save) edit** — pricing-tier removal | Low | **No dialog.** Removal is in-memory until the user clicks Save; the dirty-state indicator + the option to walk away unsaved *is* the safety net. |

> **Audience floor — why not "inline delete + Undo snackbar":** our users are
> 50–60, often on tablets on a shop floor with divided attention. Auto-dismissing
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

**Rule:** pick the model by **control type**, apply it the same way everywhere,
and always show status ([GitHub Primer — Saving](https://primer.style/product/ui-patterns/saving/), [GitLab Pajamas — Saving & feedback](https://design.gitlab.com/patterns/saving-and-feedback/)).

- **Auto-save** imperative, low-risk, easily-reversible inline edits (identity
  fields, routing operations, BOM, unit conversions, transaction notes).
- **Explicit Save** for declarative / **financial** inputs. Pricing tiers feed
  quotes, so they use a Save button + dirty state — auto-save is the wrong
  default for financial data ([GitLab](https://design.gitlab.com/patterns/saving-and-feedback/), [Figma — autosave pitfalls](https://www.figma.com/blog/behind-the-feature-autosave/)).
- **One shared indicator:** [`components/common/SaveStatus.tsx`](../components/common/SaveStatus.tsx)
  — "Saving… / Saved", in an `aria-live="polite"` region. Reuse it on every
  saving surface; don't hand-roll per-section badges.
- Never mix auto-save and explicit-save **within one form/section** in a way the
  user can't predict — that's the direct cause of "did it save?" ([Primer](https://primer.style/product/ui-patterns/saving/)).

### Current state
- ✅ `SaveStatus` adopted in identity, routing, BOM, procurement, transaction
  notes. Pricing is explicit-Save.
- ❌ **Undo-after-save for pricing — not pursued.** GitLab Pajamas advises against
  auto-saving financial data ([Pajamas](https://design.gitlab.com/usability/saving-and-feedback)),
  so explicit Save stays. With an explicit Save button **plus** a visible dirty
  indicator already in place, a separate post-save Undo is redundant — the
  deliberate action *is* the safeguard, and a tier is trivially re-edited and
  re-saved (and doesn't touch existing quotes; see §1).
- 🔻 **Navigation guard — low priority, narrow if at all.** The honest dirty-state
  indicator is the real protection. A `beforeunload` guard is a weak backstop:
  browsers show only a generic, non-customizable message (it can't name the
  unsaved tier) and it is unreliable on mobile/tablet — our primary device — and
  may not fire at all ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)).
  If added at all, use a conditional in-app (Next.js) route guard attached **only
  while genuinely dirty** and removed once saved (MDN), to avoid the false-positive
  that trains users to ignore it (the Figma "already-saved-but-warned" pitfall).

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
   Example: Delete shows on **every** job, in any production status; clicking
   explains the blocker when there is one — *kept for recordkeeping* when the job
   has a shipment or a QuickBooks invoice — instead of hiding the button or
   running a confirm→error two-step. Removal is gated by *records of value*, not
   the status label (the discriminator shop ERPs use for hard-delete).
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
