"""A part's "Send it out" step run on the full body model at the outside-process rack: the plan
(moonshot/motion/send_out.py), its physics (moonshot/sim/bench.py, in moonshot/world/outproc_cell.py's scene), and the
take written to the data root for the checks and the render. Its gate is moonshot/tests/gates/test_send_out_take.py.

    python -m moonshot.sim.send_out <part> [--replan] [--seconds S] [--out DIR]   # -> <data root>/takes/<part>-send-out
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from moonshot.motion import send_out as plan
from moonshot.sim.bench import BenchRun
from moonshot.world import outproc_cell as OC

NEVER_HELD: list[str] = []          # the hand holds the part; it doesn't hold the bag, and nothing else is in reach
SOLIDS = ["part", "bag"]            # what the skin is measured against


def run(part: str, replan: bool = False, seconds: float | None = None, out=None) -> dict:
    out = Path(out) if out else plan.out_dir(part)
    if replan or not (out / "reference.npz").exists():
        plan.build(part, out=out)
    r = BenchRun(out, plan.loose(part), carried=("part",), grip_objects={"part": ("part",)}, cell=OC)
    r.run(seconds)
    r.export("outproc_rack", NEVER_HELD, SOLIDS, OC.render_glbs(r.model, OC.SEND_OUT[part]), {})
    return json.loads((out / "report.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    argv = sys.argv[1:]
    opt = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None   # noqa: E731
    print(json.dumps(run(argv[0], "--replan" in argv, float(opt("--seconds")) if opt("--seconds") else None,
                         opt("--out")), indent=1))
