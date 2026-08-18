# Vercel build cost

**As-built, verified 2026-08-18.** Written after four days of the first Pro billing cycle consumed
**$15.75 of the $20 credit, 99.6% of it Build CPU Minutes** ($15.75 of a $15.82 infrastructure
subtotal; everything else — functions, edge requests, observability — came to $0.07).

## Billing has two independent arms, and it is an OR

> "Builds on Standard build machines are only billed when on-demand concurrency is enabled **or**
> Elastic build machines are selected." — [Vercel pricing](https://vercel.com/docs/pricing)

The project had **both** on (`buildMachineSelection: "elastic"`, `elasticConcurrencyEnabled: true`),
and Elastic had assigned the 8-vCPU Enhanced machine. **Turning off one arm changes nothing.** Both
were switched off 2026-08-18 to `fixed` / `standard` / `false` via `PATCH /v9/projects/{id}`.

Price is `ceil(minutes) × vCPU × $0.0035`. Nothing had regressed — builds on Aug 12–14 ran *longer*
(~11 min). **Hobby never billed for it; Pro does.**

| Consequence of the change | |
|---|---|
| Build CPU in the first of Pro's 3 slots | unbilled |
| Slots 2–3 | still billed — concurrent builds still cost |
| Same-branch rapid pushes | collapse (Git branch queue: "queued builds for earlier commits are skipped") |
| Wall-clock | **worse** — see below |

## The build cache is a large net loss, and cannot be turned off

Measured on `chore/build-cache-ab`, two fresh commits, Standard 4-vCPU:

| Phase | cache ON | `VERCEL_FORCE_NO_BUILD_CACHE=1` |
|---|---|---|
| restore cache | 8s | skipped |
| compile + install | 165s | 154s |
| deploying outputs | 119s | 105s |
| **create + upload cache** | **544s** | **635s** |
| **total machine time** | **837s (13.9 min)** | **894s (14.9 min)** |
| cache written | 261.73 MB | 261.49 MB |

**The cache costs ~9 minutes to save ~8 seconds.** Restoring it saved 8s, and the build was *faster*
without it (154s vs 165s), so the cache does not even help the phase it exists for.

**Withdrawn:** *set `VERCEL_FORCE_NO_BUILD_CACHE=1` to skip that cost* — wrong because the flag only
skips **restoring** the cache; it is still created and uploaded, so the build gets strictly slower.
Vercel is explicit that "it is not possible to manually configure which files are cached at this
time." There is no opt-out.

**The measurement trap that produced the withdrawn claim:** the events log ends at `Creating build
cache` and the remaining ~10 minutes appear only later. Measured too early, the no-cache arm looked
69% faster. **Wait past `Build cache uploaded` before reading any total.**

## What would actually shrink the cache

> "each Vercel Function is built separately in the Build step and **has its own cache**, based on the
> Runtime used. Therefore, the number and size of Vercel functions will affect your Build time."
> — [troubleshoot-a-build](https://vercel.com/docs/deployments/troubleshoot-a-build)

This deployment builds **12 Python functions** (`meta.lambdaRuntimeStats` → `{"nodejs":3,"python":12}`)
and installs the dependency stack 11 times per build. That fan-out is the cache. Collapsing it is
the only lever that attacks the 544s — see the 2026-08-18 correction in
[database-migrations.md](database-migrations.md) for why the `functions` glob is **not** that lever,
and what is.

Cache key includes the **git branch**, so every new branch pays to build a fresh ~261 MB cache. Max
size 1 GB, retained one month.

## Measuring it correctly

Two traps, both of which cost time here:

| Trap | Correction |
|---|---|
| `ready - buildingAt` from `/v6/deployments` | Undercounts ~3× — it stops at `Deployment completed` while the machine runs on through cache creation. Use first-event → last-event on `GET /v3/deployments/{id}/events?builds=1`. |
| Reading the events log as soon as the deployment is `READY` | The cache phase lands minutes later. Poll until `Build cache uploaded` appears. |

A redeploy of an unchanged SHA is **not** a valid A/B arm: it restores nothing (`_restored: false`)
yet still writes the cache, so it isolates neither variable. Use two fresh commits.

## Open

- **Wall-clock got worse.** Pinning to Standard halved the cores, and cache creation is CPU-bound:
  the cache phase went 314s (8 vCPU) → 544s (4 vCPU), taking a build from ~7.8 min to ~13.9 min.
  Free, but slow. Reverting to Elastic restores the speed and the bill.
- **Nothing enforces any of this.** No test fails if the second billing arm is switched back on.
