# Data Health / Import-Readiness Report

Read-only, advisory tool that helps a shop **already committed to adopting Jigged**
get its legacy data in cleanly. The shop uploads its previous ERP's CSV exports; the
tool reads them (never writing to any business system), identifies each file's columns,
detects the likely source ERP, and reports data-health findings plus concrete fixes so
the white-glove migration goes in accurately and completely.

It is an **onboarding aid, not a sales-demo / conversion tool**.

## Scope

- **In:** multi-CSV upload; per-file entity classification + raw→canonical column mapping;
  source-ERP detection with a confidence score and matched-header evidence; deterministic
  data-health findings; a grounded plain-English narrative + recommendations.
- **Out (deferred):** the per-ERP "gotcha" rule *library* (#522 — the AI surfaces
  informative, clearly-labeled observations for now); server-side persistence and
  detection-template / fine-tuning harvesting; any write/import path.

## Architecture

One explicit user action (the **Analyze** button) runs three stages:

1. **AI "structure" call** — `AIProvider.analyze_structure`
   ([api/services/ai/claude_provider.py](../../api/services/ai/claude_provider.py)).
   Classifies each file to an entity type and maps its raw headers to canonical fields
   (`column_roles`), and detects the source ERP. Uploaded CSVs use the *source ERP's* own
   headers, so this column identification must happen before any field-keyed check. Bad
   responses degrade to `source="unknown"` and drop hallucinated headers.
2. **Deterministic analyzer** — `analyze_bundle`
   ([api/services/health_report_analyzer.py](../../api/services/health_report_analyzer.py)).
   Pure Python, no AI, no DB. Computes record counts, normalized within-file duplicates,
   cross-file orphan references (using the **asymmetric** join keys in `REFERENTIAL_LINKS` —
   parts identify by `part_name`, vendors/work-centers/customers by `name`),
   missing/blank required columns, cost coverage %, name-variant grouping, and inactive
   flags. A check that can't run emits one explicit "not checked" finding — never a silent
   `0` and never phantom orphans.
3. **AI "narrative" call** — `AIProvider.generate_health_narrative`. Writes plain-English
   guidance grounded strictly in the deterministic findings (cites only their counts). On
   failure it returns `available=False`, and the UI shows the raw findings rather than any
   fabricated prose.

## Endpoint

`POST /api/health-report/analyze`
([api/routes/health_report_routes.py](../../api/routes/health_report_routes.py)),
registered in `api/index.py`. Advisory only:

- **Caller authorization** via `_verify_company_access` (bearer JWT → `user_company_access`).
- **Opt-in server-side feature gate**: `companies.settings.features.data_health_report`
  (client flag only hides the nav; the endpoint enforces its own gate and fails closed).
- **Size caps** (files / headers / total rows) → `413` rather than silent truncation.
- **Best-effort in-memory rate limit** (weak on serverless; the real bound is the flag +
  caller-auth).
- **No writes**: only SELECTs; no `auth.admin`; no on-disk cache (which would leak
  uploaded rows to disk). An AST-level test in
  [api/tests/integration/test_health_report_api.py](../../api/tests/integration/test_health_report_api.py)
  guards that the module makes no insert/upsert/update/delete/rpc/`auth.admin` call and
  imports no `*_import_routes` path.

## Frontend

`/dashboard/{companyId}/health-report`
([app/dashboard/[companyId]/health-report/page.tsx](../../app/dashboard/%5BcompanyId%5D/health-report/page.tsx)):
`upload → analyzing → review`. Multi-file drag-and-drop (`MultiFileDropzone`); results in
`HealthReportView` (a hedged detection line, per-file classification chips, severity-grouped
findings, an "AI-inferred" chip on unverified gotchas). Nav item is gated behind the opt-in
`data_health_report` flag. The AI call fires only on the explicit **Analyze** click.

## Data model

[api/models/health_report_models.py](../../api/models/health_report_models.py): `HealthReport`
(`schema_version`, `ErpDetection`, `FileClassification[]` with `column_roles`, `Finding[]` by
severity/category, `summary`, `recommendations`). The schema is kept reuse-ready so detection
templates / fine-tuning data can be derived later without a migration; nothing is persisted
server-side in this slice.

## Related

Epic #492; sub-issues #519 (upload UI), #520 (detection), #521 (findings), #522 (gotcha
rules — deferred), #523 (endpoint), #524 (schema). Reuses the AI provider layer and the
import-model target schemas (`PART_SCHEMA`, `VENDOR_SCHEMA`, …).
