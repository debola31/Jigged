Evaluating Jigged's Testing-Infrastructure Gaps
Context
A bug shipped in production: editing a quote silently does nothing — adding a new part doesn't persist, and quote_line_items.unit_price diverges from the part's current pricing tiers (because the price is snapshotted at creation but tiers are live). You want to understand the systemic question this raises: where are test procedures supposed to be documented in this repo, what's actually there today, and how does this compare to industry-standard practice? The quote bug is the trigger; the deliverable is a diagnosis of the documentation/coverage system, not a code fix.

Per your instructions: evaluation only (no code), edit-policy options laid out without a recommendation, and the analysis covers the whole testing-doc landscape — not just edits, not just quotes.

1. What testing documentation exists today (inventory)
The repo has three distinct documentation layers that, in theory, should answer "is this behavior tested?" — but in practice each has gaps.

Layer A — Per-module acceptance criteria
docs/modules/quotes.md and every other docs/modules/*.md ends in an ## Acceptance Criteria section: bulleted checkboxes describing testable behaviors per feature area. This is the closest thing to a "test plan" the repo has. Quote module example (docs/modules/quotes.md:483-535) covers create, search, filter, convert-to-job, per-quote price overrides, and even regression notes (#224). It's a good pattern.

The gap: the criteria describe behaviors in the abstract ("Quote header is editable; line items are read-only after creation" — line 499) but never describe the verification procedure that proves it ("open quote → change customer → save → reload → verify customer changed"). They tell you what should be true; they don't tell you how to test it. So no one is held to writing a corresponding test.

Layer B — Centralized test catalog
docs/testing/test-matrix.md is a CSV-style matrix with IDs (BL-001, DV-001, EH-001, IM-001), categories (Business Logic, Data Validation, Error Handling, Import), preconditions, pass/fail criteria, and test file pointers. This is the industry-standard "test case management" artifact in miniature.

The gap: it's tiny and stale.

Only 24 cases total — clearly not the actual coverage (we have hundreds of Vitest + pytest + Playwright tests).
It still lists BL-001/BL-002 against pending_approval quote status, which was removed in April 2026. The matrix has been frozen for over a year.
Zero "user journey" entries (UJ-* or E2E-* category). Everything is unit-test-shaped: input → expected output. There is no row for "edit a quote and verify it persists."
No traceability back to module ACs or to PRD FRs.
Layer C — Test registry & coverage targets
docs/testing/test-registry.md tracks per-file test counts and explicitly known skips. docs/testing/checklist.md sets per-module coverage targets.

The gap (and the smoking gun for this bug): the registry says tests/utils/quotesAccess.test.ts has 9 skipped tests, including the updateQuote happy path, marked "sub-PR 3f territory." The checklist says quotes target is 80% but current is 33%. The system knew this was uncovered and shipped anyway. The registry surfaces the debt but nothing gates on it.

Layer D — E2E doc & specs
docs/testing/e2e.md is aspirational template code — it shows an example "Customer CRUD" spec with create / search / edit and a "Quote to Job" flow including Send → Accept steps (which don't exist in the product). It hasn't been touched since March 2026 and does not reflect what was built. The four actual specs (e2e/smoke.spec.ts, e2e/parts-and-routing.spec.ts, e2e/quote-to-job.spec.ts, e2e/csv-import.spec.ts) cover create-only flows; no spec opens an existing entity, edits it, reloads, and verifies persistence. This is the structural pattern that lets the quote-edit bug slip.

Layer E — README & guides
docs/testing/README.md (54KB), docs/testing/frontend-setup.md, docs/testing/backend-setup.md, docs/testing/database-rls.md, docs/testing/cicd.md. These cover how to write tests — patterns, harness setup, CI wiring. They do not enumerate what behaviors must be tested.

2. How the quote-edit bug slipped through — three-layer trace
For this specific bug, every layer that should have caught it failed:

Layer	What it should have said	What it actually says
PRD/Module spec (docs/modules/quotes.md)	The form lets users edit parts on an existing quote; the backend updateQuote() only touches metadata (customer/lead time/expiration). Either remove that UI affordance or document that line items are immutable and pricing is frozen at creation.	Line 499 says "line items are read-only after creation" and line 7 says "snapshots…never modified." The spec is correct — but the AC has no verification step ("the UI prevents editing line items") and the form still exposes part fields. Spec and UI disagree silently.
Module AC (docs/modules/quotes.md:483-535)	Should include: "Editing the customer / lead time / expiration on an active quote saves and survives reload."	The AC says edits exist but never says "saves and persists." No reload verification anywhere.
Unit tests (tests/utils/quotesAccess.test.ts:403-407)	A happy-path test for updateQuote() that asserts the SQL writes through and a returned shape with updated fields.	9 skipped, including this exact case. Deferred to "sub-PR 3f."
E2E (e2e/quote-to-job.spec.ts)	An edit-quote spec that creates a quote, reopens it by ID, changes a field, saves, reloads the page, verifies the change.	The only quote spec is create-then-convert in one session. No reopen. No reload. The bug class is "edits don't persist across the session boundary" — and that boundary is never crossed in tests.
Test matrix (docs/testing/test-matrix.md)	A UJ-001 row "Edit quote metadata persists" or similar user-journey entries.	Zero user-journey rows. The matrix tracks input/output primitives, not flows.
Conclusion: the bug isn't a freak miss — it falls in a structural blind spot. The repo tests what data layers do with valid input and what new entities look like at creation, but doesn't systematically test what already-persisted entities do when re-edited. Across all four E2E specs, none of them perform an edit → reload → assert cycle on any entity.

3. Industry-standard framing — what mature test-documentation systems look like
For comparison (not prescription — pick what fits Jigged's scale):

Requirements → Test traceability. Each PRD FR or module AC gets a stable ID; each test (unit / integration / E2E / manual) references the IDs it covers. A traceability report shows orphan FRs (no test) and orphan tests (no FR). ISO 29119 and IEEE 829 codify this; in practice teams use Linear/Jira labels or a CSV like test-matrix.md but kept live.
Test plan vs. test cases vs. test runs. A plan is the strategy (what layers, what risk areas, what's manual vs. automated). Cases are the parameterized behaviors. Runs are the executions. Jigged has a plan-like README and case-like registry but no run history other than CI logs.
User-journey coverage as a first-class category. Mature suites have a row per journey: signup → first quote → first job → first ship. Each journey includes "open existing, edit, save, reload, verify" steps because that's how real users behave. Pure CRUD or pure unit coverage misses this layer by construction.
Definition of Done includes "AC verified end-to-end." Each new feature PR is gated on (a) the module AC being updated and (b) at least one automated test referencing each new AC bullet, with manual-only items explicitly flagged. This catches "spec says X is editable" + "no test proves X persists" early.
Skip-debt budget. Skipped/xfail/fixme tests are tracked with explicit ETAs and ratchets — e.g. "no PR may add a skip without an issue number, and total skips trend down weekly." Jigged's test-registry.md notes skips but nothing ratchets them.
Cross-session persistence tests. A specific E2E convention: every "edit" flow includes page.reload() between save and assertion. This catches the entire class of bug where the UI optimistically updates but the DB write was a no-op. Adopting this convention alone would have caught the quote bug.
Jigged's existing artifacts (test-matrix.md, module ACs, test-registry.md) already encode the shape of an industry-standard system. The gaps are upkeep, scope (user-journey rows), and enforcement (gating).

4. Concrete gaps to close (no priority assigned — yours to sequence)
Documentation gaps

test-matrix.md is stale by 12+ months — references removed pending_approval status, lists 24 cases vs. hundreds of actual tests, has no user-journey category.
e2e.md is template fiction — describes specs that don't exist and steps the product doesn't support.
Module ACs across all modules describe behaviors but never describe verification procedure (no "reload and confirm" steps).
No documented convention for snapshot-vs-live data behavior. The bug exposes that quote unit_price is frozen but the UI shows current tiers next to it — a designed-in surprise that has no spec home. Compare to feedback_no_silent_fallbacks.md — that principle covers schema migration drift but doesn't speak to pricing snapshots.
No "quote edit policy" doc — spec says metadata-only but UI exposes parts. See §5 below.
Coverage gaps (structural, not just quotes)

No E2E spec performs open existing → edit → reload → assert persists for any entity. The bug class "writes silently no-op" is invisible to this suite.
Unit tests for *Access.ts files have happy-path skips for update* functions across multiple modules. test-registry.md tracks them; nothing acts on them.
No regression test catalog. Issues with regression risk (the #224 setup-only operations bug mentioned in quotes AC line 511) get one-line AC entries but no dedicated tracking.
No coverage of snapshot/live divergence for pricing tiers, BOM pricing, or routing rate changes — same drift pattern, multiple surfaces.
Process gaps

No PR-template gate requiring updated ACs + at least one test reference per new behavior.
Skipped tests can be added without ratchet; the registry observes but doesn't enforce.
No periodic doc-drift audit. The April-2026 status removal didn't trigger a test-matrix update.
5. Quote-edit policy — two options laid out
Per your instructions, presenting both without a recommendation. You'll pick before any code changes.

Option A — Lock the edit form to metadata-only. Spec already says line items are immutable. Match the UI: when mode === 'edit', render parts as read-only display, hide "Add part" affordance, gray out tier checkboxes. updateQuote() stays as-is. To change parts, the user creates a new quote.

Pros: matches existing spec; tiny code change; no pricing-staleness problem because nothing changes after creation.
Cons: salesperson workflow is "make a new quote" for any line-item edit, including a typo or quantity change. May not fit Johnny's day-to-day (see project_usability_test_johnny.md).
Option B — Implement full line-item reconcile + decide pricing-refresh rule. updateQuote() reconciles quote_line_items (insert new, update existing, delete removed) like createQuote does. Then resolve a sub-question: when a line item is edited, does unit_price re-snapshot from the current pricing tier, or stay frozen? The "Pricing tiers (reference)" UI in the screenshot implies live tiers — the current frozen behavior is what's confusing your users.

Pros: matches user intuition; eliminates the displayed price vs. reference price mismatch.
Cons: bigger code change; introduces a new policy question (snapshot vs. refresh on edit); needs a UI signal for "this line was repriced because tiers changed."
This decision belongs in a documented snapshot-vs-live policy that applies beyond quotes — same question hits BOM costs and routing rates.

6. Verification — how to know this evaluation is correct
Since this is an evaluation, "verification" means confirming the gaps I've named are real before acting:

grep -r "reload\(\)\|page.reload" e2e/ should return zero hits (confirms no E2E spec reloads after save).
grep -r "test.skip\|it.skip\|describe.skip" __tests__/utils/ should surface the documented skips in quotesAccess.test.ts and similar.
Open docs/testing/test-matrix.md and confirm: (a) no rows tagged UJ-* or user-journey, (b) pending_approval references still present, (c) Implemented count = 22 while find __tests__ -name "*.test.ts" | wc -l returns far more.
Open docs/modules/quotes.md:499 and confirm the AC says "editable" but has no "persists on reload" verification clause.
Spot-check three other module specs (jobs, parts, customers) and confirm the same AC-without-verification pattern holds — proves the gap is structural, not quotes-specific.
If those checks confirm, the diagnosis stands and the next conversation can move to deciding the edit policy (§5) and prioritizing the gap closures (§4).