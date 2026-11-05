"""A part's deburring step (nist-ftc-10's step 69, "Deburr every edge", and G1's), run on the full body model at the
inspection bench: the plan (moonshot/motion/deburr.py, the part's Job), its physics (moonshot/sim/bench.py), and the
take written to the data root for the checks and the render. Its gate is moonshot/tests/gates/test_deburr_take.py.

    python -m moonshot.sim.deburr [part] [--replan] [--seconds S]   # -> <data root>/takes/<part>-deburr
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from moonshot.motion import deburr as plan
from moonshot.sim.bench import BenchRun
from moonshot.world import bench_cell as BC

NEVER_HELD = ["deburr_shank", "deburr_blade", "deburr_blade_hook"]   # the hand holds the handle; the blade cuts
SOLIDS = ["part", "deburr_tool"]       # what the skin is measured against


def run(part: str = "nist-ftc-10", replan: bool = False, seconds: float | None = None, folder=None) -> dict:
    """folder: where the take is planned and run, if not its own folder under takes/ (a trial's)."""
    out = Path(folder) if folder else plan.out(part)
    if replan or not (out / "reference.npz").exists():
        plan.build(part, folder=out)
    r = BenchRun(out, plan.loose(plan.JOBS[part]), carried=("deburr_tool",), skip=plan.JOBS[part].skip,
                 grip_objects={"tool": ("deburr_tool",), "steady": ("part",)})
    r.run(seconds)
    blade = [i for i, e in enumerate(r.presses) if e.get("at") == "deburr_blade"]
    steady = [i for i, e in enumerate(r.presses) if e["side"] == "L"]
    report = {"strokes": [{"press_N_median": r.press_median(i)} for i in blade],
              "steady": {"press_N_median": r.press_median(steady[0]) if steady else 0.0}}
    r.export("inspection_bench", NEVER_HELD, SOLIDS, BC.render_glbs(r.model, part), report)
    return json.loads((out / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    argv = sys.argv[1:]
    folder = argv[argv.index("--out") + 1] if "--out" in argv else None
    part = next((a for a in argv if not a.startswith("--") and not a.replace(".", "").isdigit() and a != folder),
                "nist-ftc-10")
    print(json.dumps(run(part, "--replan" in argv,
                         float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None, folder), indent=1))
