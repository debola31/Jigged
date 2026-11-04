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
- [x] The farm starts itself at login (your decision, 2026-11-02, replacing manual restarts after a reboot killed
  a run): on the hub, `moonshot/tools/farm_hub.ps1` from the Windows Startup folder (`jigged-farm-hub.cmd`) starts
  the hub and its worker unless running, and the PC doesn't sleep on mains power; each Mac's worker is the login
  agent `com.jigged.farm-worker`, which restarts it if it dies and keeps the Mac awake. A rebooted machine rejoins
  once someone logs in; leased jobs lapse and go to another worker meanwhile. Workers run the committed code in
  `~/jigged-moonshot`.
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
- [x] A CI job for the fast tier, timed against the 3-minute target (§6): `Moonshot Tests` in
  `.github/workflows/test.yml`, `timeout 180`; green on 2026-11-02 at 11 s. It runs on pull requests and pushes to
  `main`, so this branch's later commits first run it at merge.

## 3b. Body model, usage cards and checks (§3–§5), before any station

- [x] The body model in MuJoCo: trunk to fingertip, 73 joints for two arms, each a motor with its range, speed,
  strength and couplings (§3.1). `moonshot/body/skeleton.py`, 2026-11-01: 59 motors, 14 coupled joints, 42.7 kg
  above the hips. The wrist's ellipse is 32 tendon limits per wrist (2026-11-02). Both arms are planned, run and
  rendered since 2026-11-02: the solver and grips (`test_body_mirror.py`, `test_two_arms.py`), the two-handed plan
  and physics run (`moonshot/motion/step_take.py`, `moonshot/sim/runner.py`, `test_step_take.py`) and the take
  record any renderer draws both hands from (`moonshot/contracts/take_record.py`). Known gaps: the scapula doesn't yet follow shoulder elevation; fingers have no recorded
  top speed; 14 of 23 strengths are *proposed* (`moonshot/body/data/strength.json`).
