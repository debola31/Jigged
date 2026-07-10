# PRD: Unified data import / onboarding flow

> Status: Draft. The full flow **Upload → Map → Review & Fix → Import** is built end-to-end —
> confirm-columns mapping, live review + in-app remediation (edit / bulk find-replace /
> fill-blanks / cluster-merge / guardrail-bound AI suggestions), and the dependency-ordered
> **write** (reusing the per-entity execute routes; behind the flag + a confirm gate).
> **Remaining:** the non-empty-company upsert / link-to-existing journey, and a preview E2E run
> of the live write. Supersedes the thin FR-16 "Legacy Data Migration" line in
> [docs/prd.md](../prd.md) and the retired data-health module note. Related:
> epic #492 and sub-issues #519–#524.
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

One unified **"Import your data"** flow — a single guided importer, not scattered per-entity
importers. It follows the shape every embedded data-onboarding product uses (Flatfile,
OneSchema, Nuvo/Ingestro, Dromo): **Upload → Map → Review & Fix → Import.** The owner drops
in all the CSV exports they have (or just the ones they want); Jigged reads everything
**together** and walks them through:

1. **Upload** — drag in the CSVs; they're parsed in the browser (nothing leaves the machine
   yet).
2. **Map** — Jigged **auto-detects** what each file is (parts, vendors, work centers,
   routings, BOMs, customers) and maps each raw column to the right Jigged field, then shows
   it on a **confirm-columns step** so the owner corrects any wrong guess *before* the review
   runs. Nothing is inferred-and-hidden — the review reflects the mapping they confirmed. (A
   correction here visibly changes the review, since the analyzer keys its checks on the
   confirmed roles.)
3. **Review & Fix** — reading everything read-only (nothing written, nothing stored), Jigged
   shows a plain-English **review** that leads with the single most important blocking issue
   and a plain verdict (**"Ready to import" / "1 thing to fix"**), then a prioritized **"What
   to fix"** checklist, then a **"What you're importing"** outlook (record counts + how the
   entities reference each other and where those references are broken), then a **"To finish
   setup"** list that prompts for missing data or files. The owner fixes it **in-app** (see
   the guided-remediation target below) rather than in spreadsheets.
4. **Import** — a preview of **exactly what will be created** (dependency-ordered: vendors
   and work centers first, then parts, then routings and BOMs; relationships auto-resolved;
   anything excluded called out so nothing silently drops), then the write behind a single,
   explicit final action. *(Phase 1 stops just before the write — deferred to a
   white-glove/guided step; the flow goes right up to ingestion.)*

**The Review & Fix stage is guided remediation, not a read-only report.** Phase 1 ships the
review read-only; the target experience does more than *flag* problems and send the owner
off to fix data in spreadsheets: it **guides them to fix the data inside Jigged.** Each issue
becomes a **decision with a recommended default** — merge look-alike duplicates, fill or
confirm missing values, add the missing records a routing references, link a row to data
already in Jigged — fixable **inline and in bulk in a spreadsheet-like grid**, with a
**running verdict** ("Ready to import? / here's what you still need") and an explicit
pre-commit confirmation. AI *proposes* fixes; it never applies them silently.

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

