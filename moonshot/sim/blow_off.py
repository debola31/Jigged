"""The physics of blowing off the vise with the air gun (moonshot/motion/blow_off.py): the VF-2 cell with its doors
open and the part in the vise, the holster on the front panel and the gun a free body in it. The closed hand holds
the gun's handle by a declared soft constraint, as the vise take does the crank's knob (the capsule fingers can't
conform to it); while aiming, the index squeezes the trigger, which is held whenever a finger presses it past 3 N;
no air flows.

    python -m moonshot.sim.blow_off           # runs the take in the data root and writes its take record
"""
from __future__ import annotations

import json
import sys

import mujoco
import numpy as np

from moonshot.body.skeleton import H0
from moonshot.motion import blow_off as BO
from moonshot.sim.door_cycle import _Cell
from moonshot.world import air_gun as AG
from moonshot.world.vise import VISE

TRIGGER_N = 3.0
SETTLE_S = 0.3


class BlowOff(_Cell):
    doors_open_mm = BO.DOORS_OPEN_MM
    grip_geoms = {"gun": "air_gun_handle", "gun_fire": "air_gun_trigger"}
    encloses = {"gun": "air_gun"}
    welded = {"gun"}
    controls = {"air_gun_trigger"}

    def __init__(self, folder=BO.TAKES / "blow-off"):
        super().__init__(folder)
        self.carry = next(e for e in self.tk["events"] if e["kind"] == "carry")
        self.gun_at, self.hand_at, self.trigger_N, self.tip = [], [], [], []

    def scene(self, body_xml: str) -> str:
        xml = super().scene(body_xml)
        return xml.replace("<worldbody>\n", "<worldbody>\n" + AG.holster_xml(BO.ORIGIN) + AG.gun_xml(BO.ORIGIN), 1)

    def planned_relpose(self, grip):
        g = json.loads((self.folder / "grips.json").read_text(encoding="utf-8"))[grip]
        R0, p0 = AG.holstered_pose(BO.ORIGIN)
        hand = np.array(g["H"]) @ H0.T                       # the hand body's frame, from the grip's hand frame
        return R0.T @ (np.array(g["W"]) - p0) * 0.001, R0.T @ hand

    def hand_force(self, side, t):
        """The gun's weight, carried."""
        if side == "R" and self.carry["t0"] <= t < self.carry["t1"]:
            return np.array([0.0, 0.0, AG.GUN_KG * 9.81])
        return None

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        hb = m.body("R_hand").id
        Rh, ph = d.xmat[hb].reshape(3, 3), d.xpos[hb]
        self.gun_at.append(d.body("air_gun").xpos * 1000)
        self.hand_at.append(Rh.T @ (d.body("air_gun").xpos - ph) * 1000)        # the gun in the hand's frame
        self.tip.append(d.site("air_gun_tip").xpos * 1000)
        trig, f, c6 = m.geom("air_gun_trigger").id, 0.0, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            if trig in (c.geom1, c.geom2):
                other = m.body(m.geom_bodyid[c.geom2 if c.geom1 == trig else c.geom1]).name
                if other.startswith("R_"):
                    mujoco.mj_contactForce(m, d, i, c6)
                    f += abs(c6[0])
        self.trigger_N.append(f)

    def outcome(self) -> dict:
        t = np.arange(len(self.gun_at)) / self.fps
        G, Hh, tip = np.array(self.gun_at), np.array(self.hand_at), np.array(self.tip)
        rest = G[int(SETTLE_S * self.fps)]
        carried = (t >= self.carry["t0"] + 0.3) & (t < self.carry["t1"] - 0.3)
        ref = Hh[np.argmax(carried)]
        over = ((np.abs(tip[:, 0] - VISE["x"]) < VISE["half_width"] + 20)
                & (tip[:, 1] > VISE["fixed_face_y"] - 130) & (tip[:, 1] < VISE["fixed_face_y"] + 20))
        blowing = (np.array(self.trigger_N) > TRIGGER_N) & over
        return {"lifted_mm": round(float(G[:, 2].max() - rest[2]), 1),
                "max_slip_mm": round(float(np.linalg.norm(Hh[carried] - ref, axis=1).max()), 2),
                "blowing_over_vise_s": round(float(blowing.sum() / self.fps), 2),
                "trigger_N_max": round(float(max(self.trigger_N)), 1),
                "end_off_rest_mm": round(float(np.linalg.norm(G[-1] - rest)), 1)}


def main(argv: list[str]) -> int:
    r = BlowOff()
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("blow-off", out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
