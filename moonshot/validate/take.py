"""Every registered check, run on one physics take before it is rendered (docs/moonshot/physics.md). A take that fails
any of them, or lacks what one of them reads, isn't rendered: a check with nothing to read fails rather than skips,
because a skipped check is how the skin-depth check went unrun.

    python -m moonshot.validate.take <take dir>      # prints each check; exits 1 unless every one passes

The take directory holds the plan (take.json) and the physics run (sim.npz and checks.json, written by
moonshot/sim/vise_take.py). The skin's depth is measured from them (moonshot/validate/skin.py), not read from the
render's bake, so the checks need nothing the render makes. The muscles' activations come from replaying the run in
MyoSuite (moonshot/validate/muscle.py), which needs the load on the hand (checks.json hand_wrench): without it the
muscle check has nothing to read. The posture checks compare the run's angles with people's (validate/posture.py),
from a prior only the data root holds. Machine axes, active constraints and applied forces, and the lifting force
(checks.json machine_axes, active_constraints, applied_forces, load_N) are read as the run writes them, and the card
a take plays from take.json's `card`; where the run or the plan doesn't write one yet, its check fails.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.validate import cause, footage, grasp_timing, hand_opening, muscle, posture
from moonshot.validate.registry import Result, load_all
from moonshot.validate.skin import depth_mm


def inputs(take: Path) -> dict:
    sim = np.load(take / "sim.npz")
    out = {"wrist_deg": sim["theta"][:, 8:10].tolist()}           # the run's own wr_flex, wr_dev
    if (take / "checks.json").exists():
        out |= json.loads((take / "checks.json").read_text(encoding="utf-8"))
    out["depth_mm"] = depth_mm(take)
    if "hand_wrench" in out:
        out |= muscle.measure(take)
    if posture.PRIOR.exists():
        out |= posture.measure(sim["theta"][:, :10])
    for check_inputs in (cause.measure, grasp_timing.measure, hand_opening.measure, footage.measure):
        out |= check_inputs(take)
    return out


def run(take: Path) -> dict[str, Result | str]:
    """Each check's result, or why it couldn't run."""
    data, out = inputs(take), {}
    for name, c in load_all().items():
        try:
            out[name] = c.run(data)
        except KeyError as e:
            out[name] = f"nothing to read: {e}"
    return out


def main(argv: list[str]) -> int:
    ok = True
    for name, r in run(Path(argv[0])).items():
        if isinstance(r, str):
            print(f"FAIL {name}: {r}")
            ok = False
        else:
            print(f"{'pass' if r.passed else 'FAIL'} {name}: worst {r.worst:.3f} {r.detail}")
            ok &= r.passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