**Review — reading it**
10. As a shop owner, I want the review to open with a one-line verdict (ready / almost /
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

**Importing when data already exists (upsert)**
35. As an established shop owner, I want an obvious place to import more data even when my
    shop already has data (not only on the empty first-run screen), so that I can add data
    whenever I need to.
36. As an established shop owner, I want to import more parts (or any type) without creating
    duplicates of what's already in Jigged, so that my data stays clean.
37. As an established shop owner, I want the import to recognize records I already have (by
    part number, vendor name, etc.) and update them instead of duplicating, so that I can
    refresh data safely.
38. As an established shop owner, I want to choose whether to only add new records, only
    update existing ones, or both, so that I control the effect of the import.
39. As an established shop owner, before importing I want to see how many records are new,
    how many will be updated, how many are already up to date, and how many conflict, so
    that there are no surprises.
40. As an established shop owner, I want records that are identical to what I already have
    skipped automatically, so that I'm not needlessly touching data.
41. As an established shop owner, I want a safe default that never deletes or overwrites data
    I didn't include, so that importing can't quietly wreck my shop.
42. As an established shop owner, I want conflicts (e.g. same name but a different ID)
    surfaced for me to resolve rather than guessed, so that I don't corrupt records.
43. As an established shop owner, after import I want a summary of what was added, updated,
    and skipped (with reasons), so that I can verify and go fix the rest.
44. As an established shop owner who only wants to add one type, I want to start the import
    from that module (e.g. Parts), so that I don't wade through the whole onboarding flow.

**Guided remediation (fix data in Jigged, not spreadsheets)**
45. As a shop owner, I want to fix problems right here — edit a cell, fill a blank, merge
    look-alikes — instead of exporting to Excel and re-uploading, so that I get it done in
    one sitting.
46. As a shop owner, I want to fix a repeated problem in one move (e.g. rename a mistyped
    vendor everywhere at once), so that I'm not editing hundreds of cells by hand.
47. As a shop owner, when the tool spots likely duplicates or spelling variants, I want it to
    group them and let me merge / keep separate / ignore — with a suggested default — so that
    I decide quickly without judging every pair from scratch.
48. As a shop owner, when a routing references a work center I didn't include, I want to be
    offered to add the missing work centers (or accept those rows being skipped), so that I
    complete the picture instead of hitting a dead end.
49. As a shop owner, I want the AI to suggest a fix but never change my data without my yes,
    and to let me undo, so that I stay in control of my own records.
50. As a shop owner, I want the AI to tell me when it's NOT sure ("these might be the same —
    can you confirm?") rather than sound confident, so that I don't rubber-stamp a wrong fix.
51. As a shop owner, I want a running "here's exactly what will import" and a verdict that updates
    that updates as I fix things, so that I can see progress and know when I'm ready.
52. As a shop owner, I want the tool to clearly separate "we fixed this for you" from "you
    still need to handle this", so that I know what's been done on my behalf.

## Implementation Decisions

- **One unified import surface**, not per-entity importers. Only a surface that sees all
  the files together can auto-classify, resolve cross-entity relationships, and write in
  dependency order. This mirrors the Salesforce unified Data Import Wizard and HubSpot's
  single multi-object import tool (both recommended over object-specific imports for
  non-technical users). The existing per-entity import pages are folded into / redirect to
  this surface over time; a module's empty-state "Import" becomes a link to the one
  importer, not a separate wizard.

- **Where each stage runs (the load-bearing architecture decision):** the uploaded rows are
  already parsed in the browser and the review is read-only, so the **deterministic
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

- **Review information architecture** (inverted pyramid, progressive disclosure):
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

- **Read-only / no-write guarantee.** The review endpoints only ever SELECT (verify
  access, read the feature flag, resolve the AI provider); they perform no table writes, no
  `auth.admin`, and keep no on-disk cache of uploaded rows. This is enforced by a test.

- **Flow shape.** A guided, sequential wizard: *What you'll need → Upload & auto-classify →
  Review & Fix → Confirm what will be created → Import*. The final Import is the single,
  explicit, separate write action. **Phase 1 stops at that line** — the write is deferred
  to a white-glove/guided step. Phase 2 wires the actual dependency-ordered write, reusing
  the existing per-entity import execution as the write layer.

- **Guided remediation — the target experience (mostly Phase 2), research-backed.** The
  evolution from *report* to *fix-it-here* follows the embedded-import product pattern
  (Flatfile, OneSchema, Nuvo/Ingestro, Dromo) and no-code remediation (OpenRefine):
  - **Linear staged flow, never an upfront wall of errors:** upload → AI-suggested mapping
    (confirmable) → guided review/fix → running "what will import" → confirm → write.
  - **Fix in-app in a spreadsheet-like grid** (double-click-edit, sort/filter, find-and-
    replace); an Excel export is a fallback, not the path.
  - **Bulk over cell-by-cell** — one-click autofix + column-wide find-and-replace so a
    systemic issue is fixed once ("don't fix data 1 cell at a time").
  - **Each issue is a decision with a recommended default:** duplicates/variants →
    cluster-and-merge (merge / keep-separate / ignore); missing values → fill or
    confirm-blank; orphan refs → add the missing parent records or accept-skip;
    link-to-existing → reconciliation-style matching against the shop's OWN records, with
    per-edit approval.
  - **Say what's missing UPFRONT + a verdict** ("ready? / you still need Y"),
    before the owner invests effort.
  - **Three never-blurred visual states:** auto-fixed vs. warning (review, still accepted)
    vs. blocking (must fix) — maps onto the existing severity buckets.
  - **Plain, no-blame, problem+solution copy, inline at the field, after they finish it
    (not while typing)** — the human-guide tone encoded as AI copy.

- **AI-fix guardrails — the strongest-evidenced rule (Microsoft Research "Overreliance on
  AI" review).** This exact audience (non-technical, low-AI-literacy) blindly OVER-trusts AI
  (≈7× more likely to follow it in one study), and confidence scores / persuasive
  explanations BACKFIRE — they inflate over-reliance rather than calibrate it. Therefore:
  - **Never silently apply an AI fix** to business data — every AI suggestion is a
    confirmable, reversible proposal with an explicit accept/reject.
  - **Don't sell trust with a confidence badge.** Where the AI explains, it **reveals its
    limits/uncertainty** ("I'm not sure these are the same — please confirm"), which reduces
    over-reliance, rather than persuading.
  - **Cognitive-forcing + human-in-the-loop:** the user decides per fix (decide-before-
    reveal for ambiguous ones), and the final write is gated behind an explicit "here's
    exactly what will be created/updated." Tune friction to stakes — forcing carries a
    satisfaction cost, so obvious fixes stay light and ambiguous/high-impact ones get it.

- **Importing into a non-empty company is an UPSERT, not a load.** When the shop already
  has data, the unified flow gains a **reconciliation step**: match each uploaded row
  against existing Jigged records by the entity's identity key (parts by `part_name` /
  `legacy_id`; vendors, work centers, customers by `name`) and bucket every row as **New**,
  **Update** (fields differ), **Unchanged** (identical → skip), or **Conflict** (e.g. same
  name, different id → surface, don't guess). The owner chooses a **mode** — default
  **Add new + update existing** (non-destructive: only the columns present are written,
  nothing is deleted, unchanged rows are skipped), or create-only, or update-only. The
  pre-commit review becomes **"what will change"** with the bucket counts + a downloadable
  skip list, and the post-import summary reports added / updated / skipped. The existing
  per-entity importers already implement the write-side upsert (conflict detection vs.
  existing rows + `legacy_id` ON CONFLICT), so Phase 2 reuses that; the pre-import *preview*
  needs only a bounded, read-only fetch of existing identity values (RLS-safe) to bucket
  new-vs-update. This whole capability is **Phase 2** — Phase 1 handles the empty
  (greenfield) case, where every row is "New." Research basis: HubSpot / Salesforce /
  Insycle import modes + match keys; Dynamics 365 duplicate detection; categorized
  preview + skip file.

- **Placement (decided): one flow, several purpose-built signposts.** Multiple *entries* to
  the one flow are fine; multiple *flows* is the anti-pattern. There is no permanent nav
  module (the old "Data Health" item was removed).
  - **First-run onboarding (empty shop):** a **"Get started" checklist** on the empty
    dashboard, leading with "Import your data" (research: Dynamics 365 Business Central's
    Get-started banner-that-reveals-a-checklist; Appcues onboarding-checklist completion
    lift). Shown until the shop has data; flag-gated.
  - **Empty module lists:** each module's empty state (Parts / Vendors / Work centers /
    Customers) links to the **same** unified importer ("Import all your data at once").
  - **Non-empty shop (data already present) — the recurring entry.** Neither the checklist
    nor the empty-states show once there's data. Because related data must be imported
    *together* to auto-resolve links and load in dependency order (isolated per-entity
    imports are exactly what forces manual reconciliation later — the Salesforce
    "split into per-object lists" failure mode), the recurring entry is a **low-emphasis
    "Import data" item in the sidebar's utility area** (near Team/Settings) that launches
    the one unified, relationship-aware importer. Rationale (designer review): a prominent
    action in the dashboard's top app bar over-emphasized an infrequent task on the primary
    status screen the user opens first, and was inconsistent (visible only on the dashboard,
    so unreachable from other pages — fails recognition-over-recall). A utility sidebar item
    is instead **persistent and consistent across every page, always findable, and quiet** —
    it stays out of the dashboard's KPI spotlight (which must lead the content: NN/G "KPIs
    lead"; Stripe/Linear "calm KPI row up top"). It reads as utility (grouped with
    Settings), not a loud primary destination, and onboarding discoverability stays on the
    Get-started checklist + empty-states so this entry can afford to be understated. The
    per-module toolbar "Import" buttons stay for a
    genuinely isolated single type (e.g. just customers), and in Phase 2 they **route into
    the unified importer** (scoped to that module but able to pull in related files), so
    even single-entity adds are relationship-aware. Model: HubSpot's one import tool that
    ingests multiple related objects at once and auto-associates them; Dynamics 365's
    multi-entity, dependency-sequenced import jobs.
  - **Not** a Settings → Import area — the onboarding research doesn't point there and it
    duplicated the recurring role; dropped.

