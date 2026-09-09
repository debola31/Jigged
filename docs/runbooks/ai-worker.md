# Running the desktop AI worker

The worker is a Python process on the shop's own machine — a Windows PC with a GPU, or
an Apple-silicon Mac. It polls the `ai_jobs` queue over an **outbound** connection, runs
Ollama at `localhost`, and writes results back. Nothing dials in — there is no tunnel, no ingress and no Access
policy to maintain.

Related: [ai-insights.md](../modules/ai-insights.md) for the SQL sandbox the
insights handler runs inside, and
[local-dev-and-testing.md](local-dev-and-testing.md) for the local stack.

---

## 1. The box

Ollama serves the model at `localhost`; the worker only ever talks to it there. Three
server-side settings matter, set differently per platform:

| Setting | Why | Windows | macOS (Ollama.app is a launch agent) |
|---|---|---|---|
| `OLLAMA_KEEP_ALIVE=-1` | keep the model resident; an eviction turns every job into a 43–63 s reload | system environment variable, then restart Ollama | `launchctl setenv OLLAMA_KEEP_ALIVE -1`, then quit and relaunch Ollama.app |
| `OLLAMA_NUM_PARALLEL=1` | one generation at a time; one slot also keeps the ~13K-token insights prefix in the KV cache between jobs | same | `launchctl setenv OLLAMA_NUM_PARALLEL 1` |
| `OLLAMA_CONTEXT_LENGTH=32768` | belt-and-braces since September 2026: the worker's native adapter (`api/services/llm/ollama_provider.py`) pins `num_ctx=32768` on every request and refuses truncation, so an over-long prompt is a visible failure instead of a schema silently cut from the front. Set it anyway for anything else that talks to the box (the eval's embedding step, a manual `ollama run`) | same | `launchctl setenv OLLAMA_CONTEXT_LENGTH 32768` |

`launchctl setenv` does **not** survive a reboot: persist it in a LaunchAgent plist, or run the
server from a shell instead of the app —
`OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_KEEP_ALIVE=-1 OLLAMA_NUM_PARALLEL=1 caffeinate -s ollama serve`.
`caffeinate -s` keeps a lid-closed Mac awake on mains power (`sudo pmset -c disablesleep 1` is the
system-wide form); a sleeping box is offline to the UI within 60 seconds. *(This section used to
write `NUM_PARALLEL=1`; the variable Ollama reads is `OLLAMA_NUM_PARALLEL`.)*

```
ollama pull qwen3:32b          # qwen3:8b on an 8 GB card
ollama run qwen3:32b "hi"      # pre-warm: the first load is the slow one
ollama ps                      # resident, SIZE ~29 GB, CONTEXT 32768
```

`qwen3:32b` at q4 is ~20 GB of weights plus ~8.5 GB of KV cache at 32K — about 29 GB resident, which
fits a 48 GB Mac with headroom and does not fit an 8 GB card, where `qwen3:8b` stays the choice.
**One resident model.** That constraint is why `claim_ai_jobs()` returns a single-model batch and
prefers whatever is already loaded — see §4.

**The model tag must match byte for byte** between `LLM_CHAIN_INSIGHTS=ollama:<tag>` on Vercel and
`WORKER_MODELS=<tag>` on the box. `worker_can_serve`, `sweep_ai_jobs()`, `claim_ai_jobs()` and the
browser's heartbeat read all compare the string exactly, so `qwen3:32b` against `qwen3:32b-q4_K_M` is
a box that looks permanently offline while running.

## 2. Credentials

Two DSNs, two roles, one process. That split is the whole least-privilege story:

| Variable | Role | Can do |
|---|---|---|
| `WORKER_DATABASE_URL` | `jigged_ai_worker` | claim/report `ai_jobs`, insert `ai_calls`, keep its heartbeat |
| `WORKER_READONLY_DATABASE_URL` | `jigged_ai_readonly` | the insights `execute_sql` sandbox, per-company scoped by RLS |

**Where they go.** [`worker/__main__.py`](../../worker/__main__.py) loads the repo-root
`.env.local`, and the shell wins over it. That is the entire precedence rule.

**`WORKER_READONLY_DATABASE_URL` is named apart from the backend's
`AI_READONLY_DATABASE_URL` on purpose.** The value differs by *process*, not by
environment: one machine runs the backend against a local stack and the worker against a
real shop at the same time, and `.env.local`'s `AI_READONLY_DATABASE_URL` is the local
`postgres` superuser. **Withdrawn:** a two-file layout (`worker/.env` first, `.env.local`
second) held the same two values under one name — wrong because load order was then the
only thing between a shop's data and a `BYPASSRLS` connection, and nothing about a
correct run looked different from a wrong one. `export_sandbox_dsn()` copies the worker's
value onto the name [`api/tools/sql_executor.py`](../../api/tools/sql_executor.py) reads,
**overwriting** rather than defaulting — `.env.local` has already set that name by then.
The worker's startup line prints the role and host it resolved.

`jigged_ai_worker` is created **NOLOGIN** by its migration, exactly as
`jigged_ai_readonly` was: a password in a migration file would be a credential in
git. Grant `LOGIN` and a real password by hand in the Supabase dashboard for
production. Locally and on preview branches `supabase/seed.sql` does it for you.

> **Never give the worker the service-role key.** It would bypass RLS entirely,
> and the reason the queue can be polled safely is that RLS scopes this role to
> `executor = 'worker'` rows.

