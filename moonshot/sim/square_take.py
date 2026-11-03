"""Check it's square (op50: the part standing on its end on the vise floor), run in MuJoCo on the full body at the
pendant (moonshot/sim/pendant.py), from the plan moonshot/motion/setting.py writes: the test indicator in the spindle
jogged against the part's side and preloaded, then swept up it by jogging Z with the handle. The needle is how far
the side pushes the ball in, read from the geometry (the indicator doesn't collide); test_setting_takes.py holds it
steady from the record's poses.

    python -m moonshot.sim.square_take nist-ftc-10 op50-check      # run, write the take record, print the outcome
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.sim.pendant import PendantRunner


class SquareTake(PendantRunner):
    def __init__(self, folder):
        super().__init__(folder)
        self.needle: list[float] = []

    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        m, d = self.model, self.data
        tip, part = m.geom("tool_tip").id, m.geom("blank").id
        out = np.abs(d.geom_xpos[tip] - d.geom_xpos[part]) - m.geom_size[part]     # the part doesn't turn
        gap = float(np.linalg.norm(np.maximum(out, 0)) + min(out.max(), 0))
        self.needle.append(round(max(0.0, (m.geom_size[tip][0] - gap) * 1000), 4))

    def outcome(self) -> dict:
        on = [n for n in self.needle if n > 0]
        return super().outcome() | {"needle_mm": [min(on), max(on)] if on else None}


def main(argv: list[str]) -> None:
    folder = data_root() / "takes" / argv[0] / argv[1]
    run = SquareTake(folder)
    run.run(float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None)
    run.export(folder)
    print(json.dumps(run.outcome(), indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
