"""The physics of loosening the vise and lifting the part out (moonshot/motion/unload.py): the VF-2 cell with its
doors open and the part in the vise with the jaw on it. The closed hand holds the crank's knob by the vise take's
declared soft constraint while it cranks; the screw is locked whenever the crank isn't being turned, as the vise
take locks it. The part is a free body the hand lifts by its faces, carried by friction alone.

    python -m moonshot.sim.unload           # runs the take in the data root and writes its take record
"""
from __future__ import annotations

import json
import math
import sys

import mujoco
import numpy as np

from moonshot.motion import unload as UL
from moonshot.sim.door_cycle import _Cell
from moonshot.world import vise as V


class Unload(_Cell):
    doors_open_mm = 600.0          # fully open, as the vise take loads with them: at 300 the forearm meets the right one
    grip_geoms = {"knob": "knob", "blank_faces": "blank"}
    encloses = {"knob": "knob"}

    def __init__(self, folder=UL.TAKES / "unload"):
        super().__init__(folder)
        k = np.load(self.folder / "part_keys.npz")
        self.keys_t, self.keys_p = k["t"], k["p"]
        self.crank_ev = next(e for e in self.tk["events"] if e["kind"] == "crank")
        m = self.model
        self.q_crank, self.q_jaw = m.jnt_qposadr[m.joint("crank").id], m.jnt_qposadr[m.joint("jaw_slide").id]
        self.lock = m.equality("screw_lock").id
        self.blank_at, self.blank_R, self.held, self.in_hand = [], [], [], []

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
        """The part's weight, carried in the right hand."""
        if side == "R" and self.keys_t[0] <= t < self.keys_t[-1]:
            return np.array([0.0, 0.0, V.REFERENCE.mass_kg * 9.81])
        return None

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        b = m.body("blank").id
        self.blank_at.append(d.xpos[b] * 1000)
        self.blank_R.append(d.xmat[b].reshape(3, 3).copy())
        geom = m.geom("blank").id
        touching = set()
        for i in range(d.ncon):
            c = d.contact[i]
            if geom in (c.geom1, c.geom2):
                other = m.body(m.geom_bodyid[c.geom2 if c.geom1 == geom else c.geom1]).name
                if other[:2] in ("R_", "L_"):
                    touching.add(other[0])
        self.held.append(touching)
        hb = m.body("R_hand").id
        self.in_hand.append(d.xmat[hb].reshape(3, 3).T @ (d.xpos[b] - d.xpos[hb]) * 1000)
        if k == 0:
            self.crank0, self.jaw0 = d.qpos[self.q_crank], d.qpos[self.q_jaw]
        self.crank1, self.jaw1 = d.qpos[self.q_crank], d.qpos[self.q_jaw]

    def outcome(self) -> dict:
        B = np.array(self.blank_at)
        t = np.arange(len(B)) / self.fps
        load = V.REFERENCE
        bottom = B[:, 2] - load.half[2]
        up = bottom > V.VISE["seat_z"] + load.parallel_h + 5
        carried = (t >= self.keys_t[1]) & (t < self.keys_t[-1] - 0.2)
        ref = np.array(self.in_hand)[np.argmax(carried)]
        R = self.blank_R[-1]
        return {"turns": round(float((self.crank1 - self.crank0) / (2 * math.pi)), 3),
                "opened_mm": round(float(-(self.jaw1 - self.jaw0) * 1000), 2),
                "cleared_jaws_mm": round(float(bottom.max() - V.VISE["jaw_top_z"]), 1),
                "lifted_in_hand": bool(up.any() and all("R" in h for h, u in zip(self.held, up) if u)),
                "max_slip_mm": round(float(np.linalg.norm(np.array(self.in_hand)[carried] - ref, axis=1).max()), 2),
                "set_down_vs_planned_mm": [round(float(v), 2) for v in B[-1] - self.keys_p[-1]],
                "tilt_deg": round(float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))), 2)}


def main(argv: list[str]) -> int:
    r = Unload()
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("unload", out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