> **Never point `WORKER_READONLY_DATABASE_URL` at the `postgres` superuser.** That
> role is `BYPASSRLS`, so the SQL sandbox's per-company scoping would silently do
> nothing and one shop's question could return another shop's rows. The separate name
> is what keeps `.env.local`'s local superuser DSN out of this variable;
> `worker/config.py` refuses to start if it sees that shape against a remote host, but
> the check is a backstop for a hand-pasted DSN, not permission to be careless.

## 3. Start it

```bash
conda run -n jigged pip install -r api/requirements.txt -r worker/requirements.txt
conda run -n jigged python -m worker
```

### As a service (macOS launchd)

A worker started from a shell dies with the terminal. On the serving Mac it runs as a LaunchAgent
from [`worker/launchd/com.jigged.worker.plist.example`](../../worker/launchd/com.jigged.worker.plist.example):
starts at login, restarts if it exits (`KeepAlive`), and runs under `caffeinate -s`, which holds a
no-sleep assertion on mains power for as long as the worker lives (`pmset -g assertions` shows it).
The worker handles `SIGTERM`, so `launchctl bootout` is the same graceful stop as Ctrl-C.

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/jigged
PY=$(conda run -n jigged python -c 'import sys; print(sys.executable)')
sed -e "s#__PYTHON__#$PY#g" -e "s#__PYTHON_DIR__#$(dirname "$PY")#g" \
    -e "s#__REPO__#$PWD#g" -e "s#__HOME__#$HOME#g" \
    worker/launchd/com.jigged.worker.plist.example > ~/Library/LaunchAgents/com.jigged.worker.plist
plutil -lint ~/Library/LaunchAgents/com.jigged.worker.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jigged.worker.plist
launchctl print gui/$(id -u)/com.jigged.worker | grep -E "state|pid"     # running
tail -f ~/Library/Logs/jigged/worker.log                                # "worker <id> ready; models=..."
```

Stop or restart with `launchctl bootout gui/$(id -u)/com.jigged.worker` (and `bootstrap` again); after
pulling new worker code, bootout and bootstrap so the process picks it up. The DSNs and `WORKER_MODELS`
come from the repo's `.env.local` as before; nothing is duplicated into the plist.

**Ollama stays as Ollama.app.** Its own launch agent (`com.ollama.ollama`) serves `localhost:11434`
with no environment set, and that is fine: the native adapter sends `num_ctx=32768` and
`keep_alive=-1` on every request, `OLLAMA_NUM_PARALLEL` defaults to 1, and the serving Mac's server
log shows `CONTEXT 32768`, `UNTIL Forever` and zero truncation lines under that arrangement. A second
`ollama serve` under our own agent would fight the app's for the port, so §1's variables matter only for
other clients of the box (a manual `ollama run`, the eval's embedding step). What the agent does **not**
do is keep a closed-lid laptop awake; that is `sudo pmset -c disablesleep 1`, a system setting.

Confirm it registered:

```sql
select worker_id, last_seen_at, resident_model, models from ai_workers;
```

A heartbeat inside 60 seconds is what makes the feature "available". Staler than
that and every queued job for its models sweeps to `timed_out` / `ai_offline`,
and the UI says the box is off.

## 4. What the loop does, and the two things that are easy to get wrong

Each tick: sweep → claim (up to 8, single model) → run them one at a time →
report. Heartbeat every 15 s and leases renewed every 60 s **on their own task, during a job as
well** — until 2026-09-07 both ticked only between jobs, so a two-minute question made the box read
as offline to the next question (503 at enqueue) until it finished, and a job longer than its lease
would have been swept mid-run.

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
| UI says offline, worker is running | `select last_seen_at, models from ai_workers` — is the job's model in `models`, spelled exactly as `LLM_CHAIN_INSIGHTS` names it? The sweep is model-aware, so a live worker that cannot serve `qwen3-vl:4b` does not keep a drawing job alive, and a tag that differs by a suffix is the same failure. |
| The first question after an idle spell fails as offline; the next one works | Cold load plus the ~13K-token prefill exceeded `request_timeout_s` (`worker/config.py`), and a timeout classifies as `ai_offline`. Measured 2026-09-07 on the 48 GB M4 Max: the box prefills an **uncached** prompt at ~100 tokens/s and decodes at ~7, so the ~13K-token prefix costs ~2 minutes cold and a long thread whose prefix was evicted (the box served something else) costs ~3–4; a warm turn is 7–30 s because the prefix cache leaves only the new turn to prefill. The constant is 480 s (it bounds a hung generation; the heartbeat, not this, decides offline). Check `OLLAMA_KEEP_ALIVE=-1` and pre-warm after start; if a warm box still runs past ~5 minutes, raise the constant — not a new env knob. |
| Answers ignore the schema, invent columns, or `error_echo` failures jump | The context window is too small and the prompt was truncated from the front. `ollama ps` must show CONTEXT 32768, and the server log (`~/.ollama/logs/server.log` on macOS) must not contain `truncating input prompt`. |
| The worker exited after the Mac slept | Fixed in September 2026: a report over a dropped socket used to escape the loop. The log line is now `batch failed; the lease sweep collects what was held`, the loop continues, and the next statement reconnects. Keep the box awake with `caffeinate -s` regardless. |
| Jobs queue and never start | `select status, model, count(*) from ai_jobs group by 1,2`. A model no worker advertises stays queued until the sweep. |
| Every job times out at ~45 s | The model is being evicted between calls. Check `OLLAMA_KEEP_ALIVE=-1` and `ollama ps`. |
| An insights job fails with a SQL error | That is fed back to the model for self-correction and is often not a bug. Persistent ones: `WORKER_READONLY_DATABASE_URL`, and whether `jigged_ai_readonly` holds a grant on the table (`ai_policies_without_grant()`). |
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
