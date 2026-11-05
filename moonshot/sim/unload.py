"""The physics of loosening the vise (moonshot/motion/unload.py): the VF-2 cell with its doors open and the part in
the vise with the jaw on it. The closed hand holds the crank's knob by the vise take's declared soft constraint while
it cranks; the screw is locked whenever the crank isn't being turned, as the vise take locks it.

    python -m moonshot.sim.unload           # runs the take in the data root's takes/loosen and writes its take record
    python -m moonshot.sim.unload ct-slbeam-op10-loosen      # a setup's own run, its part clamped (sim/setup_scene.py)
"""
from __future__ import annotations

import json
import math
import re
import sys

import numpy as np

from moonshot.motion import unload as UL
from moonshot.sim.door_cycle import _Cell
from moonshot.world import vise as V


PUSH_N = 8.0         # the knob's push round the crank: its 0.6 N m of friction is 5 N at the 120 mm lever


class Unload(_Cell):
    doors_open_mm = 600.0          # fully open, as the vise take loads with them: at 300 the forearm meets the right one
    grip_geoms = {"knob": "knob"}
    encloses = {"knob": "knob"}
    vise_keys = True               # the run carries the vise's keys, so the checks read it as the vise take's: the jaw
                                   # opening is what moves the part and the parallels, and the knob is grasped as there

    def eq_name(self, grip: str) -> str:
        """The knob is held by the vise take's own declared constraint, `enclose` (declared-shortcuts.json)."""
        return "enclose"

    def scene(self, body_xml: str) -> str:
        """The cell's, less the vise's own `enclose`: TakeRunner adds the one this take drives, by the same name."""
        return re.sub(r'\s*<connect name="enclose"[^>]*/>', "", super().scene(body_xml), count=1)

    def __init__(self, folder=UL.TAKES / "loosen"):
        super().__init__(folder)
        self.crank_ev = next(e for e in self.tk["events"] if e["kind"] == "crank")
        m = self.model
        self.q_crank, self.q_jaw = m.jnt_qposadr[m.joint("crank").id], m.jnt_qposadr[m.joint("jaw_slide").id]
        self.lock = m.equality("screw_lock").id

    def before_step(self, t: float) -> None:
        m, d = self.model, self.data
        turning = self.crank_ev["t0"] - 0.1 <= t < self.crank_ev["t1"] + 0.1
        if turning and d.eq_active[self.lock]:
            d.eq_active[self.lock] = 0
        elif not turning and not d.eq_active[self.lock]:
            m.eq_data[self.lock, 0] = d.qpos[self.q_crank]
            d.eq_active[self.lock] = 1
        super().before_step(t)

    def hand_force(self, side, t):
        """The push that turns the crank back, along the knob's path, fed forward as people push a crank they know
        (the vise take pushes the same way, trimmed by feedback)."""
        if side != "R" or not self.crank_ev["t0"] <= t < self.crank_ev["t1"]:
            return None
        r = self.data.body("knob").xpos * 1000 - V.VISE["screw_axis"]
        closing = np.array([r[2], 0.0, -r[0]]) / (np.hypot(r[0], r[2]) + 1e-9)
        return -closing * PUSH_N

    def on_frame(self, k: int) -> None:
        d = self.data
        if k == 0:
            self.crank0, self.jaw0 = d.qpos[self.q_crank], d.qpos[self.q_jaw]
        self.crank1, self.jaw1 = d.qpos[self.q_crank], d.qpos[self.q_jaw]

    def outcome(self) -> dict:
        return {"turns": round(float((self.crank1 - self.crank0) / (2 * math.pi)), 3),
                "opened_mm": round(float(-(self.jaw1 - self.jaw0) * 1000), 2)}


def main(argv: list[str]) -> int:
    for name in argv or ["loosen"]:
        r = Unload(UL.TAKES / name)
        r.run(log=print)
        r.export()
        out = r.outcome()
        (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
