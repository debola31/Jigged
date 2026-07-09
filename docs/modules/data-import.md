# PRD: Unified data import / onboarding flow

> Status: Draft (Phase 1 readiness slice built; ingestion deferred) · Supersedes the thin
> FR-16 "Legacy Data Migration" line in [docs/prd.md](../prd.md) and the removed
> `data-health-report.md` module note. Related: epic #492 and sub-issues #519–#524.
> Generated with the `to-prd` skill from the design conversation; also published to the
> issue tracker with the `ready-for-agent` label.

## Problem Statement

A machine-shop owner adopting Jigged already runs their business in a legacy system —
JobBOSS, E2, Tangle, or a pile of spreadsheets — with years of parts, vendors, work
centers, routings, and bills of material in it. To get value from Jigged they have to get
that data in, and today that is the scariest, most error-prone part of switching:

- They don't know **what's actually in their files** or whether the data is any good.
- They don't know **what will happen** if they import it — and they're afraid of losing
  history or ending up with a broken, half-populated shop.
- Their data is **interconnected** (a routing step points at a work center; a part points
  at a vendor; a BOM line points at a part), but the only tools available import **one
  entity at a time in isolation**, so those links break and the owner has to hand-wire
  them or discover the breakage after the fact.
- The findings they do get are buried in a wall of text with the important, blocking issue
  hidden three paragraphs down, and status shown only by color they can't act on.

The owner is not technical and is often 50–60 years old. They need to be told, in plain
language and in priority order, what's there, what's wrong, what's missing, and exactly
what their shop will look like once the data is in — in **one place**, before anything is
written.

## Solution

One unified **"Import your data"** flow — a single surface, not scattered per-entity
importers. The owner drops in all the CSV exports they have (or just the ones they want).
Jigged, reading everything **together**:

1. **Auto-detects** what each file is (parts, vendors, work centers, routings, BOMs,
   customers) and lets the owner correct a wrong guess.
2. **Checks the data read-only** — nothing is written, nothing is stored — and produces a
   plain-English **readiness report** that leads with the single most important blocking
   issue, then a prioritized "what to fix" checklist, then a "what you're importing"
   outlook (record counts + how the entities reference each other and where those
   references are broken), then a "to finish setup" list that prompts for missing data or
   files.
3. **Previews exactly what will be created** — a dependency-ordered plan (vendors and work
   centers first, then parts, then routings and BOMs) with relationships auto-resolved and
   anything that would be excluded called out explicitly, so nothing silently drops.
4. **Imports** in that dependency order behind a single, explicit final action. *(Phase 1
   stops here: the write is deferred to a white-glove/guided step; the flow goes right up
   to ingestion.)*

The same surface serves both the first-time "bring my whole shop in" journey and the later
"just add/refresh my parts" journey — the latter is simply the former with fewer files.

## User Stories

**Getting started / entry**
1. As a new shop owner, I want an obvious "Import your data" starting point when my shop is
   empty, so that I know how to get my existing data in without hunting for it.
