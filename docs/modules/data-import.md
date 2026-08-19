# Data import — the guided onboarding importer

> **Condensed 2026-08-03 (issue #634).** 10,619 → ~5,500 words (−48%), merging
> `data-import.md` (5,472) with `data-import-phase2-design.md` (5,147, `git rm`'d — 100% shipped,
> its §12 was twelve consecutive "Built" bullets). Cut: 55 user stories that mostly ended
> "(Shipped as …)", ~956 words of agent-orchestration literature for a layer never built, the
> build narration, and prose restating code. Kept deliberately: every withdrawn argument, every
> measured number next to what enforces it, every citation, and every named gap.
> **Corrections made** (each marked inline): the "AI is used only for structure detection" claim;
> the reconciler's bucket list; the pinned model id; the `_name_variants` symbol; "ConfirmVariants
> *replaces* MergeVariants"; the claimed `/import` E2E; and per-module Import buttons "routing into
> the unified importer". A verification pass then restored the never-a-silent-pass invariant
> (`not_checked`) and moved `FillGapDialog`'s "leave blank — intentional" to **Not built** — it was
> spec'd, never shipped.

Supersedes FR-16 "Legacy Data Migration" in [docs/prd.md](../prd.md) and the retired data-health
module note. Epic #492, sub-issues #519–#524; PRD issue #562; Phase 1 shipped on PR #561.
**Not flag-gated.** `data_import` was an opt-IN flag in
[lib/featureFlags.ts](../../lib/featureFlags.ts) while this was the second importer; it was removed
when the per-entity CSV wizards were retired, because gating the only remaining import path would
leave a shop no way to bring its data in at all.

## Problem

A shop adopting Jigged has years of parts, vendors, work centers, routings and BOMs in JobBOSS,
E2, Tangle or spreadsheets. Getting it in is the scariest part of switching: they don't know
what's in their files, or what will happen if they import (fear of a broken, half-populated shop);
the data is **interconnected** (routing step → work center; part → vendor; BOM line → part) but
per-entity importers see one file at a time, so links break and get hand-wired after the fact; and
findings arrive as a wall of text with the blocking issue three paragraphs down, status shown only
by colour.

The owner is non-technical, 50–60, on an **office computer** (importing is data setup, not a
shop-floor activity). Secondary persona: the Jigged white-glove migrator, for whom the review is a
pre-flight. Source systems seen: Tangle (real, customer #1); JobBOSS/E2 and spreadsheets expected.
Detection must not depend on prebuilt per-ERP signatures — it is AI-first and may return
`unknown` without degrading the review.

## As-built (verified 2026-08-03)

One unified importer at `/dashboard/[companyId]/import`
([page.tsx](../../app/dashboard/%5BcompanyId%5D/import/page.tsx)), five steps
(`STEPS` in that file): **What you'll need → Upload your files → Check your files → Review →
Import**. The shape every embedded data-onboarding product uses (Flatfile, OneSchema,
Nuvo/Ingestro, Dromo).

| Step | What happens | Where |
|---|---|---|
| Upload | CSVs parsed in the browser via `parseCSV`; nothing leaves the machine | `MultiFileDropzone`, `utils/csvParser` |
| Check your files (Map) | AI classifies each file's entity + maps raw→canonical columns + detects the ERP. Confident matches are **shown, not re-confirmed**; only a low-confidence file type or a missing required field is asked about, offered as real sample values not field names. Full column grid behind "see how we matched each column". Everything stays correctable on the next step, so a wrong guess is **recoverable rather than gated**. | `ColumnMappingStep`, `lib/dataImportSchema.ts`, `POST /api/data-import/structure` |
| Review & Fix | Deterministic client-side analysis → one consequence line + a task list, each task opening its own in-app fix. Prose-free. | `lib/dataImportAnalyzer.ts`, `lib/dataImportReview.ts`, `ImportReviewView` |
| Import | Plan preview + reconciliation counts + mode picker → confirm gate → dependency-ordered batched write with live progress → created/updated/skipped/errors summary | `lib/dataImportIngest.ts`, `ImportProgressPanel` |

The same surface serves the first-time "bring my whole shop in" journey and the later "just
refresh my parts" journey — the latter is the former with fewer files.

Why the Map step confirms selectively rather than asking about every column: auto-map at high
confidence and surface only the ambiguous (Flatfile / OneSchema / Dromo), confidence-based
selective confirmation plus assumption-and-undo for non-technical and older users, and the
over-reliance guardrail — **surface uncertainty, don't force confirmation of the confident.**

## Architecture

**Where each stage runs — the load-bearing decision.** Rows are parsed in the browser and the
analysis is read-only, so the **deterministic analyzer runs client-side and the rows never reach
the server**. File size is effectively unbounded (no request-body limit) and the "nothing is
stored" promise holds. The server owns only what needs the secret AI key, on tiny payloads
(findings + column samples), plus the write itself. **The split is by concern, not duplication** —
the deterministic logic has exactly one home (the browser module), so there is no second copy of a
check to drift from the first.

*(This doc previously said "AI is used only for structure detection" and "the server keeps only
the two steps"; there are three AI routes and one of them proposes fixes.)* All three live in
[`api/routes/data_import_routes.py`](../../api/routes/data_import_routes.py), prefix
`/api/data-import`, each gated by caller authorization, rate-limited
(`RateLimiter(max_requests=20, window_seconds=600)` per company), and **write-free**:

| Route | Status | Caps (enforced in that file) |
|---|---|---|
| `POST /structure` | live — classify + map + ERP detect | `MAX_FILES = 12`, `MAX_HEADERS_PER_FILE = 300` → 413 |
| `POST /suggest-fixes` | live — per-finding proposals, never auto-applied | `MAX_FINDINGS = 500` |
| `POST /narrative` | **dead from the frontend** — endpoint kept (cheap to re-enable), nothing calls it | `MAX_FINDINGS = 500` |

Pinned model: `DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6"`
([api/services/ai/model_config.py](../../api/services/ai/model_config.py)). *(The Phase 2 design
doc said `claude-opus-4-8`; it never was.)*

**No-write guarantee.** The AI routes only SELECT (verify access, resolve the provider) — no table writes, no `auth.admin`, no on-disk cache of uploaded rows. Enforced by
`test_route_module_has_no_write_calls_or_import_route_imports` in
[`api/tests/integration/test_data_import_api.py`](../../api/tests/integration/test_data_import_api.py).

**AI fires only on explicit user action** (standing repo rule) — never on mount or poll.

**The working dataset** (`lib/dataImportEditing.ts`) is the single client-side source of truth:
per file `filename`/`entityType`/`columnRoles`/`headers`/mutable `rows`, plus an ordered **edit
journal** backing undo/redo. Everything is derived: mutate → re-`analyzeBundle` → re-`summarize`
→ review + "what will import" update live, no round-trip.

Every remediation is an **`EditOp`** — a pure `(working, args) → EditOp`, applied only by the
wizard. It carries `edits: CellEdit[]` (addressed by stable `__rowId`, so it survives sort/filter)
and `addRecords: AddRecordsOp[]` (records created in-app, plus any column or whole file they
required). It is **self-describing so `invertOp` derives the exact inverse without snapshotting**
— snapshotting would copy every row on every op. Undo applies `invertOp(op)`; redo re-applies the
*original* op, which is why `removeRecords` is only ever produced by `invertOp` and never authored.

## Review step — one consequence, not a verdict

Information architecture is inverted-pyramid with progressive disclosure, scannable over prose
(NN/G). Redesigned after a usability round (the owner's words: *"I don't know where to look and what to
do"*) and three research briefs (specialist importers; NN/g + GOV.UK + IBM Carbon + Atlassian on
hierarchy/colour; MSR Aether on AI over-reliance). They converged on one **subtractive** move:
spend saturated colour exactly once, on the thing that matters now, and quiet everything else.

**Severity means consequence, not check category** — this was the root of the confusion. A blank
*required* value (7,672 parts with no unit) read as `warning`, the same amber as a harmless "no
cost", while it actually drops every one of those rows. Now `critical` = these rows can't be
created; a blank required value and an unreadable file are both critical, a missing cost is not.
The tiers stay three (critical / warning / info) with drill-down and no green noise (Great
Expectations Cloud; Microsoft Purview, also the source for actionable in-context findings),
encoded as **icon + text + colour together, never colour alone** (WCAG 1.4.1 Level A; IBM Carbon
status-indicator; 3:1 non-text contrast so it survives greyscale). Informational/passing produces
**no green badge**.

`summarize(report, impact)` ([lib/dataImportReview.ts](../../lib/dataImportReview.ts)) yields:

- **One consequence line** — *"If you import now, 7,672 parts won't come in"* / *"Everything you
  uploaded will come in."* Computed by `rowsAtRisk()`, not by counting findings.
- **A "what will come in" bar** — *"17,417 of 32,375 rows will come in · 54%"* — the positive
  frame and a real completeness signal (step-counting tested as unhelpful).
- **"What to sort out"** — split by **actionability, not severity**: a finding is a task only if
  it is blocking OR has a one-click in-app fix. Ordered blocking-first, then by rows affected, each
  stated in plain language with the count it affects **and a concrete example** from their own rows.
  `isOpenable()` is the single source for both the split and the card-vs-row treatment.
  Actionable tasks are interactive cards with a verb button ("Set units", "Add them", "Review");
  no-fix items are quiet plain rows — that visual split *is* the priority signal (Norman's
  signifiers). **No per-row severity badges**: GOV.UK drops the background from done rows
  precisely to *"draw more attention to tasks that require action."*
- **"N other things we noticed — nothing you need to do"** — collapsed, everything non-blocking
  and non-actionable, regardless of warning-vs-info, so the step can reach "done". Typical members:
  duplicate names that collapse into one record, *"93% have no cost — add later"*, and references
  we **couldn't** check.
- **"What you're importing"** (record counts + relationships) — shown on the **Import** step.

**Never a silent pass — the invariant that makes "no problems" mean something.** A check that
*couldn't run* must never read as a check that *passed*. When a referenced file was never uploaded
(routings but no work-centers export), the analyzer emits exactly one `not_checked` finding rather
than either silence or a fabricated orphan count — *"we couldn't check this"*, said out loud. The
same rule makes a file whose required columns were never identified `not_checked` **critical**
(nothing in it can be created, so it can't read as a soft "review"). Findings carry `verified`, so a
deterministic count and an AI-inferred observation are never presented as the same kind of claim.
Asserted in [`__tests__/lib/dataImportAnalyzer.test.ts`](../../__tests__/lib/dataImportAnalyzer.test.ts)
by `describe('cross-file orphans (asymmetric keys)')` and `describe('required columns')`: never a
silent 0, never a phantom N.

### rows-at-risk ([lib/dataImportImpact.ts](../../lib/dataImportImpact.ts))

The sentence has to be **true**, so it counts rows the importer will actually refuse — not a sum
of finding counts (a row with no unit *and* an unknown vendor is one lost row, not two). What
costs a row was **verified against the running importers**, not inferred: a blank required field
(`parts.primary_unit` has an unconditional DB `CHECK (primary_unit IS NOT NULL)`,
`parts_requires_unit`), and an unresolvable reference (a part naming an absent vendor is a
conflict and execute skips every conflict row; likewise a routing naming an unknown work center).

It refuses to guess in the other direction too: when **no parent file was uploaded at all**, the
reference is not counted as a loss — we genuinely can't judge it, and the analyzer already says so
with `not_checked`. Inventing a loss there would make the headline sentence as untrue as hiding one.

> **Known limit (load-bearing):** references resolve against the **upload only**, matching the
> analyzer. For a company that already has data, a "missing" vendor may already exist in Jigged —
> so this **over-reports on a top-up import**. Correct for onboarding, the flow it serves.
> The Import step shows the same sentence from the same function, so the owner never meets two
> different stories about what they're losing.

## Guided remediation — fix it here, never elsewhere

**The rule every mechanic obeys: never route the owner out of the tool.** A finding may only ask
for something doable *here* — edit a cell, fill blanks, merge look-alikes, create the missing
records, or upload another file. *"Correct the values in your CSV"* is **banned copy**: they
exported those files from a system they may no longer run, and no shop owner hand-edits 6,565 rows
in Excel and re-uploads. If we can't offer an in-app action, word the finding as information, not
an instruction. Every `recommended_action` was rewritten against this rule.

Unmatched references are always quantified **against the total**, so the owner grasps the scale
rather than a bare count — *"6,565 of 18,639 routing steps point to a work center that isn't in
your files."*

Two shape rules come with it. The flow is **linear and staged — never an upfront wall of errors**
(upload → confirmable mapping → guided fix → running "what will import" → confirm → write), and
fixing happens **in-app in a spreadsheet-like grid**: an Excel round-trip is a *fallback, not the
path*.

Research basis: staged flow + inline/bulk fixing + auto-mapping (Flatfile, OneSchema,
Nuvo/Ingestro, Dromo); cluster-and-merge dedup + reconciliation matching (OpenRefine); inline,
at-the-field, no-blame, problem+solution error copy after the field is finished, not while typing
(NN/g). NN/g also drives fixes opening **from the task**, not a toolbar: a validation summary
*"shouldn't be used as the only form of error indication, as it forces the user to search for the
field in error."*

| Mechanic | Shipped as | Notes |
|---|---|---|
| Editable grid + live re-analyze + undo | `EditableDataGrid` (AG Grid, themed in `lib/agGridTheme.ts`), `lib/dataImportEditing.ts` | Debounced re-analyze; `unmountOnExit` so a 30k-row export doesn't jank Review |
| Bulk find-replace, fill-blanks | `FixToolbar`, `bulkReplace`/`fillBlanks` in `lib/dataImportActions.ts` | One journal entry per bulk op — "don't fix data one cell at a time" |
| Duplicates / spelling variants | analyzer finding `name_variant` + `findVariantGroups`/`mergeVariants` (`lib/dataImportActions.ts`), via `aggressiveNorm` | *(The design doc called the symbol `_name_variants`; no such export exists.)* |
| Confirm a duplicate pair | `ConfirmVariantsDialog` (Review task) | Both records side by side with the other facts we hold (vendor, cost, usage); owner states the conclusion *same part / keep separate*. **No confidence score, no reasoning** — MSR Aether: *"explanations increase blind trust rather than appropriate reliance,"* worst in novices. One decision per screen; "keep separate" is a real answer. |
| Bulk merge by column | `MergeVariantsDialog` (escape hatch only) | Pick the canonical spelling per group — **default = the most frequent** (`findVariantGroups` sorts variants by count, the dialog pre-selects the first) — then merge, or keep separate. *(The design doc said ConfirmVariants "replaces the old merge dialog"; both ship — Confirm drives the guided task, Merge survives inside the collapsed grid.)* |
| Fill a missing required column | `FillGapDialog` | Leads with what the owner's **own rows** already say and defaults to their most common value — safe because it's a **derived fact**, not a guess at intent (reconciles Johnson & Goldstein vs GOV.UK "don't pre-select" on that axis). Unit fields speak `lib/unitPresets` canonical units ("EA" → Each) in both the evidence and a grouped picker, with "Other" free-text for genuinely non-standard units — so the shop never picks a stray export code. Nothing writes until they press the button. |
| Create the missing parents | `findMissingParents`/`createMissingParents` (`lib/dataImportLinks.ts`) + `CreateMissingDialog` | See below |
| AI proposals | `SuggestFixesPanel` + `POST /api/data-import/suggest-fixes` | Per finding: an optional proposed action + a plain-language uncertainty note, **no confidence number**. Rendered accept/reject; the owner applies via the deterministic tools. |

**Create the missing parents** is the single biggest source of blocking findings (routings naming
a work center the work-centers export never had — *"here are the 47 names we couldn't match — add
them?"*):

- `findMissingParents()` returns distinct unmatched names + child-row reference counts, sorted by
  count, using **the analyzer's own `norm()`** — so the review can't say "47 missing" while the fix
  creates 46. `REFERENTIAL_LINKS` lives in the same module and the analyzer imports it: **one
  registry**, so check and fix can't drift. Required fields are single-sourced the same way
  (`lib/dataImportSchema.ts` `ENTITY_FIELDS`).
- **Only lookup-shaped parents** (`AUTO_CREATABLE_PARENTS` = work centers, vendors, customers) — a
  record that essentially *is* its name, so creating one from a reference invents nothing.
  **Parts are excluded on purpose:** a part needs a unit and a cost, so a missing part is answered
  by uploading the parts file, never by fabricating a stub. (Customers is listed auto-creatable but
  no `REFERENTIAL_LINKS` entry names customers as a parent, so nothing triggers it today.)
- **Internal vs outsourced is a labelled guess.** `guessKind()` reads company/process-shaped names
  ("PerformCoat of Michigan LLC", "…Plating") as outside shops and the dialog *says* it's a guess,
  with a one-tap toggle — rather than a confidence score, which this audience over-trusts.
- **The outsourced cascade.** The work-centers importer rejects `kind=external` unless a vendor of
  that name exists, so marking one "outside shop" also creates the vendor. Safe by construction:
  `WRITE_TIERS` puts vendors before work centers in tier 0 and `runImportPlan` posts sequentially.
- It is an `EditOp` like every other fix — undoes as one unit, re-analyzes.

**Identity renames cascade — the invariant that stops an *optional* fix creating a *blocking*
one.** Merging spellings (or any rewrite of a parent identity) must also rewrite child references,
or the merge orphans every BOM/routing row using the old spelling. This is exactly how a merge once
flipped the review from "everything comes in" back to a wall of un-fixable orphans. `mergeVariants`
cascades via `REFERENTIAL_LINKS` in the same undoable op; asserted by
[`__tests__/lib/dataImportActions.test.ts`](../../__tests__/lib/dataImportActions.test.ts)
`describe('mergeVariants cascades a rename into referencing files')`, which requires **zero** new
orphan findings.

### AI-fix guardrails — the strongest-evidenced rule

Microsoft Research Aether *"Overreliance on AI"* review: this exact audience (non-technical,
low-AI-literacy) blindly **over**-trusts AI (≈7× more likely to follow it in one study), and
confidence scores / persuasive explanations **backfire** — they inflate over-reliance rather than
calibrate it. Therefore: never silently apply an AI fix to business data (every suggestion is a
confirmable, reversible proposal); don't sell trust with a confidence badge — where the AI
explains, it **reveals its limits** ("I'm not sure these are the same — please confirm");
**cognitive forcing + human-in-the-loop**, with the final write behind an explicit "here's exactly
what will be created/updated". Tune friction to stakes — forcing carries a satisfaction cost, so
obvious fixes stay light and ambiguous/high-impact ones get it.

**Agent posture.** This is a **workflow, not an autonomous agent**: the steps are known in advance
(map → fix → review → import), so the wizard is the orchestrator and the LLM is called only at the
genuinely ambiguous points. Anthropic, *Building Effective Agents*: *"Add agentic complexity only
when simpler solutions fall short… which might mean not building agentic systems at all."* If
deterministic routing ever proves insufficient, escalate to a **thin orchestrator + manual loop +
confirm gate**, never an auto tool-runner, bound it with **stopping conditions** (cap iterations,
checkpoint on blockers), and keep any bulk-execute block **outside** the confirm gate (programmatic
tool calling "wants to run to completion" and compresses the audit trail).
`EditOp` is already the shared action layer a future agent would propose into — the model would
never mutate the backend directly. **Why the gate is non-negotiable: wrong-entity mutation is the
one failure class no backend check catches** — permission passes, scope is right, the payload is
schema-valid, yet the model acted on the *wrong record* and can report false success. Only
disambiguation (return candidates; block until the target is uniquely resolved) **plus an explicit
confirmation gate** intercept it. Reference implementations, not dependencies: LangChain
`HumanInTheLoopMiddleware` (pause-before-call, approve/edit/reject, `when` predicate to gate only
risky calls) and the OpenAI Agents SDK `needsApproval` flag (resumable interruptions).

If that layer is ever built, three constraints carry over from Anthropic's *Writing tools for
agents* + Claude Platform *Define tools*: **intent-level tools, not CRUD wrappers** (one
`merge_group` that clusters *and* rewrites — Cloudflare collapsed 2,500 endpoints to 2 intent
tools); a **small surface**, grouping related ops behind an `action` param, because tool-selection
accuracy degrades past ~15–20 tools; and **descriptions are "by far the most important factor in
tool performance"** — 3–4+ sentences each (what it does, when *not* to use it, each param,
caveats), which is also where an action is flagged irreversible / requires-confirmation.

## Ingestion write

**Reuse the per-entity importers — do NOT build a second writer.** The existing execute routes
(`parts_import_routes`, `vendors_import_routes`, `work_centers_import_routes`, `bom_import_routes`,
`routings_import_routes`, customers in `import_routes`) already own field validation, conflict
detection, per-entity business rules (procurement tiers, UoM resolution, external-work-center
vendor resolution), 500-row batching (Vercel body limit) and RLS via the service-role client.
Rebuilding that would duplicate hundreds of lines and drift.

**Dependency order** (`WRITE_TIERS`, [lib/dataImportIngest.ts](../../lib/dataImportIngest.ts);
topological load order per MSSQLTips + Dynamics 365 F&O data-entity sequencing):
tier 0 vendors · work centers · customers → tier 1 parts → tier 2 bom · routings. Because each
importer already resolves references against **committed** DB rows (e.g. the parts importer's
`unknown_vendor` check), **ordering the calls *is* the cross-entity relationship resolution** — no
new join logic. Joins are **asymmetric** and normalized (case/whitespace-insensitive), so spelling
noise doesn't create phantom orphans: parts identify by `part_name`, vendors/work-centers/customers
by `name`. If a referenced tier's file is absent, the flow imports what's resolvable and flags the
blocked references explicitly rather than silently dropping them.

Note the deliberate asymmetry vs analysis: **analysis is client-side and unbounded, the write sends
rows to the server**, in ≤500-row batches with `skip_conflicts: true`. That's correct — the write
is an explicit, bounded action and the existing routes own it.

**Every entity upserts on its natural identity** — an existing row updates in place, never skipped
or duplicated, and **no `legacy_id` anywhere**: parts `(company_id, part_name)`; vendors and work
centers `(company_id, name)`; customers `(company_id, name)`; routing operations
`(routing_id, sequence)`; BOM lines `(parent_part_id, child_part_id)` (updates quantity/unit —
updating an existing edge can't introduce a cycle, and new edges are cycle-validated).
Non-destructive: only columns present are written, and rows dropped from the CSV are not deleted.
For customers the child rows (contacts, addresses) and for BOM the line itself attach **only to new
records**, so a re-import never duplicates them. Every importer's company-scoped existing-key
lookup pages via `api/utils/db_pagination.py` `fetch_all_by_company` / `fetch_all_in`.

**Routing operation sequencing must precede batching.** Ops upsert on `(routing_id, sequence)`, and
a part's operations can span more than one 500-row batch — the server auto-numbers per batch,
resetting each time, so a straddling part gets renumbered and the upsert collides or overwrites the
wrong row. `numberRoutingOpsInFileOrder` (inside `buildImportPlan`, and called **before** `chunk()`)
numbers each part's ops across the entire file and injects a synthetic `sequence`
(`SYNTHETIC_SEQ_COLUMN = '__jigged_seq'`). A mapped step-order column always wins; the analyzer
emits a `sequence_inferred` info notice (lands in "things we noticed") when none is mapped,
pointing at the Map step.

**Transactionality is an explicit non-goal for v1.** Cross-entity atomicity across separate
endpoint calls is hard. Dependency order makes partial success *safe*: parents commit first and are
valid alone; if a child tier fails those rows are reported skipped and the run is **resumable**
(re-import fills the rest, idempotently via ON CONFLICT). The hardening path, if shops ever find
partial import unacceptable, is a server orchestrator refactoring the execute bodies into service
functions callable in one transaction — bigger, deferred.

**Post-import summary.** `summarizeResults` aggregates each execute response into one
created/updated/skipped/errors summary and groups row-level errors into `errorGroups`: a reason
heading with row-specific bits stripped (so "Part 'ABC' not found" and "Part 'DEF' not found"
collapse into one "Part not found"), a count, and up to six real examples. A batch failing wholesale
(network/500) is recorded with the server's message and **counted by its row count**, not as one
error. The UI renders per-reason breakdown + example chips + a remediation banner, then routes back
to Review to fix and re-run the remainder.

**Live progress.** The ~65-batch write on the real 8,393-part export emits per-batch snapshots
(`runImportPlan` → `ImportProgressPanel`): a determinate bar keyed on rows-written, a stage
checklist ticking in write order with per-stage error state, a `beforeunload` guard, and
reassurance copy — **no ETA, no cancel** (NN/g + Carbon + Material, for a >10s side-effecting
operation). True leave-and-return would need a server-side job (the loop is browser-driven today) —
deferred.

**Two 500s only reproducible at 8,393 parts**, both fixed, both invisible at fixture scale:
1. the parts importer inserted `part_procurement_tiers.vendor_id`, a column **dropped** when the
   per-vendor tier model collapsed (migration `20260714173443`) → PostgREST `PGRST204`;
2. collision-detection lookups hit PostgREST's **1000-row cap**, so re-importing a big company
   duplicate-keyed → every company-scoped lookup now pages.

Also surfaced there: a unit-less part used to **500 the whole 500-row batch** (the
`parts_requires_unit` DB constraint the importer didn't mirror); it now skips its own row.

## Importing into a non-empty company — upsert, not load

A client-side reconciliation ([lib/dataImportReconcile.ts](../../lib/dataImportReconcile.ts))
matches each uploaded row against existing Jigged identity values — read RLS-scoped through the
typed Supabase client (`lib/dataImportExisting.ts`, no new endpoint) — and drives a
"X new · Y already in Jigged" preview.

**Matching is exact-normalized only** (case/whitespace-insensitive). Rows are bucketed **new** or
**matched**; entities without a resolvable identity (bom, routings) pass through unchanged.
*(This doc previously claimed four buckets — New / Update / Unchanged / Conflict. "Unchanged" and
"Conflict" were never built, so user story "how many are already up to date, how many conflict" is
an open gap, as is fuzzy "link to existing" matching.)*

Modes — **Add new + update existing** (default), create-only, update-only — are applied entirely
client-side by `filterWorkingByMode`, before the plan is built, so execute routes receive only rows
that should be written. Safe default: nothing the owner didn't include is deleted or overwritten.

**Withdrawn:** a backend `mode` parameter on the execute routes — unnecessary once modes are
row-filtering on the client, and it would have put the same rule in two places.

Research basis: HubSpot / Salesforce / Insycle import modes + match keys; Dynamics 365 duplicate
detection; categorized preview.

## Placement — one flow, several purpose-built signposts

Multiple *entries* to the one flow are fine; multiple *flows* is the anti-pattern. There is no
permanent nav module for it beyond the utility entry below (the old "Data Health" item was removed).

| Entry | Where | Rationale |
|---|---|---|
| First-run "Get started" checklist, leading with "Import your data" | `components/demo/OnboardingCard.tsx`, empty dashboard, hidden once the shop has data | Dynamics 365 Business Central's get-started banner-that-reveals-a-checklist; Appcues onboarding-checklist completion lift |
| Empty module lists (Parts / Vendors / Work centers / Customers) | `components/data-import/ImportAllDataLink.tsx` | Since the per-entity wizards were retired this is the **only** in-page import affordance on those modules ("Import all your data at once") |
| Recurring entry, non-empty shop | low-emphasis **"Import data"** in the sidebar utility area near Team/Settings (`components/layout/Sidebar.tsx`) | Persistent and consistent on every page, always findable, and quiet — out of the dashboard's KPI spotlight (NN/G "KPIs lead"; Stripe/Linear calm KPI row). Reads as utility, not a primary destination |

Related data must be imported **together** to auto-resolve links and load in dependency order;
isolated per-entity imports are exactly what forces manual reconciliation later (the Salesforce
"split into per-object lists" failure mode). Model: HubSpot's one import tool ingesting multiple
related objects and auto-associating them; Dynamics 365's multi-entity dependency-sequenced import
jobs; Salesforce's unified Data Import Wizard — both vendors recommend the unified tool over
object-specific imports for non-technical users.

**Withdrawn:** a prominent "Import data" action in the dashboard's top app bar — over-emphasized an
infrequent task on the primary status screen, and was inconsistent (visible only on the dashboard,
so unreachable elsewhere — fails recognition-over-recall).
**Withdrawn:** a Settings → Import area — the onboarding research doesn't point there and it
duplicated the recurring role.

## Withdrawn arguments (do not rebuild on these)

- **Withdrawn:** a ready / almost / not-ready **verdict banner** — no import product surveyed (12)
  ships one, and "Not ready to import" is a dead end the owner can't act on. Xero's framing
  instead: you can still import; these just won't come in.
- **Withdrawn:** severity **count chips** — a tally isn't actionable; GOV.UK's error summary lists
  the items, never a count.
- **Withdrawn:** green "all good" confidence chips — indicators are reserved for things needing
  attention; confidence now shows only when a classification is low-confidence.
- **Withdrawn:** the record-count / relationship panel on **Review** — moved to Import, where it's
  about to matter (HubSpot's counts-after, not counts-during).
- **Withdrawn:** the AI **narrative** in the flow, and the "gotchas" list it produced — vague,
  pointed out of the tool, and redundant with the real orphan checks. It was also the Map→Review
  transition's only network dependency and caused an ECONNRESET-class failure on a live drive;
  that transition is now fully client-side, instant, and can't fail.
- **Withdrawn:** a flat list of task rows — tested as *"I can't tell these are clickable"*; became
  interactive cards with verb buttons.
- **Withdrawn:** a parallel "Fix your data" grid alongside the guided tasks — two competing fix
  surfaces; it became a collapsed "See or edit all your data" escape hatch.
- **Withdrawn:** snapshot-based undo — would copy every row on every op; `EditOp` is
  self-describing so `invertOp` derives the inverse.
- **Withdrawn:** a downloadable skip list after import — dropped in favour of grouped error reasons
  the owner can act on in-app.
- **Withdrawn:** *"add the missing records, or correct the values"* as finding copy — an
  instruction pointing outside the tool (see the never-route-them-out rule).
- **Withdrawn:** the *"inline fixing → +50% completed imports"* statistic — refuted (vendor
  marketing). Adopt these patterns as well-attested best practice, **not proven ROI**.
- **Withdrawn:** the typed-tool-contract source's **numbers** — from a single non-peer-reviewed
  preprint and refuted. Only its architectural core is adopted, which Anthropic's guidance
  independently supports.

## Testing

Assert **external behavior** — files/findings in, findings / consequence line / review structure /
write plan out — never private helpers or DOM internals. Three seams:

| Seam | Where | Coverage |
|---|---|---|
| Analyzer + review + impact + actions (primary) | `__tests__/lib/dataImportAnalyzer.test.ts`, `dataImportReview.test.ts`, `dataImportImpact.test.ts`, `dataImportActions.test.ts`, `dataImportEditing.test.ts`, `dataImportLinks.test.ts`, `dataImportReconcile.test.ts`, `dataImportIngest.test.ts` | classification, within-file duplicates, cross-file orphans with asymmetric keys, normalized matching (**no phantom orphan**), **a referenced file absent → one `not_checked`, never a silent 0 and never a phantom N**, required/blank columns, cost + quantity coverage, name variants, inactive flags, edges; `rowsAtRisk` (one row lost is one row), `losses`/`lossPhrase`; task-vs-notice split, consequence line, outlook; `buildImportPlan`, `summarizeResults`, `runImportPlan — progress`; `reconcile`, `filterWorkingByMode`; `findMissingParents`, `guessKind`, `createMissingParents` |
| AI endpoints | `api/tests/integration/test_data_import_api.py`, `api/tests/unit/test_data_import_provider.py` | caller auth (401/403), **that there is no feature gate** (`test_endpoints_are_not_feature_gated`), the 413 size cap, suggest-fixes proposals only, and the static no-write check |
| The `/import` wizard journey end-to-end | **not built — `automation-pending (#367)`** | *(This doc previously cited "one Playwright E2E that drives `/import`"; the spec it meant drove the **per-entity** `/parts/import` wizard and was deleted along with it. So there is now **no** Playwright coverage of any CSV import, which raises #367 from a gap to the only end-to-end check there is. The live write still owes one preview/local run — the one piece not verifiable headlessly.)* |

## Not built / out of scope

- **Per-module toolbar Import buttons.** Resolved by removal rather than by rerouting: Parts,
  Vendors, Work centers and Customers no longer carry an Import button at all, and their
  `/…/import` wizards (plus `parts/bom/import`) are deleted. The empty-state
  `ImportAllDataLink` and the sidebar entry are the ways in. *(This doc previously listed the
  reroute as Not built, and before that described it as a Phase 2 behaviour.)*
- **"Unchanged" and "Conflict" reconciliation buckets**, and **fuzzy link-to-existing** matching
  (only exact-normalized bucketing ships).
- **An explicit "leave blank — intentional" decision.** Spec'd so that confirming a gap *downgrades*
  the finding and *"no problems"* can never hide an unmade decision; `FillGapDialog` only fills, and
  the working dataset carries no `decisions` map to record such a choice. Until it exists, a
  deliberately-blank required column stays a task.
- **Three never-blurred visual states** — auto-fixed vs. warning (reviewed, still accepted) vs.
  blocking (must fix) — and with them the "we fixed this for you" vs "you still need to handle this"
  split. Nothing in the flow marks a change as made *on the owner's behalf*; every fix today is one
  they pressed a button for, so the state has no members yet. Revisit if AI proposals ever auto-apply.
- **Server-side jobs** for leave-and-return during a long write; **cross-entity atomicity**.
- **Detection-template / gotcha-rule library and fine-tuning harvesting** (#522, #524 payoff) — the
  review schema is kept reuse-ready (`ERP_GOTCHA` finding category exists), harvesting is later.
- **Server-side persistence of reviews**, and any shareable/exported artifact (PDF).
- **Non-CSV sources** — direct ERP API connectors, multi-sheet Excel.
- **Migrating transactional history** (quotes, jobs, shipments, invoices). Phase 1 covers the master
  data needed to start: parts, vendors, work centers, routings, BOMs, customers.
- **An agent eval harness** — before trusting any agent layer, add tests asserting it never proposes
  an unconfirmed destructive action and never loops.

## Honest gaps / open questions

- **No verified ROI** for the whole pattern — instrument completion/abandonment and learn on real
  usage rather than assume.
- **Human white-glove playbooks and manufacturing-specific onboarding produced no surviving
  sources.** The "here's what I'd do / celebrate progress / reassure about not losing data"
  techniques are *inferred* from the plain-language and human-in-the-loop findings, not sourced.
- **Linking to the shop's OWN in-app records is only *analogous*** to OpenRefine reconciliation
  (which links to EXTERNAL databases). The merge/approve UX transfers; the right default (auto-link
  high-confidence vs always-ask; mis-links vs fatigue) is an open design question — current lean is
  auto-link on exact identity match only, fuzzy always-ask.
- **The AI-suggestion UI recipe** — revealing uncertainty without inducing blind trust — is
  unvalidated; usability-test the accept/reject + uncertainty phrasing with real owners.
- **Conversational-onboarding UX** for a non-technical 50–60-yr-old (one-thing-at-a-time pacing,
  ask-vs-act thresholds, progress) is not evidence-backed here.
- **When an agent should LEAD vs defer** to a deterministic UI step has no principled rule in the
  sources — default to deferring to the grid/checklist; the AI proposes, it doesn't drive.
- **No import-specific study** shows agent assistance beats a pure deterministic wizard for
  messy-data onboarding — keep the AI layer thin and instrument outcomes.
- **Grid performance at ~18k+ routing rows** — AG Grid handles it, but validate the
  re-analyze-on-edit debounce stays snappy at that size.
