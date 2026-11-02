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
- [ ] Hub: Settings → System → Power → "When plugged in, put my device to sleep": **Never**
- [ ] Hub: Windows Update → **Pause updates** until Nov 14, and set active hours to cover the day
- [ ] Optional: let a laptop SSH into the hub without a password. Paste its `~/.ssh/id_ed25519.pub` line into
  `C:\ProgramData\ssh\administrators_authorized_keys`, then in an Administrator window run
  `icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`
- [ ] **Sign off the strategy doc**, §3–§5 (body model, usage cards, checks) especially. Its §11 questions are decided.

**Me** (after sign-off):
- [x] Both Macs checked: macOS 26.6.2, Blender 5.2.3 LTS (2026-11-01)
- [ ] Blender 5.2.3 LTS on the hub, matching the Macs
- [ ] Miniforge and the `jigged` conda env with the pipeline's dependencies on both Macs (neither has conda); the
  pipeline's dependencies added to the hub's `jigged` env
- [ ] The hub process starts at logon as a scheduled task
- [ ] Benchmark: one 1080p frame of the vise take on each machine → render settings and the first forecast (§8)
- [ ] Measure home upload speed (§8, cloud reserve)

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
- [ ] Move the vendor originals in from `C:\trainual\assets\*\*\source\` (1.8 GB)
- [ ] Copy all 20 parts' files in from `C:\trainual\parts\`
- [ ] Copy the GLBs and records in from `C:\trainual\assets\` (the records then get committed under `moonshot/`)
- [ ] **Back up** the vendor originals, the parts and the print package
  (`~\Downloads\PARTS PACKAGE FOR DATA ENTRY FROM PRINTS`) to an external drive. None of them can be fetched again.
- [ ] You, whenever you like: delete trainual's old `renders/` on the M4 Max (5.1 GB) and the copy in
  `~\Downloads\trainual` (6.2 GB). Everything needed from them is in the data root.

Not needed, so not copied: the raw GRAB, ARCTIC and MANO downloads (they stay on the M4 Max), trainual's web build,
`node_modules`, virtual environments and its old `.env`.

## 3. Code skeleton in Jigged (day 1)

- [ ] Branch for the skeleton
- [ ] `moonshot/` with the four stages (library, part, plan, video), each importing only the data files between them
- [ ] Fences: `/moonshot` in `.vercelignore`, `moonshot/**` in `vercel.json` `excludeFiles` (stays at or under 256
  characters)
- [ ] Add `moonshot/` to the doc-link check's path prefixes, so this doc's citations get checked
- [ ] The thresholds file: every value in §3 and §5, with its source (study, spec sheet, reference take, or *proposed*)
- [ ] The CI check for §6 rule 1: a PR may change thresholds, reference outputs or bad takes, or the code, not both
- [ ] The CI check that every physics and realism check has a bad take it catches (§5.4, counterfactuals)
- [ ] A CI job for the fast tier, timed against the 3-minute target (§6)

## 3b. Body model, usage cards and checks (§3–§5), before any station

- [ ] The body model in MuJoCo: trunk to fingertip, 73 joints for two arms, each a motor with its range, speed,
  strength and couplings (§3.1)
- [ ] Strength curves (torque by joint angle and speed) sourced from published measurements, per joint (§3.1)
- [ ] Two-joint muscle couplings: wrist bend moves the fingers (§3.1)
- [ ] MyoSuite muscle check running on the farm: every take replayed, muscle activations reported (§3.1, §5.1)
- [ ] Body conformance tests pass: range, speed, strength, strength curves, couplings, muscle check agrees,
  proportions, gravity (§3.1)
- [ ] Watch the deformable-pad trigger: count grip assists and grip complaints per station (§3.1). Only if it
  fires: MuJoCo deformable fingertip and palm pads.
- [ ] Record conformance tests for every machine and tool as it lands (§3.2)
- [ ] The usage-card format (§4), with the first cards for the G1 tools: band saw, VMC controls, calipers,
  micrometer, indicator
- [ ] For each G1 card: the maker's instructions found; YouTube or research-dataset footage found, downloaded to
  `C:\jigged-data\footage\` and hand-tracked (bonus, not required; videos never committed or published)
- [ ] Claude's look rubric (§5.3) calibrated against your judgement on the first station

- [ ] Port trainual's checks (joint ranges, wrist ellipse, body vs. people, skin penetration, per-verb physics) into
  the production checks that run on every frame (§5.1–5.2)
- [ ] Add the new checks: nothing moves without a cause; machines inside spec; shortcuts declared; grasp timing;
  hand opening; matches its footage (cards with footage only)
- [ ] The new core reproduces the reference take's per-verb outcomes (`C:\jigged-data\reference\setup-take\`)
- [ ] Counterfactuals: half friction drops the part; no crank leaves the vise open; an open door refuses the cycle
- [ ] Timestep halving converges
- [ ] The four known gaps in §5.5: three fixed by the new body model; trunk rotation given a standing-work range (§11)

## 4. Job queue (timeboxed Nov 1–2)

- [ ] Queue on the hub: SQLite, HTTP API, leases
- [ ] Workers on all three machines
- [ ] Tests: lease expiry, reassignment, worker killed mid-job, hub restart, dropped network
- [ ] Dashboard on the tailnet: workers, queue by group, hours against forecast, cloud credit, failures, drafts
- [ ] **End of Nov 2:** reliable → keep; otherwise switch to Flamenco (§8)

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
- [ ] Nov 3: VF-2, band saw, inspection bench conformant; `nist-ctc-01` drafts reviewed by you
- [ ] Nov 4: render queue live; `nist-ctc-01` finals
- [ ] **Nov 5: `nist-ctc-01` on the web; sharing starts**
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
