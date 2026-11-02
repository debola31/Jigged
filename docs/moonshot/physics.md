# Moonshot physics: what a take is held to, and what enforces it

**As-built, verified 2026-11-01**, on the vise take run in the VF-2 cell. Strategy and the checks' thresholds are in
[shop-and-pipeline-plan.md §3 and §5](shop-and-pipeline-plan.md#5-checks-and-tests); tasks in
[checklist.md](checklist.md).

**The principle: MuJoCo enforces only what our scene description tells it.** That description (MuJoCo calls it the
model; nothing to do with Claude) is the MJCF our code writes: the bodies and their collision shapes, the joints and
their limits, the motors and their strength, and the mechanisms' constraints, from
[`skeleton.py`](../../moonshot/body/skeleton.py) and [`moonshot/world/`](../../moonshot/world/). MuJoCo solves
contacts, friction and forces for exactly what is written there, and nothing else. A physical rule the description
leaves out, and no check catches, is not enforced, however real the video looks. Every rule below is therefore one of three
things: a constraint MuJoCo solves, a check that fails the take, or a named gap.

## How a take is made

| Stage | Code | What it decides |
|---|---|---|
| Plan | [`moonshot/motion/`](../../moonshot/motion/) | Joint angles per frame, grips and events, kinematically, from task constraints under a posture prior measured from people. It can ask for anything its costs allow. |
| Physics | [`moonshot/sim/vise_take.py`](../../moonshot/sim/vise_take.py) on [`moonshot/body/skeleton.py`](../../moonshot/body/skeleton.py) and [`moonshot/world/`](../../moonshot/world/) | MuJoCo at 1 ms. Strength-capped motors track the plan with inverse-dynamics feedforward; contacts, friction and mechanisms decide what actually happens. |
| Render | trainual's `motion/skin_bake.py` and `blender/showcase_physics.py`, not yet ported | NIMBLE's skin on the simulated hand. Skin that lands inside an object is pressed onto its surface, with the depth recorded per vertex. |
| Checks | [`moonshot/tests/gates/`](../../moonshot/tests/gates/), [`moonshot/validate/`](../../moonshot/validate/) | Pass or fail on the physics run. |

**A faithful replay is not a check.** When the plan asks for something impossible and the scene description has no
rule against it, the physics reproduces it exactly. That is how both failures below reached a render.

## The rules

| Rule | Modelled as | Enforced by | Status |
|---|---|---|---|
| Each joint within its range | MuJoCo joint limits from [`anatomy.json`](../../moonshot/body/data/anatomy.json) | MuJoCo; `test_body_conformance.py` | Holds |
| **The wrist's flexion and deviation limit each other** (an ellipse, Gracia-Ibanez 2020) | **A box**: each angle limited on its own | **Nothing**. The planner's ellipse is a soft cost. | **Broken.** The reference plan reaches 1.12 on the ellipse (1.0 is the edge) from 3.8 to 5.0 s, holding the blank up to look at it, and the physics follows it. |
| Motor strength | `forcerange` per motor from [`strength.json`](../../moonshot/body/data/strength.json) | MuJoCo; `test_body_conformance.py` | Holds; 14 of 23 strengths are *proposed* |
| Strength by angle and speed | Not modelled | — | Gap |
| **The hand doesn't pass through solids** | Capsules per finger bone, sized to the 40th percentile of the skin, minus 2 mm | MuJoCo contacts, between capsules | **Partial.** The rendered skin reaches 2–4 mm (median) beyond the capsules, up to 13 mm, so it sinks more than 4 mm into the blank and the knob in 443 of 955 frames, 8.27 mm at worst. The bake's projection hides it: the skin is pressed onto the surface, and nothing fails on the recorded depth. |
| **The hand doesn't pass through mechanism parts** | The crank lever has collisions off, as trainual built it | **Nothing** | **Broken.** The knob grip was solved against the lever at its starting angle only. While cranking, the fist keeps its orientation, so the lever sweeps a full circle around the knob's root relative to it; the grip wraps the lever's joint. |
| Parts are lifted by friction, and don't slip | Skin friction 0.6 (Seo & Armstrong 2009) and grip-force regulation | `test_vise_take.py` | Holds |
| Mechanisms obey their ratios | The lead screw as a joint equality | `test_vise_take.py` | Holds |
| The machine within spec, and its interlocks | Position servos capped at rapid speed; `vf2.Control` | `test_vf2_conformance.py`, `test_cell_conformance.py` | Holds |
| The body keeps up with its plan | Lag measured, not gated | — | Gap: 37 mm against 10 mm |
| Muscles under 100% | MyoSuite replay, not built | — | Gap |

## Declared shortcuts

Each one holds something in place regardless of the geometry it stands in for, so each needs a check against that
geometry. None has one yet.

| Shortcut | Stands in for | What it hid |
|---|---|---|
| `enclose`: a soft connect from the knob to the hand while cranking | Flesh conforming around the knob, which capsules can't | It holds the knob wherever the hand is, including wrapped round the lever's joint |
| `screw_lock`: the crank locked while not driven | The lead screw self-locking under clamp load | — |
| `keep_para_*`: parallels welded to the table until checked | Parallels resting under their own friction | — |

## Withdrawn

- **Withdrawn:** trainual's accepted take as the realism bar. It's wrong because it breaks the wrist ellipse and
  grips the crank at the lever's joint (found on review, 2026-11-01). It stays the bar for per-verb outcomes only.
- **Withdrawn:** rendering a draft before its per-frame checks run. It's wrong because review then catches what a
  check should have (2026-11-01).
- **Withdrawn:** the reference's skin depth as 1.52 mm ([§5.1](shop-and-pipeline-plan.md#51-physics-checked-in-mujoco-on-every-frame)).
  It's wrong because that was measured against the table alone; against the knob it's 8.27 mm.
