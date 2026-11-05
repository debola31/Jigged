"""A part's size checked with the 6 in calipers' outside jaws (G1's), run on the full body model at the inspection bench:
the plan (moonshot/motion/caliper_outside.py, the part's Job), its physics (moonshot/sim/bench.py), and the take written
to the data root for the checks and the render. Its gate is moonshot/tests/gates/test_caliper_outside_take.py.

    python -m moonshot.sim.caliper_outside <part> [--replan] [--seconds S]   # -> <data root>/takes/<part>-inspect
"""
from __future__ import annotations

import json
import sys

from moonshot.motion import caliper_outside as plan
from moonshot.sim.bench import BenchRun
from moonshot.world import bench_cell as BC

NEVER_HELD = ["cal6_jaw_out", "cal6_mjaw_out", "cal6_rod"]   # the jaws measure; the hands hold the beam and the slider
SOLIDS = ["part", "insp_cal6", "insp_cal6_slider"]           # what the skin is measured against


def run(part: str, replan: bool = False, seconds: float | None = None) -> dict:
    out = plan.out(part)
    if replan or not (out / "reference.npz").exists():
        plan.build(part)
    r = BenchRun(out, plan.loose(plan.JOBS[part]), carried=("insp_cal6_slider", ("L", "insp_cal6")), skip=("cal6",),
                 grip_objects={"slide": ("insp_cal6_slider",), "beam": ("insp_cal6",)})
    r.run(seconds)
    jaw = lambda at: [i for i, e in enumerate(r.presses) if e.get("at") == at]     # noqa: E731
    slide = r.model.jnt_qposadr[r.model.joint("cal6_slide").id]
    report = {"fixed_jaw": {"press_N_median": r.press_median(jaw("cal6_jaw_out")[0]) if jaw("cal6_jaw_out") else 0.0},
              "moving_jaw": {"press_N_median": r.press_median(jaw("cal6_mjaw_out")[0]) if jaw("cal6_mjaw_out") else 0.0},
              "slide_end_mm": round(float(r.data.qpos[slide]) * 1000, 4)}
    r.export("inspection_bench", NEVER_HELD, SOLIDS, BC.render_glbs(r.model, part), report)
    return json.loads((out / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    argv = sys.argv[1:]
    print(json.dumps(run(argv[0], "--replan" in argv,
                         float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None), indent=1))