## Testing Decisions

Good tests here assert **external behavior**, not implementation details — given a set of
uploaded files (or findings) in, assert the findings / verdict / review structure out; do
not assert private helpers or DOM internals. Three seams, fewest and highest:

1. **Review engine (primary seam)** — the pure browser modules that compute findings and
   the review view-model. Behavior tested: entity classification handling, within-file
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
   `/import` with sample CSV fixtures: upload → analyze → a verdict renders →
   review "what will be created" → the import step appears. Prior art: the existing `e2e/`
   Playwright specs and their seeded-data conventions.

New tests get added for the dependency-ordered **review/plan** logic and, in Phase 2, the
ordered write, at the same seams (pure planner logic in vitest; the write behind the
endpoint/pytest seam; one E2E through the whole journey).

## Out of Scope

- **The actual ingestion write (Phase 2).** Phase 1 goes right up to ingestion; the final
  write is deferred to a white-glove/guided step and is not built here.
- **Inline fix-in-place editing** (the guided-remediation grid, cluster-merge, bulk fix,
  link-to-existing) is the **Phase 2 target**, not out of scope permanently — see the
  "Guided remediation" implementation decision + user stories #45–52. **Phase 1** is
  review-and-re-upload: the owner fixes in their source files and re-checks.
- **Detection-template / gotcha-rule library and fine-tuning harvesting** (#522, #524
  payoff) — the review schema is kept reuse-ready, but harvesting is a later phase.
