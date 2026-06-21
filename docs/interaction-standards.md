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
- Keep it low-emphasis (ghost icon, no filled-red background) for in-context row
  deletes ([Carbon — Button usage](https://carbondesignsystem.com/components/button/usage/)).
- Never rely on red **alone** — pair it with an icon/label/confirmation copy.
  Severity is carried by what happens *after* the click, not a redder red
  ([GOV.UK — Button](https://design-system.service.gov.uk/components/button/)).

### Confirmation friction — scaled, NOT uniform
Uniform confirmation dialogs cause **confirmation fatigue** — users reflex-click
"Confirm," which strips the *one* dialog that matters of its power
([NN/g — Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/)).
Scale by impact + reversibility ([Apple — Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), [Carbon — Remove pattern](https://carbondesignsystem.com/community/patterns/remove-pattern/), [M3 — Snackbar](https://m3.material.io/components/snackbar/guidelines)):

| Target | Stakes | Treatment |
|---|---|---|
| **High-impact / hard to reverse** — e.g. delete a whole **Part** (cascades to routing; blocked by references) | High | **Confirmation dialog**, danger style, consequences stated, Delete kept away from Cancel ([NN/g — proximity](https://www.nngroup.com/articles/proximity-consequential-options/)). |
| **Low-impact / trivially reversible** — BOM material row, pricing tier, routing operation row | Low | **Inline delete + Undo snackbar. No dialog.** |

> ⚠️ "Inline, no dialog" is only safe **with Undo**. A no-dialog delete without
> Undo is a silent unrecoverable delete — worse than a dialog. Build the Undo
> alongside removing the dialog.

### Current state vs this standard (gaps to close)
- ✅ Part delete: red icon + confirmation dialog.
- ✅ Row deletes (BOM/tier/operation): red icons at rest.
- ⬜ Row deletes still lack **Undo**; the BOM row delete still shows a
  confirmation dialog (over-confirmed). Target end state: drop the BOM-row
  dialog and add an **Undo snackbar** to BOM/tier/operation deletes.

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
- ⬜ Follow-up: a navigation guard for in-flight/unsaved edits; an Undo for
  pricing saves (financial change).

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
