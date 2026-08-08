# Jigged Documentation

Jigged is a data platform for small precision manufacturing shops.

**Start with [CLAUDE.md](../CLAUDE.md)** — it carries the rules that bind every change (API
architecture, migrations, grants, the billing write-gate, the design system). This tree carries
the detail, including the doc-writing standard in [writing-docs.md](writing-docs.md).

## Product

| Doc | What it is |
|---|---|
| [prd.md](prd.md) | Functional requirements, each with a **verified build status**; the flows; and §4.3, the shop-floor capture model that other docs treat as canon |
| [architecture.md](architecture.md) | System architecture — the most-linked doc here; §8 (API standard) and §16 (soft-delete) are cited by number |
| [design-system.md](design-system.md) | The visual spec: canvas, glass cards, buttons, scales, detail-page patterns |
| [interaction-standards.md](interaction-standards.md) | Normative interaction rules, **machine-enforced** by `scripts/interactionStandardsCheck.ts` |
| [telemetry.md](telemetry.md) | Everything we collect: Sentry/Vercel observability, PostHog product analytics, the traps, and the **machine-enforced** event registry |
| [brand-guide.md](brand-guide.md) | Palette, logo, and the only writing-voice guidance in the repo |

## Modules

Detailed specs live in [modules/](modules/).

> **Journey specs are not a separate tier.** Each module doc carries its own journeys beside its
> current state — see [inventory.md](modules/inventory.md) and
> [operator-view.md](modules/operator-view.md). The two-file split was tried twice
> (`docs/inventory-flow.md`, `docs/operator-paperless-flow.md`) and **both times the journey doc
> drifted from its module doc** — the second ended up contradicting itself about which journeys
> had shipped. Keep them in one file.

**Selling and ordering:** [customers.md](modules/customers.md) ·
[quotes.md](modules/quotes.md) · [invoicing.md](modules/invoicing.md) ·
[billing.md](modules/billing.md)

**Making:** [parts.md](modules/parts.md) · [routings.md](modules/routings.md) ·
[jobs.md](modules/jobs.md) ·
[work-centers.md](modules/work-centers.md) — owns the station = work-centre definition and the
`operation_types` terminology history ·
[vendors.md](modules/vendors.md) · [shipments.md](modules/shipments.md)

**Shop floor:** [operator-view.md](modules/operator-view.md) — screens, quantity capture, the
notes read-back loop, and the operator journeys ·
[machine-maintenance.md](modules/machine-maintenance.md) — flag-gated pilot with a written kill
criterion · [inventory.md](modules/inventory.md)

**Office and platform:** [dashboard.md](modules/dashboard.md) ·
[ai-insights.md](modules/ai-insights.md) — its table allow/denylist is a security boundary ·
[data-import.md](modules/data-import.md) · [demo-mode.md](modules/demo-mode.md) ·
[invitation-system.md](modules/invitation-system.md)

## Testing and runbooks

- [testing/README.md](testing/README.md) — where each layer lives, the invariant guards, the
  local-Supabase JWT fixtures, conventions and known holes
- [runbooks/local-dev-and-testing.md](runbooks/local-dev-and-testing.md) — E2E setup, running from
  a git worktree, Vercel-preview verification, and the E2E gotchas
- [runbooks/typed-select-drift.md](runbooks/typed-select-drift.md) — **proposed**: derive
  `.select()` result types with `QueryData` instead of hand-writing them. Also records what `tsc`
  can and cannot see about a select (FK hints: nothing), which is why `schemaEmbedCheck.ts` stays
- [usability-tests/](usability-tests/) — research instruments. Findings are deliberately
  **not** committed (`.gitignore`: `*findings*`), because they hold session data

## How these are written

The doc-writing standard lives in [writing-docs.md](writing-docs.md):
most information in the fewest words, losing none of it, on the principle that **a claim no build
can falsify will rot**. Exemplars: [inventory.md](modules/inventory.md) for a journey/decision doc,
[customers.md](modules/customers.md) for a reference doc, [billing.md](modules/billing.md) for an
invariant.
