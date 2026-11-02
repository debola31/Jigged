# Moonshot showcase: checklist

Tick items as they land, with the date. The *why* behind every item is in
[shop-and-pipeline-plan.md](shop-and-pipeline-plan.md); section numbers below point there.

A build item is ticked only with a link to the green run or PR that proves it, not on an agent's report (§6,
rule 4).

## 1. Farm setup

Machines, as of 2026-11-01:

| Machine | Tailscale name | Mac user |
|---|---|---|
| Windows PC (hub) | `desktop-4hvjqis` | — |
| M1 Pro | `adebolas-macbook-pro-1` | `adebolaakeredolu` |
| M4 Max | `adebolas-macbook-pro-2` | `adebolaakeredolu` |

`adebolas-macbook-pro` (no suffix) is an older, offline machine and not part of the farm.

**You:**
- [x] Tailscale on all three, same tailnet (2026-11-01)
- [x] Hub: OpenSSH Server installed, `sshd` running and set to Automatic (2026-11-01). Needs an **Administrator**
  PowerShell window, not the VS Code terminal.
- [x] Both Macs: System Settings → General → Sharing → Remote Login on (2026-11-01)
- [x] The hub's key in both Macs' `~/.ssh/authorized_keys`; the hub logs in to both without a password (2026-11-01)
- [x] M1 Pro: `sudo pmset -a sleep 0` and `sudo pmset -a disablesleep 1` (2026-11-01). **Not on the M4 Max**:
  lid-closed sleep is what keeps it from overheating in a bag.
- [x] Hub: Settings → System → Power → "When plugged in, put my device to sleep": **Never** (verified 2026-11-01)
- [x] Hub: Windows Update paused until Dec 6, active hours 06:00–00:00 (verified 2026-11-01)
- [ ] Optional: let a laptop SSH into the hub without a password. Paste its `~/.ssh/id_ed25519.pub` line into
  `C:\ProgramData\ssh\administrators_authorized_keys`, then in an Administrator window run
  `icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`
- [x] **Sign off the strategy doc** (2026-11-01)

**Me** (after sign-off):
- [x] Both Macs checked: macOS 26.6.2, Blender 5.2.3 LTS (2026-11-01)
- [x] Blender 5.2.3 LTS on the hub, matching the Macs: portable build at `C:\blender\blender-5.2.3-windows-x64`,
  checksum verified (2026-11-01). The older 5.2.2 install is left in place.
- [x] `moonshot/requirements.txt` installed in the `jigged` env on all three (2026-11-01): Python 3.12 (hub
  3.12.13, M1 Pro 3.12.16, M4 Max 3.12.12), MuJoCo 3.17.0, numpy 2.5.4, cadquery 2.8.0, MyoSuite 3.0.0. The M1
  Pro's env was a fresh 3.14 with only pip, so it was switched to 3.12 in place.
- [x] No automatic restart after a reboot (your decision, 2026-11-01): the hub and workers run as plain background
  processes. If a machine reboots, its worker (or the hub) is started again by hand; leased jobs simply lapse and
  go to another worker meanwhile.
- [x] Benchmark (2026-11-01): one 1080p frame of the vise take (frame 480, 96 samples, untuned) on each machine,
  through the queue. Warm: **M4 Max 7.96 s, M1 Pro 39.65 s (0.20×), GTX 1070 42.43 s (0.19×)**. The M1 Pro's first
  run took 134 s compiling its Metal kernels; the M4 Max's had been compiled already.
- [x] First forecast: 145,000 frames × 7.96 s ≈ **321 M4 Max-hours** untuned, against about **255** of farm time
  Nov 4–11 (farm ≈ 1.34×), so about 20% short. Cycles tuning (lever 1, 30–40%) closes it alone; if tuning gets
  under 20%, the cloud reserve is needed (§8).
- [x] Home upload: **0.5–0.8 MB/s** (4–6.5 Mbit/s); download about 28 MB/s. A 67 MB scene pack takes 1.5–2.5 min to
  reach a rented GPU: fine when each lease is a whole step, but cloud packs should be staged in the provider's storage
  once, not streamed per job.

## 2. Data root (`C:\jigged-data`)

