"""Find X and Y (every VF-2 setup's step 5), run in MuJoCo on the full body at the pendant (moonshot/sim/pendant.py),
from the plan moonshot/motion/setting.py writes.

The edge finder's tip trips when it touches a face of the part, which is read from the geometry each frame: the
tip's circle reaching the part's outline in plan view, with the tip below the part's top. The run reports each trip
(the time and the face), the machine's work offset and every key it registered; test_setting_takes.py holds them to
the plan.

    python -m moonshot.sim.xy_take nist-ftc-10 op10-xy      # run, write the take record beside the plan, print the outcome
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.sim.pendant import PendantRunner


class XYTake(PendantRunner):
    def __init__(self, folder):
        super().__init__(folder)
        self.trips: list[list] = []
        self._tripped = None

    def tip_touch(self) -> str | None:
        """The face the tool's tip touches now ("-x", "+x", "-y", "+y"), or None."""
        m, d = self.model, self.data
        tip, part = m.geom("tool_tip").id, m.geom("blank").id
        r, h = m.geom_size[tip], m.geom_size[part]
        R = d.geom_xmat[part].reshape(3, 3)
        p = R.T @ (d.geom_xpos[tip] - d.geom_xpos[part])           # the tip's centre in the part's frame
        if p[2] - r[1] >= h[2]:
            return None                                             # above the top
        out = np.maximum(np.abs(p[:2]) - h[:2], 0.0)
        if np.linalg.norm(out) > r[0]:
            return None
        i = int(np.argmax(np.abs(p[:2]) - h[:2]))
        return ("+" if p[i] > 0 else "-") + "xy"[i]

    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        face = self.tip_touch()
        if face and face != self._tripped:
            self.trips.append([round(k / self.fps, 3), face])
        self._tripped = face

    def outcome(self) -> dict:
        return super().outcome() | {"trips": self.trips}


def main(argv: list[str]) -> None:
    folder = data_root() / "takes" / argv[0] / argv[1]
    run = XYTake(folder)
    run.run(float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None)
    run.export(folder)
    print(json.dumps(run.outcome(), indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
