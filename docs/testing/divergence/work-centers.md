# Divergence report — Work Centers (#345)

Method: compared `docs/modules/work-centers.md` against the live schema (`supabase/schema.prod.sql` — `work_centers` table + CHECK constraints + column comments), the access layer (`utils/workCentersAccess.ts`, `types/workCenter.ts`), the UI (`app/dashboard/[companyId]/work-centers/{page,new,[workCenterId]/page,[workCenterId]/edit/page,import/page}.tsx`, `components/work-centers/WorkCenterForm.tsx`), the FastAPI import pipeline (`api/routes/work_centers_import_routes.py`), and the tests (`__tests__/utils/workCentersAccess.test.ts`, `api/tests/integration/test_work_centers_import_api.py`, plus the routing-side E2E `e2e/parts-and-routing.spec.ts`).

Distinct from the Operations module: an operation *runs at* a work center. This doc is about creating/maintaining the capacity buckets themselves (`work_centers`); it does not cover routing-operation editing.

## Fixed in this PR

- **List uses two kind tabs, not a "kind dropdown (All / Internal / External)".** The doc described a single AG Grid with a filter dropdown, a **Kind** chip column, and a cross-kind **Cost** comparator that "pins external rows to the bottom." The real page (`app/dashboard/[companyId]/work-centers/page.tsx`) has an MUI **Tabs** control (Internal / External) with **no combined view** and no "All" option; each tab re-queries via `getWorkCentersByKind` and renders kind-specific columns. Rewrote the List section into per-tab column lists.

- **External rows have no Cost column / no "Per operation" cell / no comparator.** Doc said external rows show "Per operation" in the Cost column and that a comparator keeps internal rows sorted and pins external rows to the bottom. Because the kinds live on separate tabs, the External tab's columns are Name / Vendor / Description / Updated — there is no Cost column at all, and the "priced per operation" statement is a caption above the grid, not a cell value. Corrected.

- **`labor_rate` is required for internal work centers, not "optional".** The Create section listed `labor_rate` as "(number, ≥ 0, optional)". `WorkCenterForm.validateForm` rejects an empty or negative rate for `kind='internal'` with "Labor rate is required for internal work centers" (rationale in-code: an unpriceable internal op). Changed "optional" to "required (for internal)" and documented the non-negative rule.

- **Kind toggle is locked in edit mode when referenced.** The doc's Create section didn't mention that editing a work center already used by routing operations disables the Internal/External toggle (`kindLocked = mode === 'edit' && routingOperationsCount > 0` in `WorkCenterForm.tsx`) — flipping kind would orphan pricing on every referencing operation. Added.

- **Import goes through the FastAPI import router, not a plain client call.** The doc described "CSV upload, column mapping, validation, execute" without saying where it runs. It is the `api/routes/work_centers_import_routes.py` pipeline (prefix `/api/work-centers/import`, `/analyze` + `/validate` + `/execute`, AI column mapping, conflict detection) — a legitimate FastAPI use per the Supabase-first rule. Named the router, the endpoints, and the concrete conflict/error types (`unknown_vendor`, `vendor_forbidden_for_internal`) that the integration tests assert. Noted that `bulkImportWorkCenters` in the access layer is the unit-covered reference implementation of the same rules.

- **Added the missing Edit page and the Print Placards action.** The Pages list jumped Detail → Create → Import, omitting `/{workCenterId}/edit` (renders `WorkCenterForm` in edit mode, hydrated via `getWorkCenterWithRelations`). The List section also omitted the internal-tab **Print Placards ({count})** button (`generateStationPlacards` — one A4 station-QR placard per internal work center in a single PDF). Both added.

- **Station QR caption source clarified.** The Detail section said the Station QR Code card "renders `metadata.code`." The scan URL is actually keyed off the work-center **id**; `metadata.code` is only an optional *printed caption* (`operationCode` prop on `StationQRCode`). Reworded to reflect that (see Resolved: the station-code concept was dropped).

## Resolved (owner decision)

- **`metadata.code` / station code — DROPPED.** No create/edit/import path ever writes `metadata.code` (the form inserts `metadata: {}`; `bulkImportWorkCenters` sets `metadata: { legacy_id }` — not `code`; no seed or migration backfills it), so the Station QR caption was always blank. **Decision:** drop the station-code concept entirely — do **not** add a station-code field or a backfill. The QR keys off the work-center `id`; the `StationQRCode` `operationCode` caption prop is simply left unset. The doc's data-model `metadata` row and Detail → Station QR Code card were reworded to remove the `code`-caption idea.

- **`getAllWorkCenters` and `getWorkCentersFlat` — DEAD, remove.** The list page queries per tab via `getWorkCentersByKind`, and routing pickers use `getWorkCentersForRouting`; neither `getAllWorkCenters` (unit-test-only) nor `getWorkCentersFlat` (no callers at all) has a live caller. **Decision:** they are dead. Removed both rows from the access-layer table and noted that code-level pruning is tracked in **#550** (the functions still exist on disk until that lands, so their unit tests remain valid citations).

## Informational / aligned

- **Data model matches the schema.** `work_centers` columns (`kind` default `internal`, `labor_rate numeric(10,2)`, `vendor_id`, `metadata jsonb default '{}'`) and the three CHECK constraints (`work_centers_kind_check`, `work_centers_external_requires_vendor`, `work_centers_internal_no_vendor`) plus `work_centers_unique_per_company` all line up with the doc's table and the "vendor required iff external" rule. The doc's note that `external_setup_cost` was dropped (June 2026) is consistent — no such column exists.

- **`internal` clears vendor / `external` clears labor_rate on write.** `createWorkCenter`/`updateWorkCenter` null the non-applicable field, and `WorkCenterForm.handleSubmit` defensively forces `labor_rate=''` for external before submit — matches the doc and is unit-covered (`createWorkCenter > 'inserts a work center with parsed labor_rate and nulled vendor_id for internal kind'`).

- **Delete FK guard.** `deleteWorkCenter`/`bulkDeleteWorkCenters` map Postgres `23503` to a friendly "used in routing operations" error, and the detail page + confirm dialog disable Delete when `routing_operations_count > 0` (`routing_operations_work_center_id_fkey` is `ON DELETE RESTRICT`). Matches the doc; unit-covered for the error mapping.

- **Consumed-by relationships.** `routing_operations.work_center_id` (`ON DELETE RESTRICT`) and `job_operations.work_center_id` (`ON DELETE SET NULL`) reference `work_centers`; the routing picker uses `getWorkCentersForRouting` (vendor name pre-joined). Consistent with the "referenced by Routings" framing.

- **Sidebar + PRD.** Navigation label is "Work Centers" (`components/layout/Sidebar.tsx`); PRD FR-5 (station QR placard sign-in, one per work center) and the labor-rate cost inputs (`work_centers.labor_rate`) are consistent with this module. No change needed.
