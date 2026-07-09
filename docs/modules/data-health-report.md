# Data Health / Import-Readiness Report

Read-only, advisory tool that helps a shop **already committed to adopting Jigged** get
its legacy data in cleanly. The shop uploads its previous ERP's CSV exports; the tool
reads them (writing to no business system), identifies each file's columns, detects the
likely source ERP, and reports data-health findings plus concrete fixes so the
white-glove migration goes in accurately and completely.

It is an **onboarding aid, not a sales-demo / conversion tool**.

## Scope

- **In:** multi-CSV upload; per-file entity classification + raw→canonical column mapping;
  source-ERP detection with a confidence score and matched-header evidence; deterministic
  data-health findings; a grounded plain-English narrative + recommendations.
- **Out (deferred):** the per-ERP "gotcha" rule *library* (#522 — the AI surfaces
  informative, clearly-labeled observations for now); server-side persistence and
  detection-template / fine-tuning harvesting; any write/import path.

## Architecture — where each stage runs

The rows a shop uploads can be large, and this report is read-only (no write path, no
trust boundary). So the **deterministic analysis runs in the browser** on rows that are
already parsed there — the raw rows never hit the server (no Vercel 4.5 MB body limit,
nothing stored), while the **two AI steps stay on the server** because they need the
secret API key and take only tiny payloads. One explicit user action (the **Analyze**
button) runs three stages:

1. **AI "structure" call** — `POST /api/health-report/structure`. Payload: headers + a few
   sample rows per file. Returns per-file entity type, raw→canonical `column_roles`, and
   ERP detection (`AIProvider.analyze_structure`,
   [api/services/ai/claude_provider.py](../../api/services/ai/claude_provider.py)). Bad
   responses degrade to `source="unknown"` and drop hallucinated headers.
2. **Deterministic analyzer (browser)** — [lib/healthReportAnalyzer.ts](../../lib/healthReportAnalyzer.ts).
   Pure TypeScript, no network. Computes record counts, normalized within-file duplicates,
   cross-file orphan references (using the **asymmetric** join keys — parts identify by
   `part_name`, vendors/work-centers/customers by `name`), missing/blank required columns,
   cost coverage %, name-variant grouping, and inactive flags. A check that can't run emits
   one explicit "not checked" finding — never a silent `0` and never phantom orphans. This
   is a faithful port of the original Python analyzer; the logic now lives only here (single
   source of truth), tested under vitest ([__tests__/lib/healthReportAnalyzer.test.ts](../../__tests__/lib/healthReportAnalyzer.test.ts)).
3. **AI "narrative" call** — `POST /api/health-report/narrative`. Payload: the
   client-computed findings + file summaries (no rows). Returns plain-English prose grounded
   strictly in those findings; on failure it returns `narrative_available=false` and the UI
   shows the raw findings rather than fabricated prose.

## Endpoints

Both live in [api/routes/health_report_routes.py](../../api/routes/health_report_routes.py)
(registered in `api/index.py`) and are AI-only + advisory:

- **Caller authorization** via `_verify_company_access` (bearer JWT → `user_company_access`).
- **Opt-in server-side feature gate**: `companies.settings.features.data_health_report`
  (the client flag only hides the nav; each endpoint enforces its own gate and fails closed).
- **Caps** (files / headers) → `413`.
- **No writes**: only SELECTs; no `auth.admin`; no on-disk cache; no row storage. An
  AST-level test in
  [api/tests/integration/test_health_report_api.py](../../api/tests/integration/test_health_report_api.py)
  guards that the module makes no insert/upsert/update/delete/rpc/`auth.admin` call and
  imports no `*_import_routes` path.

## Frontend

`/dashboard/{companyId}/health-report`
([app/dashboard/[companyId]/health-report/page.tsx](../../app/dashboard/%5BcompanyId%5D/health-report/page.tsx)):
`upload → analyzing → review`. Multi-file drag-and-drop (`MultiFileDropzone`) parses each
CSV locally; the page calls `/structure`, runs `analyzeBundle` in the browser, then calls
`/narrative`, and composes the report for `HealthReportView` (a hedged detection line,
per-file classification chips, severity-grouped findings, an "AI-inferred" chip on
unverified gotchas). Nav item is gated behind the opt-in `data_health_report` flag. The AI
calls fire only on the explicit **Analyze** click.

## Data model

[api/models/health_report_models.py](../../api/models/health_report_models.py) holds the
report/finding/detection Pydantic models + `ENTITY_SCHEMAS` (for the AI structure prompt)
and `ERP_CATALOG`. The deterministic join graph / identity fields live with the analyzer
that uses them (in TypeScript). Nothing is persisted server-side in this slice.

## Related

Epic #492; sub-issues #519 (upload UI), #520 (detection), #521 (findings), #522 (gotcha
rules — deferred), #523 (endpoints), #524 (schema). Reuses the AI provider layer and the
import-model target schemas (`PART_SCHEMA`, `VENDOR_SCHEMA`, …).
