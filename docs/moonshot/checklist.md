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
  2012's men's surface, and the long finger flexors weakening as the wrist bends (O'Driscoll 1992, Bhardwaj 2011).
  Since 2026-11-04 also by angle, each reproducing its source in the test: raising the arm (Aronis 2025, 90-160
  deg) and its speed to 50 deg/s (Koski & McGill 1994), humeral rotation both ways (Ruas 2015) and wrist flexion
  (Behrens 2019) and extension (Delp 1996). Still *proposed*, each saying why in strength.json (paywalled or
  unreviewed numbers): lowering the arm, the plane of elevation, forearm rotation, wrist deviation, the trunk and the
  fingers' own joints, and every speed curve but the elbow's and raising the arm's (the elbow's mid-range decay). The
  controller caps each motor at its curve every step, and so does the vise take's physics run
  (`moonshot/sim/vise_take.py`, `StrengthCaps`).
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
  3.57 mm for one frame at the end of the 30 N push, against 3.5. Since 2026-11-04 the hand's colliders fit its
  skin (your decision): skin read 3.1-3.4 mm at any firm fingertip touch and 8 mm at a palm push, because the
  colliders sat 2-3 mm inside the pads and 10-18 mm inside the palm. Now the fingertips' pads are 0.75 mm inside, and
  the palm and the other bones are convex shells 1 mm inside (`moonshot/body/derive_hand.py`); set-parallels' skin
  went from 8.3 to 2.5 mm. Every take re-runs on it. Open: joint ranges and the per-verb physics are gates only.
