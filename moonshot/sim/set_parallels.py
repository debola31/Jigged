"""The physics of setting the parallels (moonshot/motion/set_parallels.py): the VF-2 cell with its doors open, the
vise open at the load's opening, the part waiting on the table, and the parallels free bodies standing in their rack.
The pinch holds each parallel by a declared soft constraint while it is carried, as a tool is held (the capsule
fingers on a 3.1 mm plate can't hold it by friction alone); it is let go standing on the seat, and the physics decides
whether it stays standing where the load take expects it.

    python -m moonshot.sim.set_parallels           # runs the take in the data root and writes its take record
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.motion import set_parallels as SP
from moonshot.sim.door_cycle import _Cell
from moonshot.world import cell
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V


class SetParallels(_Cell):
    doors_open_mm = 600.0          # fully open, as the vise take loads with them
    grip_geoms = {SP.GRIP[n]: n for n in SP.ORDER}
    encloses = {SP.GRIP[n]: n for n in SP.ORDER}
    welded = set(SP.GRIP.values())

    def __init__(self, folder=SP.TAKES / "set-parallels"):
        super().__init__(folder)
        self.load = V.REFERENCE
        self.base_at = {n: [] for n in SP.ORDER}
        self.tilt = {n: [] for n in SP.ORDER}
        self.in_hand = {n: [] for n in SP.ORDER}
        self.carry = {e["object"]: e for e in self.tk["events"] if e["kind"] == "carry"}

    def scene(self, body_xml: str) -> str:
        load = V.REFERENCE
        xml = cell.with_body(body_xml, load.stage, RACK.slots(load), "R_hand", load)
        return xml.replace("<worldbody>\n", "<worldbody>\n" + RACK.xml(), 1)

    def start(self) -> None:
        """The table at the loading spot, the doors open, the vise open at the load's opening and locked."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in ("door_left", "door_right"):
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0] = d.qpos[m.jnt_qposadr[m.joint("crank").id]]
        d.eq_active[lock] = 1
        for n in SP.ORDER:                  # free in their rack: the vise scene's keeper clips hold them for the load take
            d.eq_active[m.equality(f"keep_{n}").id] = 0

    def planned_relpose(self, grip):
        """None: the pinch holds the parallel where the fingers close on it. The planned pose would pull it sideways by
        the hand's few mm of error into its slot's walls (0.9 mm play), and the hand jams."""
        return None

    def hand_force(self, side, t):
        """The parallel's weight, carried."""
        if side == "R" and any(e["t0"] <= t < e["t1"] for e in self.carry.values()):
            return np.array([0.0, 0.0, SP.STEEL * V.PARALLEL_L * V.PARALLEL_T * self.load.parallel_h * 1e-9 * 9.81])
        return None

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        hb = m.body("R_hand").id
        Rh, ph = d.xmat[hb].reshape(3, 3), d.xpos[hb]
        for n in SP.ORDER:
            b = m.body(n).id
            R = d.xmat[b].reshape(3, 3)
            self.base_at[n].append((d.xpos[b] - R[:, 2] * self.load.parallel_h / 2 * 0.001) * 1000)
            self.tilt[n].append(float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))))
            self.in_hand[n].append(Rh.T @ (d.xpos[b] - ph) * 1000)

    def outcome(self) -> dict:
        t = np.arange(len(self.base_at[SP.ORDER[0]])) / self.fps
        dest, out = self.load.parallels(), {}
        for n in SP.ORDER:
            B, Hh, e = np.array(self.base_at[n]), np.array(self.in_hand[n]), self.carry[n]
            carried = (t >= e["t0"] + 0.2) & (t < e["t1"] - 0.2)
            ref = Hh[np.argmax(carried)]
            out[n] = {"off_mm": [round(float(v), 2) for v in B[-1] - dest[n]],
                      "tilt_deg": round(self.tilt[n][-1], 2),
                      "lifted_mm": round(float(B[:, 2].max() - B[0, 2]), 1),
                      "max_slip_mm": round(float(np.linalg.norm(Hh[carried] - ref, axis=1).max()), 2)}
        return out


def main(argv: list[str]) -> int:
    r = SetParallels()
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("set-parallels", out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