- **Server-side persistence of reviews** and any shareable/exported artifact (PDF).
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
- **Guided-remediation research basis (2nd adversarially-verified pass).** Staged flow +
  inline/bulk fixing + auto-mapping: Flatfile, OneSchema, Nuvo/Ingestro, Dromo.
  Cluster-and-merge dedup + reconciliation matching: OpenRefine. Inline, at-the-field,
  no-blame, problem+solution error copy: NN/G. AI over-reliance guardrails (low-literacy
  users over-trust; confidence scores / persuasive explanations backfire; use
  cognitive-forcing + human-in-the-loop): Microsoft Research Aether "Overreliance on AI"
  review.
- **Honest gaps / open questions (from the research caveats).**
  - **No verified ROI.** The one "inline fixing → +50% completed imports" stat was refuted
    (vendor marketing); adopt these patterns as well-attested best practice, not proven ROI.
  - **Human white-glove playbooks + manufacturing-specific onboarding produced no surviving
    sources** — the "here's what I'd do / celebrate progress / reassure about not losing
    data" techniques are *inferred* from the plain-language + human-in-the-loop findings,
    not directly sourced.
  - **Linking to the shop's OWN in-app records** is only *analogous* to OpenRefine
    reconciliation (which links to EXTERNAL databases); the merge/approve UX transfers, but
    the right default (auto-link high-confidence vs. always-ask, minimizing mis-links vs.
    fatigue) is an open design question.
  - **Presenting AI-fix rationale** to a low-literacy user without inducing blind trust:
    reveal limits/uncertainty rather than confidence scores — the exact UI recipe is
    unvalidated and should be usability-tested with real owners.
- **Personas.** Primary: the shop owner/admin (non-technical, 50–60, on desktop or a
  bright-light shop tablet). Secondary: the Jigged white-glove migrator who currently does
  the actual write, for whom the review is the pre-flight.
- **Source systems seen so far.** Tangle (real, from customer #1), plus JobBOSS/E2 and
  spreadsheets expected. The tool must not depend on prebuilt per-ERP signatures; detection
  is AI-first and may return "unknown" without degrading the review.
- **Companion design doc.** The Phase 2 *how* — guided-remediation mechanics + the
  dependency-ordered ingestion write (reusing the per-entity execute routes) + upsert — is
  specced in [data-import-phase2-design.md](data-import-phase2-design.md).
