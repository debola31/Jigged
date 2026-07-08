# Divergence report — Demo Company (#349)

Method: compared `docs/modules/demo-company.md` (the SUPERSEDED v1 PRD) against the live code — grepped for every v1-specific route/function/table/column/component across the whole repo (excluding `docs/`), inspected `supabase/schema.prod.sql` (`companies` columns, demo RPCs), `api/routes/`, `utils/`, `components/`, and cross-checked the superseding `docs/modules/demo-mode.md` + its divergence report (#337).

**Verdict (Lane C — verify-supersede): confirmed superseded. No residual v1 behavior ships.** The doc's own header already marks it "SUPERSEDED by [Demo Mode](../../modules/demo-mode.md), retained for historical reference only." Every v1-specific artifact this PRD specifies is absent from the codebase; the only demo functionality that ships is the v3 Demo Mode feature, which has its own doc and divergence report. Therefore **no acceptance criteria were added to `demo-company.md`** (it describes a design that does not ship) and its prose was left untouched — the audit of the shipping demo feature lives in `docs/testing/divergence/demo-mode.md` (#337).

## Fixed in this PR

None. The doc is explicitly retained as historical reference and its header already points readers to the superseding Demo Mode PRD. Editing v1 prose to match v3 reality would be wrong — the correct home for the shipping behavior's ACs/divergence is `demo-mode.md`, which already has them. No clear-cut doc bug to correct in a file that documents a superseded design.

## Decision needed

None. The supersession is unambiguous and already recorded in the doc header and in `demo-mode.md §16 "Supersedes"`. There is no product judgment call hiding here — the v1 design was replaced wholesale, and the replacement is audited separately.

## Informational / aligned

Evidence that **no v1 Demo Company code ships** (each grep run over the repo with `--glob '!docs/**'` returned zero hits):

- **DB functions:** `clone_demo_company()` — none. `_populate_demo_company()` — none. (v1's core clone + shared-populate helpers were never implemented under these names.)
- **FastAPI routes:** no `/api/demo/create`, `/api/demo/reset/{company_id}`, or `/api/demo/templates*` routes exist anywhere in `api/`. The doc's entire §8 "API Endpoints" describes routes that were never built; the shipping demo feature is Supabase-first (client RPCs via `utils/demoAccess.ts`), per CLAUDE.md.
- **Tables:** the v1 `demo_templates` table does not exist — the shipping table is `demo_data_templates` (v3 rename). Confirmed in `supabase/schema.prod.sql`.
- **`companies` columns:** the v1 columns `demo_template_id` and `demo_owner_id` do not exist. The shipping columns are `is_demo` (line 21) and `demo_company_id` (line 22, FK → companies ON DELETE SET NULL) — the v3 model (real company points at its hidden demo), not v1 (demo points back at its owner/template).
- **UI components:** v1's `DemoBanner` and `DemoResetButton` do not exist. The shipping components are `components/demo/DemoModeBanner.tsx`, `components/demo/OnboardingCard.tsx`, and `components/providers/DemoModeProvider.tsx` (v3).
- **Bootstrap:** the doc's promised `scripts/bootstrap-admin.sql` does not exist.

Shared-infrastructure caveat (these exist, but are v3, not residual v1):

- **`system_admins` table + `is_system_admin()` (`SECURITY DEFINER`)** and **`companies.is_demo`** do ship — the Demo Mode PRD (§4.5) explicitly *revives* this platform-admin infrastructure and the `is_demo` flag. They are documented and aligned in `docs/testing/divergence/demo-mode.md` ("Informational / aligned"), so no new coverage is owed here.
- **`reset_demo_company()`** is the one function name shared between v1 and v3, but the shipping function is v3's: signature `reset_demo_company(p_source_company_id uuid, p_user_id uuid)` (`supabase/schema.prod.sql` line 5017) — not v1's `reset_demo_company(p_company_id uuid)`. It wipes the *linked* demo company and re-seeds; this is covered by the demo-mode ACs/divergence, not this file.

**Conclusion:** the module still-ships check is negative for v1. No follow-up issue is needed — the shipping demo feature already has a doc (`demo-mode.md`) and an audited divergence report (#337). This report exists only to record that the v1 PRD was verified as fully superseded with zero residual code.