2. As a new shop owner, I want the import flow to live in one place (not a permanent nav
   item I'll never use again), so that the app doesn't feel cluttered after I'm set up.
3. As a shop owner, I want to be told up front what I'll need (which exports, as CSV), so
   that I can prepare my files before I start.
4. As a shop owner, I want to know I can bring only some of my data now and more later, so
   that I'm not blocked waiting to have everything perfect.

**Uploading & classifying**
5. As a shop owner, I want to drag in several CSV files at once, so that I don't have to
   repeat the process per entity.
6. As a shop owner, I want the system to tell me what each file appears to be (e.g. "this
   is your parts list"), so that I don't have to know Jigged's internal categories.
7. As a shop owner, I want to correct the system if it labels a file wrong, so that the
   rest of the check is accurate.
8. As a shop owner, I want to add or remove files before analyzing, so that I control
   exactly what gets checked.
9. As a shop owner, I want very large files to work, so that my 18,000-line routings export
   doesn't fail.

**Readiness report — reading it**
10. As a shop owner, I want the report to open with a one-line verdict (ready / almost /
    not ready) and the single biggest problem, so that I immediately know where I stand.
11. As a shop owner, I want a short count of how many blocking issues, things to review,
    and informational notes there are, so that I can gauge the size of the job.
12. As a shop owner, I want the problems listed in priority order (blocking first), so that
    I fix the things that matter first.
13. As a shop owner, I want each problem stated in plain language with how many records it
    affects and a concrete example, so that I understand it without a data analyst.
14. As a shop owner, I want each problem to tell me exactly what to do about it, so that I
    can act instead of guess.
15. As a shop owner with a vision impairment or on a bright shop-floor tablet, I want
    severity shown by icon and words, not just color, so that I can tell what's urgent.
16. As a shop owner, I do NOT want a wall of AI text or a green "all good" badge sitting
    next to a critical problem, so that I'm not misled or overwhelmed.
17. As a shop owner, I want the full AI write-up available but tucked away, so that I can
    read more if I want but I'm not forced to.

**What I'm importing (outlook & relationships)**
18. As a shop owner, I want to see how many parts, vendors, work centers, routing steps,
    and BOM lines will come in, so that I can sanity-check the totals against what I expect.
19. As a shop owner, I want to see how my data connects (parts → vendors, routing steps →
    work centers, BOM → parts) and where those connections are broken, so that I trust the
    result won't be a broken shop.
20. As a shop owner, I want unmatched references quantified (e.g. "6,565 of 18,639 routing
    steps point to a work center that isn't in your files"), so that I grasp the scale of a
    problem.

**Missing data & completeness**
21. As a shop owner, I want to be told what's missing to finish setup (a required column, or
    a whole file my other data references), so that I know what still to gather.
22. As a shop owner, I want to be prompted to upload an additional file when my data
    references something I didn't include, so that I can complete the picture in one sitting.
23. As a shop owner, I never want a check to silently pass when it couldn't actually run, so
    that "no problems" always means "we looked and it's fine."

**Review & import**
24. As a shop owner, I want to review a clear summary of exactly what will be created before
    anything is written, so that I'm in control.
25. As a shop owner, I want the import to happen in the right order automatically (vendors
    before parts, parts before routings/BOMs), so that my relationships link up instead of
    breaking.
26. As a shop owner, I want any records that will be skipped (and why) shown before import,
    so that nothing disappears without my knowledge.
27. As a shop owner, I want a single, clearly-labeled action that actually writes the data,
    separate from reviewing, so that I never import by accident.
28. As a shop owner, if I still have blocking issues at import time, I want to be warned and
    advised to fix them first, so that I don't knowingly import broken data.
29. As a shop owner, after import I want to see what was created and what was skipped and
    why, so that I can go fix the rest and re-run.

**Later top-ups**
30. As an established shop owner, I want to add or refresh a single entity (e.g. re-import
    parts) through the same flow, so that I don't learn a different tool later.
31. As a shop owner re-importing one file, I want to be told if it references data that
    isn't in Jigged yet, so that I don't create orphans.

**Trust, privacy, safety**
32. As a shop owner, I want to know nothing is imported or saved until I say so, so that I
    can explore the check risk-free.
33. As a cautious owner, I want my raw data to stay on my machine during the check, so that
    I'm comfortable running it before I've committed to Jigged.
34. As an admin, I want only authorized company members to run the import for my company, so
    that my data isn't exposed.

## Implementation Decisions

- **One unified import surface**, not per-entity importers. Only a surface that sees all
  the files together can auto-classify, resolve cross-entity relationships, and write in
  dependency order. This mirrors the Salesforce unified Data Import Wizard and HubSpot's
  single multi-object import tool (both recommended over object-specific imports for
  non-technical users). The existing per-entity import pages are folded into / redirect to
  this surface over time; a module's empty-state "Import" becomes a link to the one
  importer, not a separate wizard.

- **Where each stage runs (the load-bearing architecture decision):** the uploaded rows are
  already parsed in the browser and the readiness check is read-only, so the **deterministic
  analysis runs in the browser** and the rows never reach the server. This makes file size
  effectively unbounded (no request-body limit), and strengthens the "nothing is stored"
  promise. The server keeps only the two steps that need the secret AI key and take tiny
  payloads: a **structure** step (classify each file's entity + map its raw columns to
  canonical fields + detect the source ERP) and a **narrative** step (turn the
  client-computed findings into grounded prose). This split is by concern, not duplication
  — the deterministic logic has a single home (the browser module).

- **AI is used only for structure detection and the narrative**, never for the counts. The
  narrative is grounded strictly in the deterministic findings (it may only cite their
  counts; it never invents numbers). AI calls fire only on an explicit user action, are
  gated by a per-company feature flag + caller authorization, and are rate-limited.

- **Cross-file relationships and dependency order.** The importer resolves references
  between entities (parts→vendors, work_centers→vendors, routings→work_centers,
  routings→parts, bom→parts) and, at write time, imports in topological order so parents
  exist before children:

      Tier 0 (no deps, parallel):  vendors, work centers, customers
      Tier 1:                      parts        (needs vendors)
      Tier 2:                      routings     (needs parts + work centers)
      Tier 2:                      bill of materials (needs parts)

  Joins are **asymmetric** (parts identify by part_name; vendors/work_centers/customers by
  name) and matched normalized (case/whitespace-insensitive) so spelling noise doesn't
  create phantom orphans. If a referenced tier's file is absent, the flow imports what's
  resolvable and flags the blocked references explicitly rather than silently dropping them.

- **Readiness report information architecture** (inverted pyramid, progressive disclosure):
  a one-line **verdict** leading with the single most important blocking issue and
  bucketed counts; a prioritized **"What to fix"** checklist (three-tier severity, ordered
  critical > warning > info, each item = plain-language what's wrong + affected count +
  example + what to do); a **"What you're importing"** outlook (per-entity record counts +
  a relationship-health view); a **"To finish setup"** list (missing columns / gaps /
  unverified references + an upload-more prompt); and the AI narrative demoted into a
  collapsible details section.

- **Severity is a fixed three-tier model** (critical / warning / info). Severity is
  encoded with **icon + text label + color together, never color alone** (WCAG 1.4.1 Level
  A; IBM Carbon status-indicator pattern; 3:1 non-text contrast so it survives grayscale).
  Informational/"passing" state produces **no green badge** — indicators are reserved for
  things that need attention, which is why the old green confidence chips were removed
  (confidence is now shown only when a classification is low-confidence).

- **Read-only / no-write guarantee.** The readiness endpoints only ever SELECT (verify
  access, read the feature flag, resolve the AI provider); they perform no table writes, no
  `auth.admin`, and keep no on-disk cache of uploaded rows. This is enforced by a test.

- **Flow shape.** A guided, sequential wizard: *What you'll need → Upload & auto-classify →
  Readiness report → Review what will be created → Import*. The final Import is the single,
  explicit, separate write action. **Phase 1 stops at that line** — the write is deferred
  to a white-glove/guided step. Phase 2 wires the actual dependency-ordered write, reusing
  the existing per-entity import execution as the write layer.

- **Placement (decided): one flow, two purpose-built signposts.** Multiple *entries* to the
  one flow are fine; multiple *flows* is the anti-pattern. There is no permanent nav module
  (the old "Data Health" item was removed).
  - **First-run onboarding:** a **"Get started" checklist** on the empty dashboard, leading
    with "Import your data" (research: Dynamics 365 Business Central's Get-started
    banner-that-reveals-a-checklist; Appcues onboarding-checklist completion lift). Shown
    until the shop has data; flag-gated.
  - **Recurring access:** each module's empty state (Parts / Vendors / Work centers /
    Customers) shows a link to the **same** unified importer ("Import all your data at
    once"). The module keeps its own per-entity "Import CSV" as the working single-entity
    write path until unified ingestion (Phase 2) lands — a shop owner adding parts looks at
    Parts, which is the natural recurring home (more so than Settings).
  - **Not** a Settings → Import area — the onboarding research doesn't point there and it
    duplicated the recurring role; dropped.

## Testing Decisions

Good tests here assert **external behavior**, not implementation details — given a set of
uploaded files (or findings) in, assert the findings / verdict / report structure out; do
not assert private helpers or DOM internals. Three seams, fewest and highest:

1. **Readiness engine (primary seam)** — the pure browser modules that compute findings and
   the report view-model. Behavior tested: entity classification handling, within-file
   duplicates, cross-file orphan references with the correct asymmetric keys, normalized
   matching (no phantom orphans), missing/blank required columns, cost coverage, name
   variants, inactive flags, "never a silent 0 / never phantom N", and the derived verdict /
   severity counts / outlook / relationship health. Prior art: the existing vitest suites
   for these modules (`__tests__/lib/*.test.ts`).

2. **AI endpoints** — the structure and narrative endpoints, with the AI provider mocked.
   Behavior tested: caller authorization, the opt-in feature gate, size caps, and the
   no-write guarantee (a static/AST check plus a runtime mock that raises on any write).
   Prior art: the existing pytest integration test for these endpoints.

3. **The wizard journey (highest end-to-end seam)** — one Playwright E2E that drives
   `/import` with sample CSV fixtures: upload → analyze → a readiness verdict renders →
   review "what will be created" → the import step appears. Prior art: the existing `e2e/`
   Playwright specs and their seeded-data conventions.

New tests get added for the dependency-ordered **review/plan** logic and, in Phase 2, the
ordered write, at the same seams (pure planner logic in vitest; the write behind the
endpoint/pytest seam; one E2E through the whole journey).

## Out of Scope

- **The actual ingestion write (Phase 2).** Phase 1 goes right up to ingestion; the final
  write is deferred to a white-glove/guided step and is not built here.
- **Inline fix-in-place editing** of flagged rows before import (OpenRefine/Talend style).
  Phase 1 is report-and-re-upload: the owner fixes in their source files and re-checks.
- **Detection-template / gotcha-rule library and fine-tuning harvesting** (#522, #524
  payoff) — the report schema is kept reuse-ready, but harvesting is a later phase.
- **Server-side persistence of reports** and any shareable/exported artifact (PDF).
- **Non-CSV sources** (direct ERP API connectors, Excel-with-multiple-sheets parsing beyond
  CSV, etc.).
- **Migrating transactional history** (quotes, jobs, shipments, invoices). Phase 1 covers
  the master data an owner needs to start: parts, vendors, work centers, routings, BOMs,
  customers.

## Further Notes

- **Research basis (adversarially verified).** IA/inverted-pyramid and scannable-over-prose:
  NN/G. Actionable, in-context findings: NN/G + Microsoft Purview. Three-tier severity with
  drill-down + "no green noise": Great Expectations Cloud + Microsoft Purview. Color +
  accessibility (never color alone; icon+text+3:1): W3C WCAG 1.4.1 + IBM Carbon. Guided
  wizard with pre-commit "review what will be created" + auto-associated relationships +
  requirements up front: HubSpot + Dynamics 365. Single unified importer over scattered
  per-object imports: Salesforce Data Import Wizard + HubSpot import tool. Dependency /
  topological load order for related records: MSSQLTips / Dynamics 365 F&O data-entity
  sequencing.
- **Personas.** Primary: the shop owner/admin (non-technical, 50–60, on desktop or a
  bright-light shop tablet). Secondary: the Jigged white-glove migrator who currently does
  the actual write, for whom the readiness report is the pre-flight.
- **Source systems seen so far.** Tangle (real, from customer #1), plus JobBOSS/E2 and
  spreadsheets expected. The tool must not depend on prebuilt per-ERP signatures; detection
  is AI-first and may return "unknown" without degrading the report.
- **Companion design doc.** A short technical design doc (the ingestion write pipeline,
  reuse of the per-entity execution, planner data structures) should be written when Phase 2
  begins — deliberately not now, to avoid churn before the ingestion architecture is chosen.
