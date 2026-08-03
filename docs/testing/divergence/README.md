# Divergence reports

Each file here is a **dated record of one audit**: what a module's doc claimed,
what the code actually did, and what was changed to reconcile them. They are
history, not living documentation. Read the module spec in
[`docs/modules/`](../../modules/) for current behaviour.

Because they are history, they are **not** rewritten when the things they cite
move. A report that says "X does not exist" was accurate on the day it was
written, and editing it to match today would destroy the only record of what was
found.

## `supabase/schema.prod.sql` is cited here and no longer exists

Many of these reports name `supabase/schema.prod.sql` in their `Method:` line or
their evidence. That file was a snapshot exported from the production database.
**It was deleted on 2026-08-03.** The citations are left in place deliberately —
those audits really did consult it.

It was removed because it could disagree with production and nothing would
notice. It had been hand-edited inside a feature PR to add
`customer_contacts.is_billing_default` while production had no such column, with
its `Generated:` header left untouched, and it asserted that falsehood for two
days — through an outage where every job and quote page read "Job not found",
during which it had to be ignored in favour of dumping production live.

Where to look now, depending on the question:

| Question | Source |
|---|---|
| What *should* the schema be? | [`supabase/migrations/`](../../../supabase/migrations/) — the executable source of truth |
| What columns exist? | [`types/database.ts`](../../../types/database.ts) — generated from the migrations, CI-enforced |
| RLS policies, grants, CHECK constraints, function bodies | The migrations — none of these appear in `types/database.ts` |
| What does *production* actually have? | The Supabase MCP server, live |
| Are migrations and production in sync? | [`scripts/check_prod_migrations.py`](../../../scripts/check_prod_migrations.py), run on every merge |

See the "Schema source-of-truth" section of [`CLAUDE.md`](../../../CLAUDE.md) for
the full standard.
