"""The physics of blowing off the vise with the air gun (moonshot/motion/blow_off.py): the VF-2 cell with its doors
open and the part in the vise, the holster on the front panel and the gun a free body in it. The closed hand holds
the gun's handle by a declared soft constraint, as the vise take does the crank's knob (the capsule fingers can't
conform to it); while aiming, the index squeezes the trigger, which is held whenever a finger presses it past 3 N;
no air flows.

    python -m moonshot.sim.blow_off           # runs the take in the data root and writes its take record
    python -m moonshot.sim.blow_off ct-slbeam-op10-clean-blow-off      # a setup's own run, its table as its take.json
                                                                       # names it (moonshot/sim/setup_scene.py)
"""
from __future__ import annotations

import json
import sys

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.motion import blow_off as BO
from moonshot.motion import set_parallels as SP
from moonshot.sim.door_cycle import _Cell
from moonshot.sim.runner import APPROACH_S
from moonshot.sim.set_parallels import FirmGrip
from moonshot.world import air_gun as AG
from moonshot.world.vise import VISE

TRIGGER_N = 3.0
TRIGGER_LEAD_S = 0.4       # the trigger touches the hand again this long before the blow starts
SETTLE_S = 0.3


class BlowOff(FirmGrip, _Cell):
    """As the pinches' (moonshot/sim/set_parallels.py FirmGrip): the weld soft while the grip firms, set again where the
    gun sits in the hand as the carry starts, and the hand keeping its grip's shape while it holds it. Only the trigger
    is squeezed: squeezing the handle drove the fingers into it, the weld holding it."""
    doors_open_mm = BO.DOORS_OPEN_MM
    grip_geoms = {"gun_fire": "air_gun_trigger"}
    encloses = {"gun": "air_gun"}
    welded = {"gun"}
    controls = {"air_gun_trigger"}

    def __init__(self, folder=BO.TAKES / "blow-off"):
        super().__init__(folder)
        self.carry = next(e for e in self.tk["events"] if e["kind"] == "carry")
        k = np.load(self.folder / "gun_keys.npz")
        self.gun_keys = list(zip(k["t"], k["R"], k["p"]))
        self.gun_at, self.hand_at, self.trigger_N, self.tip = [], [], [], []
        self.firm_setup()
        self._trigger_saved = None
        self._now = 0.0
        blow = next(e for e in self.tk["events"] if e["kind"] == "blow")
        self.trigger_from = blow["t0"] - TRIGGER_LEAD_S

    def carry_of(self, grip_event: dict) -> dict:
        return self.carry

    def squeeze_dirs(self, side: str, grip: str) -> dict[str, np.ndarray]:
        """As the runner's, the index alone: the middle finger is near the trigger too, and squeezed it went 9 mm into
        the handle, which the weld holds apart from it."""
        return {dg: v for dg, v in super().squeeze_dirs(side, grip).items() if dg == "index"}

    def touching(self, side: str) -> bool:
        """As the runner's, and sight leaves the hand be through a fast move, as the pinches' (sim/set_parallels.py
        FirmGrip.fast): corrected through the reach the hand closed 12 mm off its grip, its skin 8 mm into the handle."""
        if side == "R" and self.fast(self._now):
            return True
        return super().touching(side)

    def enclose(self, t: float) -> None:
        """As the runner holds a welded tool, and the trigger apart from the hand too until just before the index pulls
        it: the index closes onto it with the hand, and pressing the gun on the weld still soft while the grip firms,
        it pushed the gun 49 N into its holster's walls; touching again as the carry started, it knocked the gun up
        off its rim 33 ms into the loading."""
        self._now = t
        super().enclose(t)
        m = self.model
        g = m.geom("air_gun_trigger").id
        e = self.grip_events[0]
        firming = e["t0"] - APPROACH_S <= t < self.trigger_from
        if firming and self._trigger_saved is None:
            self._trigger_saved = (int(m.geom_contype[g]), int(m.geom_conaffinity[g]))
            m.geom_contype[g], m.geom_conaffinity[g] = 4, 1
        elif not firming and self._trigger_saved is not None:
            m.geom_contype[g], m.geom_conaffinity[g] = self._trigger_saved
            self._trigger_saved = None

    def scene(self, body_xml: str) -> str:
        xml = super().scene(body_xml)
        return xml.replace("<worldbody>\n", "<worldbody>\n" + AG.holster_xml(BO.ORIGIN) + AG.gun_xml(BO.ORIGIN), 1)

    def planned_relpose(self, grip):
        """The hand body in the holstered gun's frame as the solved plan has it when the fingers close: the body solver
        turns the hand up to 10 degrees off the grip's own frame, which put the gun 15-20 mm off its path from the
        grip's frame, enough to miss the 24 mm bore."""
        e = next(e for e in self.grip_events if e["grip"] == grip)
        q, _, _ = self.at(e["t0"] + 0.1)
        pl = mujoco.MjData(self.model)
        pl.qpos[:] = q
        mujoco.mj_kinematics(self.model, pl)
        hb = self.model.body("R_hand").id
        R0, p0 = AG.holstered_pose(BO.ORIGIN)
        return R0.T @ (pl.xpos[hb] * 1000 - p0) * 0.001, R0.T @ pl.xmat[hb].reshape(3, 3)

    def held_error(self, side, t):
        """While the gun is in the hand, the eye is on the gun: its planned pose (gun_keys.npz) against where it is."""
        m, d = self.model, self.data
        if side != "R" or not d.eq_active[m.equality(self.eq_name("gun")).id]:
            return None
        R, p = BO.BlowOff.pose_at(None, t, self.gun_keys)
        b = m.body("air_gun").id
        return np.r_[(p * 0.001 - d.xpos[b]), Rotation.from_matrix(R @ d.xmat[b].reshape(3, 3).T).as_rotvec()]

    def hand_force(self, side, t):
        """The gun's weight, carried: taken up over people's loading time, as the pinches' (sim/set_parallels.py). All
        at once, the hand pulled the gun 2.5 mm up out of its rim in 33 ms."""
        if side == "R" and self.carry["t0"] <= t < self.carry["t1"]:
            return np.array([0.0, 0.0, AG.GUN_KG * 9.81 * min(1.0, (t - self.carry["t0"]) / SP.LOADING_S)])
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
    for name in argv or ["blow-off"]:
        r = BlowOff(BO.TAKES / name)
        r.run(log=print)
        r.export()
        out = r.outcome()
        (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
