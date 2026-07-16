# Technical Design — Data Import Phase 2 (guided remediation + ingestion)

> Companion to the PRD ([docs/modules/data-import.md](data-import.md) · issue #562). The PRD
> is the *what/why*; this is the *how* for Phase 2. Status: Draft for review. Scope: the
> guided in-app remediation experience and the actual ingestion write — everything Phase 1
> deferred. Phase 1 (read-only review, client-side analyzer, `/structure` +
> `/narrative` endpoints, the `/import` wizard **Upload → Map → Review & Fix → Import** up to
> ingestion — including the Map confirm-columns step — and placement) is built on PR #561 and
> is the substrate this builds on.

## 1. What Phase 2 adds

1. **Guided remediation** — the owner fixes data *in Jigged* (edit cells, bulk find-replace,
   merge duplicate/variant names, fill/confirm gaps, link rows to existing records), with AI
   *proposing* fixes it never silently applies, and a **live** verdict (ready-to-import + what to fix).
2. **The ingestion write** — the actual dependency-ordered write, reusing the existing
   per-entity importers as the write layer.
3. **Upsert into a non-empty company** — match against existing records; new / update /
   unchanged / conflict; non-destructive default.

## 2. Guiding architecture principle — keep it client-heavy until the write

Phase 1's load-bearing decision holds: **the working dataset lives in the browser** (already
parsed there) and the **deterministic analyzer runs client-side** ([lib/dataImportAnalyzer.ts](../../lib/dataImportAnalyzer.ts)).
Remediation therefore happens **almost entirely client-side** — every edit/merge/fill mutates
the in-browser dataset and re-runs the analyzer to update findings + the verdict instantly, with
**no server round-trip and no size limit**. The server is touched only for:

- **AI *suggestions*** (propose fixes / merges) — a tiny payload (findings + samples), like the
  existing narrative call. Never applies anything.
- **Bounded reads** for "link to existing" (fetch existing identity values, RLS-safe).
- **The write itself** (Import) — the one step that sends rows to the server, batched, to the
  existing per-entity execute routes.

Consequence: nothing of the shop's data is stored server-side until the explicit Import, and
files stay unbounded through the whole fix loop — the properties we fought for in Phase 1 carry
forward.

## 3. The working dataset (client state)

A single in-memory model the grid, analyzer, review panel, and writer all read from:

- Per file: `filename`, `entityType`, `columnRoles` (canonical→raw), `headers`, and `rows`
  (mutable).
- An **edit journal** (ordered list of applied operations) backing **undo/redo** and the
  "we changed this for you" audit — so every change is reversible (a hard PRD guardrail).
- **Remediation decisions** (merge groups accepted, gaps confirmed-blank, links accepted) kept
  alongside so re-analysis and the write both honor them.

Everything is derived: mutate rows/decisions → re-run `analyzeBundle` → recompute `summarize`
→ the review panel and "what will import" update. No separate source of truth.

## 4. Guided-remediation mechanics

> **The rule every mechanic below obeys: never route the owner out of the tool.** A finding may
> only ask for something the owner can do *here* — edit a cell, fill blanks, merge look-alikes,
> create the missing records, or upload another file. "Correct the values in your CSV" is
> banned copy: they exported those files from a system they may no longer run, and a shop owner
> is not going to hand-edit 6,565 rows in Excel and re-upload. If we can't offer an in-app
> action for a finding, the finding is telling them something they can only *know*, not *do* —
> word it as information, not an instruction.

### 4a. Editable grid + live re-analysis
A spreadsheet-like grid per file (or per finding, scoped): double-click-to-edit, sort/filter,
hide/freeze columns. Each edit mutates the working dataset and re-runs the analyzer
(debounced). Reuse AG Grid (already a dependency, themed in `lib/agGridTheme.ts`).

### 4b. Bulk fix
Column-scoped **find-and-replace** and **one-click autofix** for systemic issues (a vendor
name mistyped 200×, a unit-format normalization). Pure client transforms over the dataset;
one journal entry per bulk op (so it undoes as a unit). "Don't fix data one cell at a time."

