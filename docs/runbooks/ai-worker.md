# Running the desktop AI worker

The worker is a Python process on the shop's Windows box. It polls the `ai_jobs`
queue over an **outbound** connection, runs Ollama at `localhost`, and writes
results back. Nothing dials in — there is no tunnel, no ingress and no Access
policy to maintain.

Related: [ai-insights.md](../modules/ai-insights.md) for the SQL sandbox the
insights handler runs inside, and
[local-dev-and-testing.md](local-dev-and-testing.md) for the local stack.

---

## 1. The box

```
OLLAMA_KEEP_ALIVE=-1      # keep the model resident; an eviction turns every job
                          # into a 43-63 second reload
NUM_PARALLEL=1            # one generation at a time on one card
```

```powershell
ollama pull qwen3:8b
curl http://localhost:11434/api/ps      # the model should be listed as resident
```

**One resident model on 8 GB of VRAM.** That constraint is why `claim_ai_jobs()`
returns a single-model batch and prefers whatever is already loaded — see §4.

## 2. Credentials

Two DSNs, two roles, one process. That split is the whole least-privilege story:

| Variable | Role | Can do |
|---|---|---|
| `WORKER_DATABASE_URL` | `jigged_ai_worker` | claim/report `ai_jobs`, insert `ai_calls`, keep its heartbeat |
| `AI_READONLY_DATABASE_URL` | `jigged_ai_readonly` | the insights `execute_sql` sandbox, per-company scoped by RLS |

**Where they go.** [`worker/__main__.py`](../../worker/__main__.py) loads `worker/.env`
and then `.env.local`; `override=False` means the **first** definition of a name wins, so
precedence is shell > `worker/.env` > `.env.local`. That ordering is load-bearing rather
than cosmetic — `.env.local` is where the *local stack's* superuser
`AI_READONLY_DATABASE_URL` lives and the guard below exempts localhost, so the reverse
would unscope the SQL sandbox in silence. Put the box's real DSNs in `worker/.env`.

`jigged_ai_worker` is created **NOLOGIN** by its migration, exactly as
`jigged_ai_readonly` was: a password in a migration file would be a credential in
git. Grant `LOGIN` and a real password by hand in the Supabase dashboard for
production. Locally and on preview branches `supabase/seed.sql` does it for you.

> **Never give the worker the service-role key.** It would bypass RLS entirely,
> and the reason the queue can be polled safely is that RLS scopes this role to
> `executor = 'worker'` rows.

> **Never point `AI_READONLY_DATABASE_URL` at the `postgres` superuser.** That
> role is `BYPASSRLS`, so the SQL sandbox's per-company scoping would silently do
> nothing and one shop's question could return another shop's rows. `.env.local`
> points it exactly there for the local stack, so this is one copy-paste away —
> `worker/config.py` refuses to start if it sees that shape against a remote host,
> but the check is a backstop, not permission to be careless.

## 3. Start it

```bash
conda run -n jigged pip install -r api/requirements.txt -r worker/requirements.txt
conda run -n jigged python -m worker
```

Confirm it registered:

```sql
select worker_id, last_seen_at, resident_model, models from ai_workers;
```

A heartbeat inside 60 seconds is what makes the feature "available". Staler than
that and every queued job for its models sweeps to `timed_out` / `ai_offline`,
and the UI says the box is off.

## 4. What the loop does, and the two things that are easy to get wrong

Each tick: sweep → claim (up to 8, single model) → run them one at a time →
report. Heartbeat every 15 s; leases renewed every 60 s.

**The claim is capped at 8 for every model, and that is correctness rather than
tuning.** Preemption happens only at a claim boundary, so the claim size *is* the
worst-case wait for an interactive question sitting behind a batch. A 40-job claim
would make the priority ordering decorative. The cap is enforced in SQL, so
passing a bigger number does nothing.

**Lease renewal covers every job held, not the one running.** Claim 8 pages at
30 s each and job 8 sits `claimed` with a stale lease for three and a half minutes
before it is even started — renewing only the in-flight job would sweep it out
from under itself mid-queue.

## 5. Stopping it

`Ctrl-C` releases unstarted claims back to `queued`, fails whatever was mid-flight
as `ai_offline`, and **backdates** its heartbeat rather than deleting the row —
`ai_jobs.claimed_by` names this worker on completed jobs, and deleting the
registry row would erase that from the historical record. The UI reaches its
offline state within one poll instead of after a two-minute silence.

## 6. When something is wrong

| Symptom | Look at |
|---|---|
| UI says offline, worker is running | `select last_seen_at, models from ai_workers` — is the job's model in `models`? The sweep is model-aware, so a live worker that cannot serve `qwen3-vl:4b` does not keep a drawing job alive. |
| Jobs queue and never start | `select status, model, count(*) from ai_jobs group by 1,2`. A model no worker advertises stays queued until the sweep. |
| Every job times out at ~45 s | The model is being evicted between calls. Check `OLLAMA_KEEP_ALIVE=-1` and `ollama ps`. |
| An insights job fails with a SQL error | That is fed back to the model for self-correction and is often not a bug. Persistent ones: `AI_READONLY_DATABASE_URL`, and the allowlist in `api/tools/schema_context.py`. |
| A job sits `running` forever | Only for `executor='backend'` rows — the worker's sweep cannot see them by design. The next enqueue reconciles it; the browser gives up on the lease regardless. |

Cost, per attempt, joined to the job by `request_id`:

```sql
select feature, provider, model, count(*) attempts,
       sum(est_cost_usd) usd, round(avg(latency_ms)) avg_ms,
       count(*) filter (where not success) failures
  from ai_calls
 where created_at > now() - interval '7 days'
 group by 1,2,3 order by usd desc;
```
