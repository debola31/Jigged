"""Every registered check, run on one physics take before it is rendered (docs/moonshot/physics.md). A take that fails
any of them, or lacks what one of them reads, isn't rendered: a check with nothing to read fails rather than skips,
because a skipped check is how the skin-depth check went unrun.

    python -m moonshot.validate.take <take dir>      # prints each check; exits 1 unless every one passes

The take directory holds the plan (take.json) and the physics run (sim.npz and checks.json, written by
moonshot/sim/vise_take.py or moonshot/sim/bench.py). The skin's depth is measured from them
(moonshot/validate/skin.py), not read from the render's bake, so the checks need nothing the render makes. A
two-armed take's sim.npz carries the left arm's angles after the right's (theta columns 12-20), and both wrists are
held to the ellipse, every frame of each.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.validate.registry import Result, load_all
from moonshot.validate.skin import depth_mm


def inputs(take: Path) -> dict:
    sim = np.load(take / "sim.npz")
    out = {"wrist_deg": sim["theta"][:, 8:10].tolist()}           # the run's own wr_flex, wr_dev
    if sim["theta"].shape[1] == 21:                               # and the left's
        out["wrist_deg"] += sim["theta"][:, 17:19].tolist()
    if (take / "checks.json").exists():
        out |= json.loads((take / "checks.json").read_text(encoding="utf-8"))
    out["depth_mm"] = depth_mm(take)
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
