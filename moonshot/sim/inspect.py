"""nist-ftc-10's step 70, "Check the pocket depth", run on the full body model at the inspection bench: the plan
(moonshot/motion/inspect.py), its physics (moonshot/sim/bench.py), and the take written to the data root for the
checks and the render. Its gate is moonshot/tests/gates/test_inspect_take.py.

    python -m moonshot.sim.inspect [--replan] [--seconds S]    # -> <data root>/takes/nist-ftc-10-inspect
"""
from __future__ import annotations

import json
import sys

from moonshot.motion import inspect as plan
from moonshot.sim.bench import BenchRun
from moonshot.world import bench_cell as BC

NEVER_HELD = ["cal6_rod"]                              # the rod runs into the pocket; the hand holds the slider
SOLIDS = ["part", "insp_cal6", "insp_cal6_slider"]     # what the skin is measured against


def run(replan: bool = False, seconds: float | None = None) -> dict:
    if replan or not (plan.OUT / "reference.npz").exists():
        plan.build()
    r = BenchRun(plan.OUT, plan.loose(), carried=("insp_cal6_slider", ("L", "insp_cal6")), skip=("cal6",),
                 grip_objects={"slider": ("insp_cal6_slider",), "beam": ("insp_cal6",), "hold": ("insp_cal6",)})
    r.run(seconds)
    seat = [i for i, e in enumerate(r.presses) if e.get("at") == "cal6_rod"]
    beam = [i for i, e in enumerate(r.presses) if e.get("at") == "cal6_beam"]
    slide = r.model.jnt_qposadr[r.model.joint("cal6_slide").id]
    report = {"seat": {"press_N_median": r.press_median(seat[0]) if seat else 0.0},
              "beam": {"press_N_median": r.press_median(beam[-1]) if beam else 0.0},      # the reading's
              "slide_end_mm": round(float(r.data.qpos[slide]) * 1000, 4)}
    r.export("inspection_bench", NEVER_HELD, SOLIDS, BC.render_glbs(r.model), report)
    return json.loads((plan.OUT / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    argv = sys.argv[1:]
    print(json.dumps(run("--replan" in argv, float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None),
                     indent=1))