- [x] Add the new checks: nothing moves without a cause; machines inside spec; shortcuts declared; grasp timing;
  hand opening; matches its footage (cards with footage only). Each registered with its good and bad takes
  (`moonshot/validate/`, `test_checks_prove_themselves.py`, 2026-11-02). On the re-planned vise take nothing moves
  without a cause. Hand opening passes on the reference since 2026-11-03 (widest at 72%, 74% and 72% of its three
  reaches, 0.81 mm wider per mm), the hand opened for the object (`motion/primitives.py` `open_for`) and pausing
  before the knob; op10 and op20 miss it by a hair (78% against 77%, 69% against 71%). Since 2026-11-04 every
  physics run records what the checks read (the step takes' `TakeRunner` too), and hand opening is timed between
  frames (your decision): at 30 fps one frame is 7% of a half-second reach, wider than the 6% band, so a reach had
  one passing frame. The band is unchanged. Declared the same day (your decisions): the step takes' carry welds as
  the `carry_*` grip assist, and the band saw's vise screw as a mechanism.
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
| C1 (VF-2, Hurco VM1, …) | [ ] VF-2: doors and Cycle Start (`test_door_cycle_take.py`), the pendant, probe and tool setter (setting session) | [x] 2026-11-02 | [ ] doors close and open, Cycle Start runs (M4, 2026-11-02); the pendant's conformance passes and is merged (setting session, 2026-11-03); the 11 setting takes (Find X and Y, Set Z, op50's square check): op40-z passes everything, the other ten all but skin on the old body, re-running on the new (2026-11-04); door-open passed every check on the old body, door-close all but the palm's skin, both re-running on the new; Load the tools: 23 of 26 passed on the old body, op10's far-fork seats split into a pick and an insert (your decision, 2026-11-04), re-running; no CI run. 2026-11-05: nist-ftc-10's setting, Load the tools, door and Cycle Start takes all pass on the new body and are published. G1: ct-slbeam's and ll-1007223's 16 setting and 48 tool takes pass; every G1 setup's door close and Cycle Start pass, re-run per setup with its own part (20 takes); the plates' setting and tool takes in progress |
| C2 (ST-25, …) | [x] ST-25's (2026-11-06, `test_st25_conformance.py`, 28 tests, and its cell's, `test_lathe_cell_conformance.py`, 6), each committed before its station | [x] 2026-11-06 | [ ] ST-25 passes locally (all 34, 2026-11-06); no CI run. From Haas's STEP (`moonshot/world/st25.py`, `lathe_cell.py`): X and Z on the 55 deg slant at 945 ipm, the 12-station BOT turret with its stations' frames, the door, the spindle, the presetter's arm (M104/M105), the pendant and a foot pedal; the Kitagawa BR10 and Royal's 5C collet chuck closed by the drawtube with their makers' stroke and grip; the control as Haas's lathe manual gives it. Cards `st25-controls`, `st25-chuck-load`, `st25-collet-load`, `st25-tool-setter`; records `collet-5c-0625`, `bot-er32`. Open for your decision: the foot's press as a control input (the body has no legs), the drawtube shown following the jaws, the presetter for touch-off, the tailstock left out |
| C3 (grinders, …) | [ ] | [ ] | [ ] |
| C4 (lasers, EDM, brake, …) | [ ] | [ ] | [ ] |
| C5 (saw, weld, braze, …) | [ ] band saw's (2026-11-02, `test_bandsaw_conformance.py`); cutting to length (`test_bandsaw_take.py`, per G1 bar part, 2026-11-05) | [x] 2026-11-04 | [ ] band saw passes locally (11 tests, 2026-11-05); no CI run. Its model, 2026-11-05: the feed cylinder meters the bow down smoothly with the valve open (it chattered and threw the bow up 4 deg), and the bow is boxed as its beam, its two ends and its guide arms, its window open as on the saw, measured on McMaster's STEP (your decision). Cutting to length for G1's bar parts, ct-slbeam and ll-1007223 (`moonshot/motion/bandsaw.py`, `moonshot/sim/bandsaw.py`, `moonshot/world/saw_cell.py`): each part's bar, its own length (3-1/4 in) against a stop block on the bed (the saw's own stop can't come nearer than 226 mm), its 4140's weight. Load (`<part>-saw`), clamp (`<part>-saw-clamp`: the jaw snug at 156 N, past the gate's 82.5; the head 12 mm off the idler guard) and start (`saw-start`: the bow comes down as the valve opens): every per-frame check passes for both parts, and all five are queued for render. The cut (`<part>-saw-cut`): 178 s, the rest still to 1 µm, the jaw at 153 N or more. Unload, two takes since 2026-11-05 (your approval): the slide (`<part>-saw-slide`), the fingers on the cut piece's top sliding it off the fixed jaw's front plate past the stop block's edge and pulling it toward you, and the lift-out (`lift-out-<part>-saw`), planned from where the slide left it: taken by its two ends, thumb against index, middle and ring, and lifted straight up (your decision: from the front the hand can't span it across its width), then set down on the saw's bed in front of the vise, its far end 140 mm from the blade, not on the bench (your decision: by the hip it was past reach; the card asks that the place be away from the blade). Both parts' slides and lift-outs pass every per-frame check, and all four are queued for render; the per-part gate passes, all 26 tests, both parts, locally (2026-11-05) |
| C6 (inspection, …) | [ ] inspection bench's (2026-11-02, `test_inspection_bench_conformance.py`) | [ ] | [ ] inspection bench passes locally (2026-11-02); the deburr take passes its gate and every per-frame check, you approved its draft (2026-11-03), and its final is on the web (2026-11-04); the pocket-depth inspect take in progress (the calipers regrasped on end), re-running with deburr on the new body; no CI run. 2026-11-05: nist-ftc-10's inspect passes and is published; the four G1 parts' deburrs pass every check (the pickup's load-up a recorded exception) and are rendered; G1's inspect steps caption and still (your decision); ct-slbeam's and ll-1007223's send-outs pass and are published |
| D. Usage cards | [ ] | [ ] | [ ] |
| E. Parts and plans | [ ] nist-ftc-10's vise loads, op10–op40 (`test_vise_take.py`) | [x] 2026-11-02 | [ ] Only people's work is rendered (your decision, 2026-11-03): the machine's own cutting is out of scope, its simulation kept only to give each later setup the part's shape. Vise takes (2026-11-03): the reference, op10 and op20 physically sound, op30 and op40 clamped since the corrections stopped steering the girdle (both still touch the lever, 65 frames on op30's run, and the pads go 5.3 mm into the part; op40's slide falls short of seating it); op50's grasp (parallels session) in progress. Lift-outs op10-op40 hold their parts; set-parallels and set-stop pass their gates (parallels session). 2026-11-04, on the new body: the vise loads re-running; set-parallels passes skin, posture and shortcuts. G1's five plans written (your decisions): nist-ftc-09, an 11 ga sheet clamped to the table, for nist-ctc-01, which fits no machine; ct-slbeam on the VF-2; ll-1005337 in two setups; the Kurt D688 named. 2026-11-05: every nist-ftc-10 vise load and lift-out passes (the grip margin a recorded exception) and is published. G1: the four parts' cutting simulations done, each finished stock within 0.1 mm of its STEP outside the faces you exempted; the bar parts' vise loads and lift-outs caption and still for Nov 6 (your decision); the plates' loads, clamps and unloads in progress |
| F. Web | [x] every nist-ftc-10 step on the page with the plan's caption (web session, 2026-11-02) | [x] 2026-11-02 | [ ] the page merged; the 15 cutting steps' stills published (2026-11-03), each with the part as the cut leaves it in 3D on a desktop (2026-11-04); deburr's final published (2026-11-04): 16 of 61 steps; since your 08:00 decisions each person's step publishes as soon as its final is rendered, and by 13:00 32 of 61 show (17 videos, by Supabase's resumable upload, and 15 cuts); the page's review changes (a Research link, a short hero, only what exists) and "Walk the shop", a guided walk of the part's route at eye height (your decisions, in the web session). 2026-11-05: all 61 of nist-ftc-10's steps on the web by 06:40; G1's first 40 steps published (ct-slbeam 20, ll-1007223 18, ll-1005337 2) |
| G. Render production | [x] `test_render_take.py`, `test_vise_render.py`, `test_step_video.py` (2026-11-02) | [x] 2026-11-02 | [ ] the ported renderer draws any take record, both hands, and joins each step's video from its takes (`moonshot/planning/takes.py`); tuned to 4.65 s per 1080p frame on the M4 (48 samples, adaptive 0.03), 47% under untuned. Drafts of 39 of nist-ftc-10's 61 steps (2026-11-03). Its 15 machine-only (cutting) steps show their caption and one still each on the page (your decision), not a video. No final renders before you've reviewed its draft. Open after Nov 5 (found by the web session's realism test): `look.py` maps the VF-2's CAD materials across the whole model, so the painted enclosure renders as bare steel (`mat_10` is the table's cast iron in one link and the enclosure's sheet in another); the per-link mapping, the door glass the CAD lacks, and the head's duplicate spindle faces are in the data root's `realism-spike` folder, then nist-ftc-10's videos re-rendered from their passing takes. 2026-11-05: nist-ftc-10's 61 finals rendered (720p, 16 samples, each take where it was made); G1 rendering on the M4 (one ordered queue), the M1 and the hub's GPU |

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
- [x] Nov 4: render queue live; `nist-ftc-10` finals. As of 2026-11-04 07:30: 16 of 61 steps on the web (the 15
  cutting stills, deburr). The other 45 are people's steps, and every take they need re-runs on the new body:
  setting (3e), Load the tools (agent), the vise loads (agent; op50, a7), doors and Cycle Start (agent), inspect
  (66), and set-parallels, set-stop, blow-off, loosen and the lift-outs (here). A step goes up once all its takes
  pass, you've reviewed its draft and its final is rendered. Your decisions at 08:00, to have it all up tonight: no
  drafts and no review wait, so a take whose checks pass renders its final at once, at 720p (31,000 frames at 1080p
  were about 27 farm-hours), and the backlog's drafts are taken as approved; the bench's props drawn as what they are;
  parked until nist-ftc-10 is up: the band saw's takes, the G1 parts' takes, CI runs of the gates and the remaining
  strength curves. The skin check runs on Embree since (`embreex`), 200x faster with the same answer, so a take's
  checks take minutes. Later the same morning (your decisions): each take renders on the machine that made it and
  only its video goes to the hub (`pipeline --local`; the queue had sent every frame back as a PNG over a link
  doing about 100 KB/s), with the M1 off the farm's renders; finals at 16 samples, denoised (39,000 frames, 26,000
  of them the setting takes); Cycle Start and the tool inserts are exempt from grasp timing and hand opening, as the
  pendant takes are (no grasp of their own; an insert's is checked in its pick); the vf2-tool-load card's proposed
  values approved as written. At 10:30 every setting take (11), every tool take (29), the doors and Cycle Start,
  deburr and inspect pass every check on the new body and are rendering; the vise loads, set-stop, blow-off,
  loosen and the lift-outs are in progress. By 12:30 set-parallels, set-stop, blow-off, loosen and all five
  lift-outs pass too, and 31 of 61 steps have their finals (the 15 cutting stills, deburr, and every setup's
  clean, start and unload steps). Your decisions: blow-off keeps the holster moved on its panel (rim at 870 mm,
  the gun turned 135 deg, handle toward the operator) and the aim 30 deg left, 50 deg down; a lift-out's set-down
  on the table isn't held to the vise's 2 mm (op20's lands 2.8 mm off). op20's vise load passes every per-frame
  check and physics outcome, its grip margin 2.48 against people's 1.7-2.2: published as a recorded exception (your
  decision); every load has over-gripped so since the colliders were fitted to the skin (the 5.5 deg base squeeze
  was tuned for capsules 2.5 mm inside the pads), to bring back into the band after Nov 5. The exception covers
  every vise load tonight (your decision, 16:30). The thumb's fingertip collider refit to its pad as it carries
  (your decision): in the carry grips its pad stood 2.1-2.5 mm outside it at the median, so carried parts read
  3.6-3.9 mm of skin; moved 2.5 mm, 1.0-1.9 at worst. By 19:30 every take nist-ftc-10's 61 steps need passes
  every check (op10's, op40's and op50's vise loads last; op30's is op40's, the same load), 48 steps have finals
  and the rest are rendering. Open after Nov 5: a reach's hand opening and its footage median can still flip by a
  frame on a fresh run, where a fingertip's graze is or isn't caught; the fix is timing the widest point from the
  planned movement. The last three finals (op10-tools, op10-xy, op40-xy) landed overnight; all 61 steps' finals
  assembled at 06:20 on Nov 5.
- [ ] **Nov 5: `nist-ftc-10` on the web; sharing starts.** On the web: all 61 steps published by 06:40 on Nov 5,
  each a 720p final. Sharing is yours.
- [ ] Nov 6: G1 (5 parts) on the web. Started 22:30 on Nov 4 alongside nist-ftc-10's last renders (your decision),
  in parallel: the four parts' cutting simulations and stills, the 11 pending tools' models (downloaded where no
  login is needed, generated otherwise: your decision), the two plate parts' table-clamp takes, the two bar parts'
  vise loads and lift-outs, their band saw takes (the saw's card changes approved as proposed: your decision),
  setting, Load the tools, deburr, inspect and send-out; the web page readied for the four parts. Your decisions on
  Nov 5:
  - The vise loads' push: its pronator quadratus overload (1.30-1.36x for about 25 frames; the 30 N press lands
    65-75 mm to the side of the wrist, against nist-ftc-10's 38) is a recorded exception on G1's loads, like the
    grip margin, to fix after Nov 6. It covers that muscle during the push only.
  - ll-1007223 op30's load and lift-out pinch the part across its 40 mm ends, not the 75 mm.
  - A plate's load starts with the plate in both hands at the doorway, carried in, and laid on the spoilboard
    (the spoilboard covers the table and the body can't walk); grasp timing and hand opening are exempt for that
    grasp, as for the tool inserts.
  - A clamp nut's thread (`clamp_thread_<i>`, the 1/2-13 lead as an exact ratio) is a declared mechanism: the nut is
    spun down by the fingertips and snugged with a wrench, and the `clamped` weld carries the bite while cutting.
  - The plate parts' tools wait on a two-row stand on a bracket bolted to the table's front edge (the spoilboard
    covers the table); a holder seats in one take where its fork isn't far, the split following the reach.
  - nist-ftc-09 stands on a 1 in riser under its spoilboard, so its 1-1/2 in miniature end mills (keyhole, lettering)
    reach the sheet; they stopped 4.6 and 2.4 mm short in Z.
  - ll-1005337's op20 finds X and Y on the reamed dowel hole at its left end, and its check probes the other hole:
    after the 10 mm slide the finished near edge is past the Y travel. Op10's straightness check runs its lever
    angled down, so nothing overlaps the plate at the travel's front.
  - ll-1005337's stock compare leaves out the dowel holes' back countersinks (cut by hand at the bench) and the
    undercut's R15 corners above the wall's foot (a vertical dovetail cutter leaves R15 narrowing to R8.1; R15 isn't
    on the drawing), each named.
    So do nist-ftc-09's 17 letter-wall faces, where the 1/32 in end mill leaves its radius (0.156 mm) in the
    letters' square inside corners, and ll-1005337's four short notch side walls, where the dovetail's 20 deg
    flank leaves a wedge (up to 0.98 mm): what a round tool leaves.
  - The plate parts' back-row tool holders, picked from under the bracket's front row, are eased in the hand
    toward the planned grip while in the air, ending within 6 deg of it (`carry_holder`'s declaration extended):
    the hand closes on them 13-20 deg off. The bracket's front row stands at y -690, 10 mm past the -680 named,
    so a hand reaching round a front holder clears the back one.
  - The band saw's lift-out slides the cut piece 65 mm off the jaw's plate past the stop block, pulls it 35 mm
    toward the operator and takes it by its ends: across its width the hand would point 90 deg off the forearm.
    It sets the piece down within reach in front of the operator, not on the bench by the right hip (14-15 deg
    of side lean and 15-22 deg of twist, past people's range); the bench stays where it is.
  - A plate's load sets it straight down, lined up over its place, and lets go: no slide on the board (a hold
    by its end faces and a slide went into the skin and overloaded the arms).
  - A plate's clamp nuts are run down and snugged with a 3/4 in wrench, in strokes (a fingertip spin turned a nut
    only 10-30 deg a stroke); a ratcheting combination wrench if the box-end's 70 deg strokes can't reach the far
    nuts (the arm runs straight or hits the near clamp);
    each end's clamps from their own stance, one take per end (the body doesn't walk), each end's own hand on
    its nuts; and each nut's stroke count learned from a first physics run, the stroke it seats on, then run
    again stopping there, as the operator's feel (your decision, Nov 6): the planned strokes run 7-13 deg each
    off, and past snug the soft thread slips rather than stalls;
    the seat, shift and unload takes land when they pass, caption and a still until then.
  - G1's vise loads: bounded retries on ll-1007223 op10 only; the others and the lift-outs show caption and a still
    for Nov 6, resuming after the timing fix (what's left are checks one frame decides, which flip with each run).
    ll-1007223 op10's 8 retries didn't pass, so it shows caption and a still too: the best run failed only skin,
    4.91 mm for 35 frames as the index's middle segment sinks into the knob on the final pull (the hand stops
    10-13 mm short and the knob's hold pulls it on), a fix for after the timing fix. The vise work to pick up
    is on its agent's branch (546f31a1, 628d57f7, 7c663177, 228cccd6), not on this one.
  - The send-outs pass as they are: the `carry_part` weld engages 0.2 s before the pinch closes (otherwise the closing
    fingers shove the part 17-23 mm), and the arm takes a carried part's weight through its own actuators.
  - nist-ftc-10's deburr re-renders after G1's deburrs, its bench calipers drawn whole (they were the bare beam).
  - G1's clean, start and unload steps don't reuse nist-ftc-10's shared takes (door close, Cycle Start, door open,
    blow-off, set-parallels, set-stop, loosen), whose scenes show its stock and parallels in the vise: each is
    re-run per G1 setup with its own part, or its plate on the spoilboard.
  - nist-ftc-09's lettering also exempts small regions, not whole faces: within the 1/32 in end mill's radius
    (0.397 mm) of each of its 10 inside corners' edges (`regions` in the stock fixture); the sheet's top reads
    0.059 mm outside them.
  - The band saw's bow collider follows the C-frame (its back and top), its window open as on the real saw,
    so the lift-out lifts the piece straight up by its sides.
  - ct-slbeam op10's and op40's clean steps show caption and a still: two parallels under its 38.1 mm part can't
    both leave the setting hand room (it needs about 17.5 mm beside each, 42 mm in all), so their spacing stays
    as its takes were made (moving them apart was tried and reverted).
  - nist-ftc-10's masked +Z side slot also exempts small regions on datum A's edges round its mouth (within its
    3 mm depth), where the uncut slot's stock ends flush: its finished-stock gate then reads 0.042 mm at worst.
    Only the fixture changed; nothing re-ran or republished.
  - A vise holding a part against a stop opens whole crank turns wider until the stop's setter has 45 mm to the
    moving jaw (ll-1007223 op30, ct-slbeam op20/op30); nist-ftc-10's openings unchanged.
  - ll-1007223 op20 keeps plain jaws in every take for now, consistent across its steps; its soft jaws (and
    nist-ftc-10 op30's) after Nov 6.
  - The band saw's clamp: the gate may take the lower jaw force the cut shows holds the bar (it snugged at 44-50 N
    against the gate's 82.5). Since met in full: both clamps snug at about 150 N, and the gate is back at 82.5.
  - The band saw's model is fixed so that opening the feed valve only lets the bow descend: the blade motor's
    reaction lifted it a few degrees first. The gate keeps its assertion that the bow comes down.
  - The G1 deburrs' tool pickup, loading in 100-133 ms against people's 163-265, is a recorded exception; each take
    passes every other check.
  - G1's four inspect steps (all but nist-ftc-10's) stay caption and still.
  - The setting takes render on the M4 as well as the M1 (the M1 alone needed about 47 h), only the video going to
    the hub.
- [ ] Nov 7: G2 (3 parts) on the web. Started 17:30 on Nov 6, in parallel with G1's last takes (your decision, sooner
  than Nov 8-9 if it can be): the three plans (ct-tpg322, ll-1011439, ll-1007224), the Haas ST-25 lathe and the
  surface grinder as stations, and turning and surface grinding in the cut simulation, each gate first. G1's steps
  shown as caption and a still get their still rendered from the setup's scene (your decision, Nov 6).
  Your G2 decisions, Nov 6: ct-tpg322 is blocked in on the surface grinder's magnetic chuck with ground steel
  keepers (C2 carbide holds at about 5% of steel); its chipbreaker is ground by hand at the handwheels, the
  shop's routing kept and the three nose regions exempted in the stock compare, as what a straight wheel leaves.
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
