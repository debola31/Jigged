"""nist-ftc-10's step 69, "Deburr every edge", run on the full body model at the inspection bench: the plan
(moonshot/motion/deburr.py), its physics (moonshot/sim/bench.py), and the take written to the data root for the
checks and the render. Its gate is moonshot/tests/gates/test_deburr_take.py.

    python -m moonshot.sim.deburr [--replan] [--seconds S]     # -> <data root>/takes/nist-ftc-10-deburr
"""
from __future__ import annotations

import json
import sys

from moonshot.motion import deburr as plan
from moonshot.sim.bench import BenchRun
from moonshot.world import bench_cell as BC

NEVER_HELD = ["deburr_blade"]          # the hand holds the handle; the blade cuts
SOLIDS = ["part", "deburr_tool"]       # what the skin is measured against


def run(replan: bool = False, seconds: float | None = None) -> dict:
    if replan or not (plan.OUT / "reference.npz").exists():
        plan.build()
    r = BenchRun(plan.OUT, plan.loose(), carried=("deburr_tool",),
                 grip_objects={"tool": ("deburr_tool",), "steady": ("part",)})
    r.run(seconds)
    blade = [i for i, e in enumerate(r.presses) if e.get("at") == "deburr_blade"]
    steady = [i for i, e in enumerate(r.presses) if e["side"] == "L"]
    report = {"strokes": [{"press_N_median": r.press_median(i)} for i in blade],
              "steady": {"press_N_median": r.press_median(steady[0]) if steady else 0.0}}
    r.export("inspection_bench", NEVER_HELD, SOLIDS, BC.render_glbs(r.model), report)
    return json.loads((plan.OUT / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    argv = sys.argv[1:]
    print(json.dumps(run("--replan" in argv, float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None),
                     indent=1))