- [ ] Strength curves (torque by joint angle and speed) sourced from published measurements, per joint (§3.1).
  Built 2026-11-02 (`moonshot/body/data/strength.json` curves, `test_strength_curves.py`): the elbow from Frey-Law
  2012's men's surface, and the long finger flexors weakening as the wrist bends (O'Driscoll 1992, Bhardwaj 2011);
  every other hinge has no angle curve and the elbow's mid-range speed decay, *proposed*. The controller caps each
  motor at its curve every step; the vise take's physics run (`moonshot/sim/vise_take.py`) doesn't call it yet:
  handed to the body-model session with the checks' other hooks (2026-11-03, the body-checks session done).
- [x] Two-joint muscle couplings: wrist bend moves the fingers (§3.1). A spring across the wrist and each finger's
  MCP and PIP: at full wrist extension a relaxed hand flexes them 35 and 50 deg (Neumann 2009), effort overrides
  it (`test_tenodesis.py`, 2026-11-02). Proposed: straight fingers at full flexion, the spring's stiffness.
- [x] MyoSuite muscle check running on the farm: every take replayed, muscle activations reported (§3.1, §5.1).
  Built 2026-11-02 (`moonshot/validate/muscle.py`, registered as `muscle_activation`): MyoArm posed by the run's
  angles, least-effort activations for the torque the motion and the hand's load need. Since 2026-11-03 every
  take's physics run records the load on the hand (`checks.json` `hand_wrench`: the vise take's, the bench's and
  the pendant's), so every take's per-frame checks replay it; the deburr take peaks at 0.85.
- [ ] Body conformance tests pass: range, speed, strength, strength curves, couplings, muscle check agrees,
  proportions, gravity (§3.1). Range, speed, strength, couplings, proportions, gravity and left-right mirroring
  pass (`moonshot/tests/gates/test_body_conformance.py`, 2026-11-01), as do the wrist's ellipse
  (`test_wrist_ellipse.py`) and the left arm as the right mirrored under any trunk (`test_body_mirror.py`,
  2026-11-02). Since 2026-11-02 strength curves (`test_strength_curves.py`), the wrist moving the fingers
  (`test_tenodesis.py`) and the muscle check agreeing (`test_muscle_check.py`: easy motions and 5 kg held out
  pass, 25 kg held out and a 0.1 s elbow flexion fail) pass too. Open: the scapula following shoulder elevation.
- [ ] Watch the deformable-pad trigger: count grip assists and grip complaints per station (§3.1). Only if it
  fires: MuJoCo deformable fingertip and palm pads.
- [ ] Record conformance tests for every machine and tool as it lands (§3.2). So far (2026-11-01): the VF-2
  station (`test_vf2_conformance.py`) and the VF-2 cell, with the vise riding the table at the loading position
  (`test_cell_conformance.py`); the generated tools pass their record tests. 2026-11-02: the band saw
  (`test_bandsaw_conformance.py`, 11 tests) and the inspection bench (`test_inspection_bench_conformance.py`, 5),
  each gate committed before its station, merged 2026-11-02; both pass locally, no CI run yet.
- [ ] The usage-card format (§4), with the first cards for the G1 tools: band saw, VMC controls, calipers,
  micrometer, indicator. The format is done (2026-11-01, `moonshot/cards/card.schema.json`), with the card behind
  the reference take (`kurt-vise-load-and-clamp`). The G1 cards are written and pass `test_cards.py`
  (2026-11-02, merged): `bandsaw-cut-to-length`, `vf2-controls`, `vf2-tool-setter`,
  `caliper-measure-bore`, `micrometer-measure-thickness`, `dti-sweep-face`. Their 67 proposed values (each phase
  tags them `[proposed: …]`, with the reason in the card's notes) approved as written (your decision, 2026-11-03);
  the tags stay as their record. Open: the physics tier, before a card counts as done (§6).
- [x] For each G1 card: the maker's instructions found; YouTube or research-dataset footage found, downloaded to
  `C:\jigged-data\footage\` and hand-tracked (bonus, not required; videos never committed or published).
  2026-11-02: maker's instructions cited in every card; the band saw's are JET's HBS-916 manual, as McMaster names
  no maker for 8962N13. Footage for each G1 tool (Haas, Mitutoyo and Dake's own videos, and a machinist's caliper
  video), downloaded through downr.org and tracked with MediaPipe 1.2.0 (in the hub's `jigged` env; it changed no
  existing package) by trainual's two scripts, the segmenting limited to the shots where hands work the tool.
  Measurements in `moonshot/cards/footage/`. The videos are edited tutorials, so they gave grasps and practice more
  than durations: the jog handle's grasp, the paper's pinch, the two-handed micrometer and its 6 s cleaning, the
  4.5 s bar slide. Gaps: no footage of the OTS tool setter, and the caliper video measures a 6 in bore, not a
  small one.
- [x] Claude's look rubric (§5.3) calibrated against your judgement on the first station: you approved the vise
  take's third draft (the VF-2, wrist capped at 0.75 of its range) on 2026-11-02

- [ ] Port trainual's checks (joint ranges, wrist ellipse, body vs. people, skin penetration, per-verb physics) into
  the production checks that run on every frame (§5.1–5.2). 2026-11-02: the wrist ellipse, skin penetration
  (measured on NIMBLE's skin from the physics run, agreeing with the bake) and the lever are per-frame checks that
  `moonshot/validate/take.py` runs before a render, and the re-planned vise take passes all three (the skin at
  3.45 mm against the pads' 3.5 mm, decided 2026-11-02). Body vs. people is per-frame since 2026-11-02
  (`moonshot/validate/posture.py`), reproducing trainual's report on its reference take (`test_posture_port.py`);
  the re-planned vise take fails it: 53% of frames inside people's range against 95%, likelihood median 25.6
  against 25, and so does every vise take since (2026-11-03: op20 passes the likelihood, not the range). Your
  decision (2026-11-03): posture gates against a standing-work range, from standing-work data if a dataset has it,
  otherwise the seated range widened with a written reason for your review. The seated range's misses are more
  than the trunk: freed, the takes still sit 64-73% inside, the arm hanging at the side (shoulder elevation 14 deg
  against the seated 22), turned out cranking (+50 deg against 13.5) and the wrist back pushing (+40 against 20).
  Done the same day from data: the AnDy dataset (Maurice et al. 2019, CC BY 4.0, which allows this use with
  credit), 13 people standing at industry-like manual work, 512,480 frames (`moonshot/validate/standing_prior.py`),
  and the planner plans with it too. Held to the other people, people themselves sit a median 82.9% inside (5th
  percentile 50.3%: nobody meets the proposed 95%), so the bar is their median, 0.83, your decision; the likelihood
  limit, people's own 95th percentile, 24.2. The vise takes, on today's plans: 51-65% inside, likelihood 34-38,
  posture like seated work (the elbow bent 70 deg at the median against people's 20, the trunk turned 12 deg). AnDy's
  people never hold a part up close, grasp palm down or crank, so posture is held to people seated or standing
  together (your decision; `moonshot/validate/people_prior.py`, GRAB/ARCTIC and AnDy evenly, 694 trials): range 0.93
  (people's median), likelihood 28.7 (their 95th percentile). The vise operator stands 120 mm further back and holds
  the part 80 mm lower to look at it; the planner's prior weight stays 0.3 (at 5 the bench takes' hands missed their
  targets and their caliper and deburr gates failed). op10 and op20 on it: likelihood 25.6 and 24.9, pass; in range
  92.8% and 92.9%, shoulder rotation the only joint out; but the new stance presses the fingers into the crank's knob
  (skin 7.3-7.6 mm), with the vise-timing agent. Which checks a take is held to, your
  decision: the pendant takes are exempt from grasp timing, hand opening and footage (no reach to lift a part),
  not from nothing moving without a cause; a take at a station with no machine passes machines inside spec.
  Since the body-checks merge every check runs before a render, so no vise take
  renders on its own; their review drafts render regardless (`pipeline --render-only`). The reference's skin is
  3.57 mm for one frame at the end of the 30 N push, against 3.5. Open: joint ranges and the per-verb physics are
  gates only.
- [x] Add the new checks: nothing moves without a cause; machines inside spec; shortcuts declared; grasp timing;
  hand opening; matches its footage (cards with footage only). Each registered with its good and bad takes
  (`moonshot/validate/`, `test_checks_prove_themselves.py`, 2026-11-02). On the re-planned vise take nothing moves
  without a cause. Hand opening passes on the reference since 2026-11-03 (widest at 72%, 74% and 72% of its three
  reaches, 0.81 mm wider per mm), the hand opened for the object (`motion/primitives.py` `open_for`) and pausing
  before the knob; op10 and op20 miss it by a hair (78% against 77%, 69% against 71%). The other four have nothing
  to read, which fails them, until the physics run records machine axes, active constraints and applied forces,
  and the lifting force, and `take.json` names its card: being added (2026-11-03, handed over from the body-checks
  session).
- [x] The new core reproduces the reference take's per-verb outcomes (`C:\jigged-data\reference\setup-take\`).
  Done 2026-11-02, on the take the ported planner (`moonshot/motion/`) writes, since trainual's stopped being the bar
  on review (`docs/moonshot/physics.md`): in the VF-2 cell, lifted by friction with a 13.0 / 14.0 N grip, 1.76 mm
  slip, set down within 1.53 mm and flat, seated on the fixed jaw, pushed at 29.9 N, cranked 2.259 turns to 75.75 mm
  and clamped at 4,759 N, both parallels found pinched (after a run where para_b crept 0.7-1.0 mm under the
  fingertip, held at 0.02-0.07 mm since noslip_iterations went 2 to 10, 2026-11-03); the body alone follows the plan
  with no motor at full
  strength (`test_vise_take.py`, `test_reference_take.py`, physics tier). Open elsewhere: free-motion wrist lag,
  39 mm against 10 mm, which belongs to the planner: near-misses
  (`stray_contacts`), no arm volume in planning, and the held blank's inertia not fed forward, which trips a latent
  launch of the blank on the parallels during cranking.
- [x] Counterfactuals: half friction drops the part; no crank leaves the vise open; an open door refuses the cycle.
  `test_counterfactuals.py`, 2026-11-02: each alters the model or plan in the test; the open door in the fast tier,
  the other two on the hub's vise take (physics tier).
- [x] Timestep halving converges. Gate `test_timestep.py` (2026-11-02): the grab, place, slide, push, crank and
  finger depth agree at 0.5 ms; the parallels didn't: para_b moved 1.07 mm under the 3 N check at 1 ms and 0.11 mm
  at 0.5 ms. Noslip at 10 iterations (2026-11-03) holds it at 0.07 mm at 1 ms, and the gate passes (6 of 6,
  2026-11-03).
- [ ] The six known gaps in §5.5, on the re-planned vise take (2026-11-02). Fixed: the wrist's ellipse (0.80 at
  most), the crank grip (the lever never touched), the skin (3.45 mm, within the pads' 3.5), finger spread (0.11
  deg past range at worst, inside the 1 deg tolerance). Open: shoulder rotation at 151.5 deg/s against 150, and
  trunk rotation past recorded people's 99th percentile (13.3 deg) in 435 of 955 frames, up to 23.9 deg; trainual's
  take, 359 (`posture_like_people`, 2026-11-02). A standing-work range may be the fix (§11).

## 4. Job queue (timeboxed Nov 1–2)

- [x] Queue on the hub: SQLite, HTTP API, leases, content-addressed inputs, token auth (2026-11-01)
- [x] Workers on all three machines: `hub-gtx1070` (CUDA, GPU only), `m1-pro`, `m4-max` (Metal). Since
  2026-11-02 they run the production jobs too, so the farm's work shows on the dashboard: each Mac has a CPU worker
  (`m1-pro-cpu`, `m4-max-cpu`: `vise_take`, the skin bakes) beside its GPU worker, and every GPU takes frame ranges
  of one take at once (`render_frames`, and the ported renderer's `take_render`), joined on the hub
  (`encode_frames`); a take renders only once its checks pass (`moonshot/orchestrate/jobs.py`, `pipeline.py`); and
  they start themselves at login (§1). 2026-11-03: the hub has a CPU worker too (`hub-cpu`: the encodes and the
  takes' bakes, which waited behind the GPU's ranges and the Macs' vise takes; `farm_hub.ps1`), and a vise-take
  worker started by hand for the night (`hub-vise`); each worker has its own outbox, after the hub's GPU worker
  crashed on a result its neighbour had sent and was down five hours. Queued finals run behind drafts (priority
  200).
- [x] Tests: lease expiry, reassignment, worker killed mid-job, hub restart, dropped network; plus a live hub
  restart with jobs intact
- [x] Dashboard at http://desktop-4hvjqis:8765/: workers, queue by group, failures, recent results
- [x] Dashboard: render hours against forecast, cloud credit and drafts awaiting review (track G). Measured
  2026-11-02 at draft size (960x540, 32 samples), the ported renderer: GTX 1070 and M1 Pro about 7 s a frame each,
  with the range's start included. Its Production panel since 2026-11-03 (`moonshot/orchestrate/dashboard.py`): on
  its first morning, 11.1 h of drafts and 6.1 h of finals rendered, 1,446 of the forecast's 145,000 final frames, the
  rest 603 machine-hours at the finals' rate (about 4.5 days on all three machines rendering without a break), and
  41 drafts awaiting review.
- [x] Live on the farm (2026-11-01): 9 jobs across all three machines, no failures; a real hub restart with jobs
  intact; the scene pack fetched by hash and verified on each worker
- [x] **Keep our own queue** rather than switching to Flamenco (§8), on the tests and the live run (2026-11-01)

## 5. Tracks: checks first, then the work

For each track, I write its data formats, checks and bad takes **before** its agent starts (§6, rule 1).

| Track | Gates written | Agent started | Done (link to green run) |
|---|---|---|---|
| A. Core | [ ] | [ ] | [ ] |
| B. Catalogue | [ ] | [ ] | [ ] |
| C1 (VF-2, Hurco VM1, …) | [ ] VF-2: doors and Cycle Start (`test_door_cycle_take.py`), the pendant, probe and tool setter (setting session) | [x] 2026-11-02 | [ ] doors close and open, Cycle Start runs (M4, 2026-11-02); the pendant's conformance passes and is merged (setting session, 2026-11-03); the 11 setting takes (Find X and Y, Set Z, op50's square check) re-planned on the posture changes and in their per-frame checks, op30-z and op50-check passing all but skin (2026-11-03); doors going fully open with the grip you confirmed, and Load the tools' 26 takes (every tool in full), in progress; no CI run |
| C2 (ST-25, …) | [ ] | [ ] | [ ] |
| C3 (grinders, …) | [ ] | [ ] | [ ] |
| C4 (lasers, EDM, brake, …) | [ ] | [ ] | [ ] |
| C5 (saw, weld, braze, …) | [ ] band saw's (2026-11-02, `test_bandsaw_conformance.py`) | [ ] | [ ] band saw passes locally (2026-11-02); no CI run |
| C6 (inspection, …) | [ ] inspection bench's (2026-11-02, `test_inspection_bench_conformance.py`) | [ ] | [ ] inspection bench passes locally (2026-11-02); the deburr take passes its gate and every per-frame check, and you approved its draft (2026-11-03); the pocket-depth inspect take in progress, the left hand fetching the calipers (your decision); no CI run |
| D. Usage cards | [ ] | [ ] | [ ] |
| E. Parts and plans | [ ] nist-ftc-10's vise loads, op10–op40 (`test_vise_take.py`) | [x] 2026-11-02 | [ ] Only people's work is rendered (your decision, 2026-11-03): the machine's own cutting is out of scope, its simulation kept only to give each later setup the part's shape. Vise takes (2026-11-03): the reference, op10 and op20 physically sound, op30 and op40 clamped since the corrections stopped steering the girdle (both still touch the lever, 65 frames on op30's run, and the pads go 5.3 mm into the part; op40's slide falls short of seating it); op50's grasp (parallels session) in progress. Lift-outs op10-op40 hold their parts; set-parallels and set-stop pass their gates (parallels session) |
| F. Web | [x] every nist-ftc-10 step on the page with the plan's caption (web session, 2026-11-02) | [x] 2026-11-02 | [ ] the page merged; the 15 cutting steps' stills published (2026-11-03); each person's step publishes once you've reviewed its draft and its final is rendered, deburr first |
| G. Render production | [x] `test_render_take.py`, `test_vise_render.py`, `test_step_video.py` (2026-11-02) | [x] 2026-11-02 | [ ] the ported renderer draws any take record, both hands, and joins each step's video from its takes (`moonshot/planning/takes.py`); tuned to 4.65 s per 1080p frame on the M4 (48 samples, adaptive 0.03), 47% under untuned. Drafts of 39 of nist-ftc-10's 61 steps (2026-11-03). Its 15 machine-only (cutting) steps show their caption and one still each on the page (your decision), not a video. No final renders before you've reviewed its draft |

## 6. Milestones

- [x] Nov 1: vise compiles in the new core; benchmark sets the forecast (§1 above)
- [x] Nov 2: queue reliable (§4); vise take reproduced in the new core, every check passing (§3b, 2026-11-02)
- [ ] Nov 3: VF-2, band saw, inspection bench conformant; `nist-ftc-10` drafts reviewed by you. As of 2026-11-03
  01:00: drafts of 8 of its 61 steps (each setup's door and Cycle Start step, op10's load, seat and check) in
  `C:\jigged-data\takes\nist-ftc-10-<step>\draft.mp4`; as of 02:30, 20 of 61 with the cutting takes' drafts in,
  the last few still rendering; the rest wait on their takes (`python -m moonshot.planning.takes nist-ftc-10` lists
  them). The plan is 61 steps since op60 was found to cut nothing. Passing their outcomes, with drafts: the blow-off
  (the vise blown 2.7 s, the gun back in its holster within 1.9 mm) and loosen (0.99 turns, 6.28 mm); the door
  takes' finals are done and the cutting takes' finals rendering; the deburr take (inspection session) has a draft
  rendering. The vise take on tonight's code (552ceb67), the hand squaring the part up and following it by eye: the
  reference, op10 and op20 are physically sound (set down within 1.4, 1.5 and 1.9 mm; slip 2.0, 1.7, 2.8 mm; both
  parallels pinched; 4,778-5,032 N), and their per-frame checks pass but for posture and, by a hair, hand opening
  (op10's part widest at 77.8% against 77%; op20's last knob reach at 69% against 71%) or skin (the reference's
  pads 3.57 mm deep for one frame at the end of the 30 N push, against 3.5). Their drafts render for your review
  regardless (`--render-only`), as does the op40 lift-out's (posture only). Set-parallels, set-stop and op50's
  grasp: the parallels session; parallel a now stands 19 mm from the fixed jaw (was 13.2), where the fingers that
  set it fit. Open: op30/op40's tall part arrives over the vise about 25 mm off and lands on a jaw (the arm at full
  reach); op50's, standing on end, is knocked over by the reach; op10's lift-out puts the thumb on the part's top;
  op50's check (an indicator swept up its side) is the setting session's. Your decisions (2026-11-03): posture
  gates against a standing-work range (§3b); the G1 cards' proposed values approved; the AngLock's push on the
  moving jaw declared a vise mechanism; the stock's three plan gaps (the +Z side slot 2.64 mm, the boss's V flanks
  2.31 mm, the pad grooves 1.50 mm) masked with their reason, not given a tool. The bench's carry welds
  declared a grip assist; Load the tools shows every tool loaded in full. Within the unload step the doors jump from door-open's 300
  mm to the 600 the blow-off and the lift-out need.
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
- [ ] A worker image with the pinned Blender and the queue worker: written (`moonshot/tools/cloud/`), not built
- [ ] A reusable ephemeral Tailscale auth key

Only when triggered, and only with your approval:
- [ ] Provider account, **$50 prepaid, no auto-top-up**

## 8. Review log (§5.4: rejections become checks)

Each draft you reject gets a row, and the row closes only when its conversion lands.

| Date | Part / step | What was wrong | Converted to (monitor, scenario, or "eye only") |
|---|---|---|---|
| 2026-11-01 | Vise take draft | The wrist past its ellipse at 4 s; the crank gripped round the lever's joint, which turns through the fist | Checks `wrist_ellipse` and `never_held_parts` (`moonshot/validate/`), gate `test_wrist_ellipse.py`; closed 2026-11-02 |
| 2026-11-02 | Vise take draft 2 | After the pick-up the wrist reads as bent too far: 0.94 of its range for 2 s while the part is inspected, possible but not how people hold a part | The planner's wrist cap, 0.95 to 0.75 (`moonshot/motion/solver.py`), approved on draft 3 (2026-11-02); the body-vs-people check (§3b) to catch untypical postures |