### 4c. Cluster-merge (duplicates / spelling variants)
The analyzer already computes name-variant groups via aggressive normalization
(`_name_variants` / `aggressiveNorm`). Surface those groups as a **merge decision**: pick the
canonical value (default = most frequent), then **merge / keep-separate / ignore** per group.
Merge rewrites the affected rows' identity value in the working dataset. **AI may *propose*
the canonical + which look like true dupes, phrased as uncertainty** ("these might be the same
— confirm?"), but the merge only applies on explicit user accept.

### 4d. Fill / confirm gaps
For missing required values (`MISSING_COLUMN` / `DATA_GAP` findings), inline fill in the grid,
a bulk "set default for all blanks," or an explicit **"leave blank — intentional"** that
downgrades the finding (so "no problems" never hides an unmade decision).

### 4d-bis. Create the missing parents (orphan references) — **built**
The single biggest source of blocking findings: routings naming a work center the
work-centers export never had. The fix is **not** "add the missing records, or correct the
values" (what the finding used to say — an instruction pointing outside the tool). It is:

- **Show the list.** `findMissingParents()` (`lib/dataImportLinks.ts`) returns the distinct
  unmatched names + how many child rows use each, sorted by reference count. It uses the
  analyzer's `norm()` — the *same* normalization the orphan finding counts with, so the review
  can't say "47 missing" while the fix creates 46. `REFERENTIAL_LINKS` lives in this module and
  the analyzer imports it: **one registry**, so the check and the fix can't drift.
- **Only lookup-shaped parents.** `isAutoCreatable()` allows work centers / vendors / customers
  — a record that essentially *is* its name, so creating one from a reference invents nothing.
  **Parts are excluded on purpose:** a part needs a unit and a cost, so a missing part is
  answered by uploading the parts file, never by fabricating a stub.
- **The owner confirms; nothing is created silently** (§7d, and the over-reliance guardrail).
  `CreateMissingDialog` lists every name with an include checkbox.
- **Internal vs. outsourced is a labelled guess.** `guessKind()` reads company/process-shaped
  names ("PerformCoat of Michigan LLC", "…Plating") as outside shops, and the dialog *says* it's
  a guess with a one-tap toggle — rather than a confidence score, which this audience over-trusts.
- **The outsourced cascade.** The work-centers importer rejects `kind=external` unless a vendor
  of that name already exists, so marking one "outside shop" also creates the vendor. Safe by
  construction: `WRITE_TIERS` puts `vendors` before `work_centers` in tier 0, and `runImportPlan`
  posts sequentially — the vendor commits before the work center that references it.
- **It's an `EditOp` like every other fix** — it lands on the undo journal, undoes as one unit,
  and re-analyzes. This required extending the op from "a batch of cell edits" to also carry
  `addRecords` (see §7b): rows, any column it had to introduce (`kind`, `vendor_name`), and a
  whole file when the owner never uploaded one for that entity. `invertOp` derives the exact
  inverse from the op itself (no snapshot) because the builder records what it had to add.

### 4e. Link to existing records (non-empty company)
A bounded, read-only fetch of existing identity values for the target entities (RLS-safe,
client-side via the typed Supabase client or a small read endpoint) → match uploaded rows
(exact-normalized first; fuzzy as a proposal) → present **new / matches-existing / ambiguous**
→ user confirms links. Open decision (§11): auto-link exact matches vs. always-ask.

### 4f. AI-suggested fixes — new endpoint, guardrail-bound
`POST /api/data-import/suggest-fixes` (AI, mirrors the narrative endpoint: tiny payload =
findings + column samples, gated by flag + caller-auth, rate-limited, **no writes**). Returns,
per finding, an optional **proposed action + a plain-language uncertainty note** — deliberately
**no confidence number** (research: confidence scores backfire for this audience). The client
renders each as an **accept / reject** proposal; nothing is applied without an explicit accept.
This is the concrete realization of the PRD's "AI-fix guardrails."

## 5. The Review step — one consequence, not a verdict wall

Redesigned after a usability round (the owner's own words: *"I don't know where to look and
what to do"*) and three research briefs (specialist importers; NN/g + GOV.UK + IBM Carbon +
Atlassian on hierarchy/color; MSR Aether on AI over-reliance). The briefs converged on one
move, and it's **subtractive**: spend saturated colour exactly once — on the single thing that
matters now — and turn everything else down. You can't make the urgent thing louder when it's
already maxed out; you make it salient by quieting the rest.

**Severity means consequence, not check category.** This was the root of the confusion. A blank
*required* value (7,672 parts with no unit) read as `warning` — the same amber as a genuinely
harmless "no cost" — while it actually drops every one of those rows on import. Severity is now
assigned by outcome: `critical` = these rows can't be created. A blank required value and an
unreadable file are both critical; a missing cost is not.

`summarize(report, impact)` (in `lib/dataImportReview.ts`) yields the new view-model, recomputed
after every remediation step so the screen updates live:

- **A single consequence line** — *"If you import now, 7,672 parts won't come in"* — instead of
  a verdict banner. No import product surveyed ships a ready/not-ready verdict, and "Not ready
  to import" is a dead end the owner can't act on. Xero's framing instead: you can still import;
  these just won't. Computed by `rowsAtRisk()` (§5a), not by counting findings.
- **Tasks ranked by rows lost**, blocking first, optional tagged as such — GOV.UK's "complete
  multiple tasks" list. The whole row opens the fix. **No per-row severity badges**: neutral by
  default, because GOV.UK drops the background from done rows precisely to *"draw more attention
  to tasks that require action."*
- **Deleted on purpose:** the verdict banner (no precedent in 12 products), the severity **count
  chips** (a tally isn't actionable — GOV.UK's error summary lists the items, never a count),
  and the record-count / relationship panel (moved to the **Import** step, where it's about to
  matter — HubSpot's model of counts-after, not counts-during).
- Everything with nothing to do collapses into *"N other things we noticed."*

### 5a. The rows-at-risk model (`lib/dataImportImpact.ts`)
The consequence line has to be **true**, so it counts the rows the importer will actually refuse
— not a sum of finding counts (a row with no unit *and* an unknown vendor is one lost row, not
two). What costs a row was **verified against the running importers**, not inferred:
- a blank **required** field — `parts.primary_unit` has an unconditional DB `CHECK`;
- an **unresolvable reference** — a part naming a vendor absent from the upload is skipped (the
  part does not land), likewise a routing naming an unknown work center.

Known limit: references resolve against the **upload only**, matching the analyzer. For a company
that already has data in Jigged, a "missing" vendor may already exist there — so this can
over-report on a top-up import. Correct for onboarding (the flow this serves); revisit for top-ups.
The **Import** step shows the same sentence from the same function, so the owner never meets two
different stories about what they're losing.

### 5b. Fixes live *with* the task
NN/g: a validation summary *"shouldn't be used as the only form of error indication, as it forces
the user to search for the field in error."* So a task's fix opens from the task itself, not from
a toolbar "below":
- **`FillGapDialog`** resolves a whole missing-required column in one decision. It leads with what
  the owner's *own* rows already say for that column (evidence they can judge) and defaults to
  their most common value — a safe default because it's a **derived fact**, not a guess about
  intent (Johnson & Goldstein / GOV.UK "don't pre-select" reconciled on that axis). Nothing writes
  until they press the button. For **unit fields** it speaks the app's own canonical unit system
  (`lib/unitPresets`): the raw export code is resolved to its standard form ("EA" → Each) in both
  the evidence and a grouped standard-unit picker, so the shop picks a real, consistent unit —
  never a stray code — with an "Other" free-text only for genuinely non-standard units.
- **The tasks read as what they are.** An actionable task is an interactive card with a verb button
  ("Set units", "Add them", "Review"); an optional/no-fix item is a quiet plain row. That visual
  split is the priority signal (Norman's signifiers; the flat list that preceded it tested as "I
  can't tell these are clickable"). The consequence sub-line is a directive, not a passive count.
- **Both sides of the outcome, and the progress.** The header shows what *won't* come in AND a
  "what will" readout with a bar ("17,417 of 32,375 rows will come in · 54%") that fills as fixes
  land — the positive frame + a real completeness signal (not step-counting, which the research
  found unhelpful).
- **Identity renames cascade — the invariant that keeps an *optional* fix from creating a
  *blocking* one.** Merging spellings (or any rewrite of a parent identity) must also rewrite the
  child references, or the merge orphans every BOM/routing row that used the old spelling. This is
  exactly how a merge once flipped the review from "everything comes in" back to a wall of
  un-fixable orphans. `mergeVariants` cascades via `REFERENTIAL_LINKS` in the same undoable op;
  the regression test asserts a merge yields **zero** new orphan findings.
- **`ConfirmVariantsDialog`** replaces the old merge dialog for duplicates. Per MSR Aether —
  *"explanations increase blind trust rather than appropriate reliance,"* worst in novices — it
  shows **no confidence score and no reasoning**. Both records sit side by side with the other
  facts we hold (vendor, cost, usage), and the owner states the conclusion: *same part / keep
  separate*. That's a **cognitive forcing function**, the named mitigation for over-reliance. One
  decision per screen; "keep separate" is a real answer, not a dismissal.

## 6. Ingestion write pipeline

### 6a. Reuse the per-entity importers — do NOT build a second writer
The per-entity import routes (`parts_import_routes`, `vendors_import_routes`,
`work_centers_import_routes`, `bom_import_routes`, `routings_import_routes`, customers in
`import_routes`) already implement the hard write logic: field validation, **conflict detection
against existing rows**, **`legacy_id` ON CONFLICT upsert**, per-entity business rules (parts
procurement tiers, UOM resolution, external-work-center vendor resolution), 500-row batching
(Vercel body limit), and RLS via the service-role client. Rebuilding that in a unified endpoint
would duplicate hundreds of lines and drift. **Decision: the unified importer reuses these
execute routes as the write layer.**

### 6b. Dependency-ordered orchestration
At Import, the client sends the remediated rows to the per-entity execute endpoints **in
dependency order**, so parents exist before children resolve their references:

    Tier 0 (parallel):  vendors · work centers · customers
    Tier 1:             parts        (resolves preferred_vendor_name against committed vendors)
    Tier 2:             routings     (resolves part + work-center references)
    Tier 2:             bill of materials (resolves parent/child parts)

Because each per-entity importer already resolves references against **committed** DB rows
(e.g. the parts importer's `unknown_vendor` check), ordering the calls *is* the cross-entity
relationship resolution — no new join logic needed. The client builds each entity's `mappings`
(raw→canonical) from the working dataset's `columnRoles` and posts batches of ≤500 rows.

Note the deliberate asymmetry vs. Phase 1: **analysis is client-side and unbounded, but the
write sends rows to the server** (batched). That's correct — the write is an explicit, bounded
action and the existing routes own it.

### 6c. Upsert modes
Map the PRD's modes onto the existing importers: **Add new + update existing** (default) uses
the `legacy_id`/identity ON CONFLICT upsert; **create-only** skips matches; **update-only**
skips non-matches. Some importers may need a small `mode` parameter added to their execute
request — a contained change, confirmed per route at build time.

### 6d. Transactionality (explicit non-goal for v1)
Cross-entity all-or-nothing atomicity across separate endpoint calls is hard and out of scope
for v1. Dependency order makes partial success *safe*: parents commit first and are valid on
their own; if a child tier fails, those child rows are reported as skipped and the run is
**resumable** (re-import fills the rest, idempotently via ON CONFLICT). If true atomicity is
later required, the hardening path is a server orchestrator that refactors the per-entity
execute bodies into service functions callable inside one transaction (§11) — bigger, deferred.

### 6e. Post-import summary
Aggregate each entity's execute response into one **added / updated / skipped (with reasons)**
summary + a downloadable skip list, then route the owner to fix + re-run the remainder.

## 7. Agent orchestration — surface, action layer, approval gates

*(2nd adversarially-verified research pass + Anthropic's agent guidance.)* Headline: **this
is a workflow, not an autonomous agent — and the increment 1–4 scaffolding IS the agent's
toolbox, so there is no rework.**

### 7a. Surface: workflow first; agency only where the task is genuinely ambiguous
Anthropic separates **workflows** (LLMs + tools on *predefined code paths* — predictable, for
well-defined tasks) from **agents** (the LLM *dynamically directs* its own process). Our steps
are known in advance (map → fix → review → import), so the **wizard is the orchestrator** and
the LLM is called only at the ambiguous points (which look-alikes are the same part, what fix
to propose, how to phrase it). *"Add agentic complexity only when simpler solutions fall
short… which might mean not building agentic systems at all."* Escalate to a real tool-calling
agent loop only if deterministic routing proves insufficient — and even then keep it a **thin
orchestrator + manual loop + confirm gate** (Anthropic: use the manual loop when you need human
approval before each tool call), never the auto tool-runner. [Anthropic, *Building Effective
Agents*]

### 7b. One shared action layer (typed action contracts)
Represent every remediation action as a **typed contract**: `name` + a detailed description +
JSON-Schema input + a permission predicate + `validate()` (reusing the app's own domain rules)
+ `execute()` that runs **through the app's existing services**. The UI buttons and the later
agent call the *same* contracts; the model **never mutates the backend directly** — it proposes
a call, the app executes it. (A tool is "a contract between deterministic systems and
non-deterministic agents" that can pick the wrong tool or wrong params — design for the agent,
not as thin CRUD wrappers.) The increment 2–4 actions become the contracts: `bulk_replace` ·
`merge_group` · `fill_gap` · `create_missing_parents` · `link_to_existing` · `import_bundle`.
[Anthropic, *Writing tools for agents*; *Bounded Autonomy for Enterprise AI* — architectural
core only, see 7f]

Today that layer is `EditOp` — every action (button-driven now, agent-proposed later) is a pure
function `(working, args) → EditOp`, and the wizard is the only thing that applies one. `EditOp`
carries two kinds of change:

- `edits: CellEdit[]` — value changes, addressed by stable `__rowId` (survives sort/filter).
- `addRecords: AddRecordsOp[]` — records created in-app (§4d-bis), plus any column or file they
  required. Self-describing, so `invertOp` produces the exact inverse without snapshotting the
  dataset (which would mean copying every row on every op).

Undo/redo asymmetry worth knowing: undo applies `invertOp(op)`, redo re-applies the **original**
op — so an inverse never needs its own inverse, which is why `removeRecords` is only ever
produced by `invertOp` and never authored directly.

### 7c. Consolidate, keep it small, describe it well
- **Intent-level, not CRUD** — one `merge_group` that clusters + rewrites, not raw row-update
  wrappers ("tools should let agents subdivide and solve tasks the way a human would";
  Cloudflare collapsed 2,500 endpoints to 2 intent tools).
- **Small surface** — group related ops into one tool with an `action` param; tool-selection
  accuracy degrades past ~15–20 tools.
- **Descriptions are "by far the most important factor in tool performance"** — 3–4+ sentences
  each (what it does, when to use / when NOT, each param, caveats). This is where an action is
  flagged **irreversible / requires confirmation** to the model. [Anthropic + Claude Platform
  *Define tools*]

### 7d. Approval gates — the agent proposes, the human disposes
Every mutation is confirm-before-act; the irreversible / wrong-entity-risking ones
(`merge_group`, `link_to_existing`, and above all `import_bundle`) are a **hard gate**. Why it
matters: **wrong-entity mutation is the one failure class no backend check catches** —
permission passes, scope is right, the payload is schema-valid, yet the model acted on the
*wrong record* and can report false success. Only **disambiguation** (return a candidate list;
block until the target is uniquely resolved) **+ an explicit confirmation gate** intercept it.
Our gate is the wizard's own **accept / edit / reject** UI on each proposal (edit = tweak a
proposed merge/fill before it runs; undo already gives reversibility). Reference
implementations (not necessarily dependencies — we're on Claude tool-use + FastAPI): LangChain
`HumanInTheLoopMiddleware` (pause-before-call, approve/edit/reject/respond, `when` predicate to
gate only risky calls) and the OpenAI Agents SDK `needsApproval` flag (pauses the run, returns
serializable/resumable interruptions). [*Bounded Autonomy* §8; LangChain / OpenAI HITL docs]

### 7e. Bound autonomy + cost
- **Explicit user action only** (standing rule) — no LLM call on mount/poll; every propose
  gesture is deliberate.
- **Stopping conditions** — cap iterations; checkpoint on blockers. [Anthropic]
- **Model/effort** — `claude-opus-4-8` (pinned default) + adaptive thinking; low effort for
  mechanical proposal calls.
- If we ever **bulk-execute** safe row ops in one block, keep the confirm gate **outside**
  it — programmatic tool calling "wants to run to completion" and compresses the audit trail,
  so it must not wrap the final confirmed `import_bundle`.

### 7f. Honest gaps (this pass did not settle these)
- **Conversational-onboarding UX** for a non-technical 50–60-yr-old owner (one-thing-at-a-time
  pacing, plain language, ask-vs-act thresholds, progress) is **not** evidence-backed here —
  lean on the earlier human-white-glove findings and **usability-test with real owners**.
- **When the agent should LEAD vs. defer** to a plain deterministic UI step has no principled
  rule in the sources — default to deferring to the grid/checklist; the AI *proposes*, it
  doesn't drive.
- **No import-specific study** shows agent assistance beats a pure deterministic wizard for
  messy-data onboarding — keep the AI layer thin and instrument outcomes.
- **Eval harness** — before trusting the agent, add tests asserting it **never proposes an
  unconfirmed destructive action and never loops**.
- **Source caveat** — the typed-contract + wrong-entity claims lean on a single
  non-peer-reviewed preprint whose *numbers* were refuted; we adopt only its architectural
  core, which Anthropic's guidance independently supports.

## 8. Endpoint inventory
- **Reused (existing):** each entity's `…/import/execute` (the write); `/structure` (mapping +
  ERP). Existing conflict/validate logic is reused as-is.
- **`/narrative` — endpoint still exists, but the wizard no longer calls it.** Its only visible
  output was the "gotchas" list, which was cut (§5: vague, out-of-tool, redundant with the real
  orphan checks). With nothing consuming it, calling it was an invisible AI cost and the Map→Review
  step's only network dependency (it caused an ECONNRESET-class failure in the local drive). The
  Map→Review transition is now **fully client-side and deterministic** — instant, and it can't
  fail. The endpoint is left in place (cheap to re-enable) but is dead from the frontend.
- **Built:** `/api/data-import/suggest-fixes` (AI proposals, no writes) — guardrail-bound
  per-finding suggestions (explicit action, uncertainty-not-confidence, never auto-applied). The
  non-empty-company reconciliation read is client-side + RLS-scoped (`lib/dataImportExisting.ts`),
  not a new endpoint.
- **Unchanged guarantee:** the read/AI endpoints keep the Phase 1 no-domain-write property;
  only the per-entity execute routes write, exactly as they do today.

## 9. Data contracts (shape, not final types)
- **Working dataset** (client): `{ files: [{ filename, entityType, columnRoles, headers, rows[] }], journal[], decisions{} }`.
- **suggest-fixes**: request `{ company_id, findings[], file_summaries[] }` → response
  `{ suggestions: [{ findingId, action, uncertaintyNote }] }` (no confidence scalar).
- **Write orchestration** (client → existing execute, per entity, per ≤500-row batch):
  `{ company_id, mappings, rows, mode }` → `{ added, updated, skipped, errors[] }`.

## 10. Testing seams (per the PRD's three seams)
1. **Remediation logic (client)** — vitest over pure transforms: apply-edit / bulk-replace /
   merge-group / fill-gap / confirm-blank → re-`analyzeBundle` → asserted findings + verdict
   delta; undo restores prior state. Same seam as the existing `__tests__/lib/*` suites.
2. **suggest-fixes + the write orchestration** — pytest with the AI provider mocked and the
   Supabase client mocked: assert suggestions are proposals only (no writes on suggest), and
   assert the orchestrator calls the per-entity executes **in dependency order** with correct
   batching + mode. Reuse the existing import-route test patterns.
3. **One E2E** (Playwright) — upload → fix a duplicate + a gap in the grid → the verdict flips to
   ready → confirm → a (test-DB) write → post-import summary. Extends the Phase 1 wizard E2E.

Test *external behavior* (dataset in → findings/verdict/write-plan out), never private helpers.

## 11. Open technical decisions / risks
- **Link-to-existing default:** auto-link exact-normalized matches vs. always-ask (mis-link
  risk vs. fatigue) — PRD open question; lean auto-link only on exact identity match, fuzzy
  always-ask.
- **Upsert `mode` param** may need adding to some per-entity execute requests — confirm each.
- **Atomicity:** v1 is per-entity + resumable (non-atomic). Server-orchestrator-in-one-txn is
  the deferred hardening path if partial-import is unacceptable to shops.
- **AI-suggestion UI recipe** (reveal-uncertainty without inducing blind trust) is unvalidated
  — usability-test the accept/reject + uncertainty phrasing with real owners before scaling.
- **Grid performance** at ~18k+ routing rows — AG Grid handles it, but validate the
  re-analyze-on-edit debounce stays snappy at that size.
- **No verified ROI** for the whole pattern (PRD note) — instrument completion/abandonment so
  we learn on real usage rather than assume.

## 12. Build sequence — status
1. ✅ **Built** — editable grid + live re-analyze + undo (`lib/dataImportEditing.ts` /
   `EditableDataGrid`). *(Also built ahead of Phase 2: the **Map** confirm-columns step —
   `ColumnMappingStep` + `lib/dataImportSchema.ts`.)*
2. ✅ **Built** — bulk find-replace + fill-blanks + cluster-merge as the typed reversible action
   layer (`lib/dataImportActions.ts`, `EditOp`; `FixToolbar` / `MergeVariantsDialog`).
3. ✅ **Built** — the ingestion write (`lib/dataImportIngest.ts`): dependency-ordered calls to
   the existing per-entity executes, ≤500-row batches, `skip_conflicts` (resumable), plan
   preview + confirm dialog + post-import summary. **First real write** — live behind the flag +
   confirm gate; still owes one preview/local E2E run.
4. ✅ **Built** — non-empty-company reconciliation: an RLS-scoped read of existing identity
   values (`lib/dataImportExisting.ts`) + pure `reconcile` / `filterWorkingByMode`
   (`lib/dataImportReconcile.ts`) driving a "X new · Y already in Jigged" preview and
   **create-only / update-only / add+update** modes — implemented client-side by filtering rows
   to the chosen bucket, so no backend `mode` param was needed.
5. ✅ **Built** — `suggest-fixes`: guardrail-bound AI proposals fired only on an explicit click
   (plain-language step + honest uncertainty, never a confidence score, never auto-applied — the
   owner applies via the deterministic tools). `POST /api/data-import/suggest-fixes` +
   `SuggestFixesPanel`. Deterministic fixes (1–2) landed first, by design.
6. ✅ **Built** — **every finding resolves in-app** (§4 rule, §4d-bis): `lib/dataImportLinks.ts`
   + `CreateMissingDialog` turn the orphan-reference blocker into "here are the 47 names we
   couldn't match — add them?" (with an in-house/outside-shop guess and the vendor cascade), and
   every `recommended_action` was rewritten to name an action the owner can take here.
7. ✅ **Built** — **the Review step redesign** (§5): severity re-anchored to consequence (a blank
   required value is critical, not a soft warning); a single consequence line from the verified
   `rowsAtRisk()` model (§5a) replacing the verdict banner + count chips; consequence-ranked task
   list with the fix opening from the row (`FillGapDialog`, `ConfirmVariantsDialog` — evidence,
   no confidence score, §5b); record-count/relationship panel moved to the Import step. Plus the
   backend fix this surfaced: a unit-less part used to **500 the whole 500-row batch** (the
   `parts_requires_unit` DB constraint the importer didn't mirror); it now skips its own row.
   `REFERENTIAL_LINKS` and required-fields are single-sourced so the check and the fix can't drift.
8. ✅ **Sharpened from a live drive on the real Tangle export** (§5, §5b, §8): units speak the
   app's canonical unit system, not raw export codes; actionable tasks became interactive cards
   with verb buttons (the flat rows didn't read as clickable); the "table below" copy and the AI
   "gotchas" were cut; the `/narrative` call was dropped (Map→Review is now instant + deterministic);
   and the parallel "Fix your data" grid became a collapsed "See or edit all your data" escape
   hatch, so there's one guided fix surface, not two competing ones.
9. ✅ **Import made robust + legible on real scale.** Two 500s that only showed on the 8,393-part
   export were fixed: the parts importer inserted a **dropped** `part_procurement_tiers.vendor_id`
   (PGRST204), and collision-detection lookups hit PostgREST's **1000-row cap** so re-importing a
   big company duplicate-keyed — now every importer's company-scoped lookup pages via
   `utils/db_pagination.fetch_all_by_company`. And the ~65-batch write got **live progress**
   (`runImportPlan` emits per-batch snapshots → `ImportProgressPanel`): a determinate bar keyed on
   rows-written, a stage checklist that ticks off in write order with a per-stage error state, a
   beforeunload guard, and reassurance copy — no ETA, no cancel (research-backed: NN/g/Carbon/
   Material for a &gt;10s side-effecting operation). True leave-and-return would need a server-side
   job (the loop is browser-driven today) — deferred.