- [x] Hand model copied from the M4 Max: `hand-model\nimble\` (4 files) and `hand-model\work\mano_*.npz`, SHA-256
  checksums matching the source (2026-11-01)
- [x] Arm posture file copied: `arm-prior\arm_prior.npz` and `grab-mouse-lift.json` (2026-11-01)
- [x] From the M4 Max copy in `~\Downloads\trainual` (same commit as `C:\trainual`; it adds only git-ignored files),
  copied 2026-11-01:
  - `reference\setup-take\` and `reference\showcase-physics\`: the accepted takes' simulation, bake, scene and
    validation reports, the baseline the new core must reproduce;
  - `reference\*.mp4`, the penetration reports and frame files;
  - `cc0\`: the CC0 textures and HDRI;
  - `originals\hand_tools\mallet\`: the only CAD original not already on the hub.

  Its ~4.9 GB of rendered PNG frames weren't copied. Nothing needs them.
- [x] Vendor originals copied to `originals\` from `C:\trainual\assets\*\*\source\` (76 folders, 1.7 GB; 2026-11-01)
- [x] All 20 parts' files copied to `parts\` (2026-11-01)
- [x] GLBs and previews copied to `library\` (155 files, 105 MB); records, anatomy data and grasp timing
  committed under `moonshot/` (2026-11-01)
- [x] The vise take frozen at frame 480 as a self-contained scene pack, `packs\vise-bench.blend` (67 MB)
- [x] Backup: there is no external drive, so the second copy is `C:\trainual` (kept, never deleted) plus the print
  package in `~\Downloads`. **Both copies are on the same disk**: this guards against deleting a file, not
  against the disk failing. A copy on the M1 Pro would cover that, if you want it.
- [x] The old trainual copies stay (your decision, 2026-11-01).

Not needed, so not copied: the raw GRAB, ARCTIC and MANO downloads (they stay on the M4 Max), trainual's web build,
`node_modules`, virtual environments and its old `.env`.

## 3. Code skeleton in Jigged (day 1)

- [x] Branch `feature/moonshot-foundation`, PR [#879](https://github.com/debola31/Jigged/pull/879)
- [x] `moonshot/` with its layered packages; import-linter enforces that stages import only downward
- [x] Fences: `/moonshot` in `.vercelignore`, `moonshot/**` in `vercel.json` `excludeFiles` (now 253 of 256)
- [x] `moonshot/` added to the doc-link check's path prefixes
- [x] `moonshot/thresholds.toml`: every value in §3 and §5, with its source and reason
- [x] `moonshot/tools/bar_check.py`, run in CI: a PR may change the bar or the code, not both
- [x] The check registry refuses a check without a good and a bad take, and the gate test runs them all. First
  check: skin penetration, proved against the reference take's 1,275 frames and two bad takes.
- [ ] A CI job for the fast tier, timed against the 3-minute target (§6)

## 3b. Body model, usage cards and checks (§3–§5), before any station

- [x] The body model in MuJoCo: trunk to fingertip, 73 joints for two arms, each a motor with its range, speed,
  strength and couplings (§3.1). `moonshot/body/skeleton.py`, 2026-11-01: 59 motors, 14 coupled joints, 42.7 kg
  above the hips. Known gaps: the wrist's limit is a box, with its ellipse left to the §5.2 check; the scapula
  doesn't yet follow shoulder elevation; fingers have no recorded top speed; 14 of 23 strengths are *proposed*
  (`moonshot/body/data/strength.json`).
- [ ] Strength curves (torque by joint angle and speed) sourced from published measurements, per joint (§3.1)
- [ ] Two-joint muscle couplings: wrist bend moves the fingers (§3.1)
- [ ] MyoSuite muscle check running on the farm: every take replayed, muscle activations reported (§3.1, §5.1)
- [ ] Body conformance tests pass: range, speed, strength, strength curves, couplings, muscle check agrees,
  proportions, gravity (§3.1). Range, speed, strength, couplings, proportions, gravity and left-right mirroring
  pass (`moonshot/tests/gates/test_body_conformance.py`, 2026-11-01); strength curves and the muscle check wait on
  their own items.
- [ ] Watch the deformable-pad trigger: count grip assists and grip complaints per station (§3.1). Only if it
  fires: MuJoCo deformable fingertip and palm pads.
- [ ] Record conformance tests for every machine and tool as it lands (§3.2). So far (2026-11-01): the VF-2
  station (`test_vf2_conformance.py`) and the VF-2 cell, with the vise riding the table at the loading position
  (`test_cell_conformance.py`); the generated tools pass their record tests.
- [ ] The usage-card format (§4), with the first cards for the G1 tools: band saw, VMC controls, calipers,
  micrometer, indicator. The format is done (2026-11-01, `moonshot/cards/card.schema.json`), with the card behind
  the reference take (`kurt-vise-load-and-clamp`); the G1 cards aren't written yet.
- [ ] For each G1 card: the maker's instructions found; YouTube or research-dataset footage found, downloaded to
  `C:\jigged-data\footage\` and hand-tracked (bonus, not required; videos never committed or published)
- [ ] Claude's look rubric (§5.3) calibrated against your judgement on the first station

- [ ] Port trainual's checks (joint ranges, wrist ellipse, body vs. people, skin penetration, per-verb physics) into
  the production checks that run on every frame (§5.1–5.2)
- [ ] Add the new checks: nothing moves without a cause; machines inside spec; shortcuts declared; grasp timing;
  hand opening; matches its footage (cards with footage only)
- [ ] The new core reproduces the reference take's per-verb outcomes (`C:\jigged-data\reference\setup-take\`).
  Stage 1 done (2026-11-01): at trainual's angles the body puts the elbow exactly and the wrist within 1.2 mm where
  trainual did; driven through the whole 31.8 s take with gravity, it keeps the wrist within 0.1 mm of plan with no
  motor at full strength (`moonshot/tests/gates/test_reference_take.py`, physics tier). Stage 2 (2026-11-01): with
  the vise, blank and parallels, every verb reproduces on the full body (`moonshot/sim/vise_take.py`, gates in
  `moonshot/tests/gates/test_vise_take.py`): lifted by friction with a 12.7 / 13.1 N grip, 1.85 mm slip, set down
  within 0.7 mm and flat, seated on the fixed jaw, pushed at 30.0 N, cranked 2.256 turns to 75.76 mm, both parallels
  found pinched. Still failing: free-motion wrist lag reaches 37 mm against 10 mm, for reasons that belong to the
  new motion planner rather than the body: trainual's plan has near-misses (2.9 s of fingers grazing the table, jaws
  and knob, reported as `stray_contacts`), it was planned without the arm's volume, and the held blank's inertia
  isn't fed forward. Feeding the inertia forward trips a latent instability: the blank, resting on the parallels
  against the fixed jaw, can be launched by a contact-solver spike during cranking. The take now runs inside the
  VF-2 cell and all its gates still pass. Trainual's planner is ported (`moonshot/motion/`) and regenerates the take
  (`test_planner_port.py`): exactly from trainual's grips, and with re-solved grips within 5% of their cost.
- [ ] Counterfactuals: half friction drops the part; no crank leaves the vise open; an open door refuses the cycle
- [ ] Timestep halving converges
- [ ] The four known gaps in §5.5: three fixed by the new body model; trunk rotation given a standing-work range (§11)

## 4. Job queue (timeboxed Nov 1–2)

- [x] Queue on the hub: SQLite, HTTP API, leases, content-addressed inputs, token auth (2026-11-01)
- [x] Workers on all three machines: `hub-gtx1070` (CUDA, GPU only), `m1-pro`, `m4-max` (Metal)
- [x] Tests: lease expiry, reassignment, worker killed mid-job, hub restart, dropped network; plus a live hub
  restart with jobs intact
- [x] Dashboard at http://desktop-4hvjqis:8765/: workers, queue by group, failures, recent results
- [ ] Dashboard: render hours against forecast, cloud credit and drafts awaiting review, once render jobs report
  frame times (track G)
- [x] Live on the farm (2026-11-01): 9 jobs across all three machines, no failures; a real hub restart with jobs
  intact; the scene pack fetched by hash and verified on each worker
- [x] **Keep our own queue** rather than switching to Flamenco (§8), on the tests and the live run (2026-11-01)

## 5. Tracks: checks first, then the work

For each track, I write its data formats, checks and bad takes **before** its agent starts (§6, rule 1).

| Track | Gates written | Agent started | Done (link to green run) |
|---|---|---|---|
| A. Core | [ ] | [ ] | [ ] |
| B. Catalogue | [ ] | [ ] | [ ] |
| C1 (VF-2, Hurco VM1, …) | [ ] | [ ] | [ ] |
| C2 (ST-25, …) | [ ] | [ ] | [ ] |
| C3 (grinders, …) | [ ] | [ ] | [ ] |
| C4 (lasers, EDM, brake, …) | [ ] | [ ] | [ ] |
| C5 (saw, weld, braze, …) | [ ] | [ ] | [ ] |
| C6 (inspection, …) | [ ] | [ ] | [ ] |
| D. Usage cards | [ ] | [ ] | [ ] |
| E. Parts and plans | [ ] | [ ] | [ ] |
| F. Web | [ ] | [ ] | [ ] |
| G. Render production | [ ] | [ ] | [ ] |

## 6. Milestones

- [ ] Nov 1: vise compiles in the new core; benchmark sets the forecast
- [ ] Nov 2: queue reliable; vise take reproduced in the new core
- [ ] Nov 3: VF-2, band saw, inspection bench conformant; `nist-ftc-10` drafts reviewed by you
- [ ] Nov 4: render queue live; `nist-ftc-10` finals
- [ ] **Nov 5: `nist-ftc-10` on the web; sharing starts**
- [ ] Nov 6: G1 (5 parts) on the web
- [ ] Nov 7: G2 (3 parts) on the web
- [ ] Nov 9: G3 (5 parts) on the web; all 36 stations conformant
- [ ] Nov 10: G4 (5 parts) on the web
- [ ] Nov 11: G5; all 20 parts on the web
- [ ] Nov 13: sharing and final fixes done

## 7. Cloud reserve (only if the forecast slips past Nov 11)

Prepare before Nov 4, so it's ready in minutes:
- [ ] A worker image with the pinned Blender and the queue worker
- [ ] A reusable ephemeral Tailscale auth key

Only when triggered, and only with your approval:
- [ ] Provider account, **$50 prepaid, no auto-top-up**

## 8. Review log (§5.4: rejections become checks)

Each draft you reject gets a row, and the row closes only when its conversion lands.

| Date | Part / step | What was wrong | Converted to (monitor, scenario, or "eye only") |
|---|---|---|---|
