"""The physics of setting the stop (moonshot/motion/set_stop.py): the VF-2 cell with its doors open, the vise open at
op50's opening, the part waiting on the table, and the stop a free body standing on the table beyond the parallels'
rack. The pinch holds it by a declared soft constraint while it is carried, as the parallels are
(moonshot/sim/set_parallels.py); it is let go standing on the vise's floor, and the physics decides whether it stays
standing where the load take expects it.

    python -m moonshot.sim.set_stop           # runs the take in the data root and writes its take record
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.motion import set_parallels as SP
from moonshot.motion import set_stop as SS
from moonshot.motion.primitives import min_jerk
from moonshot.sim.door_cycle import _Cell
from moonshot.sim.set_parallels import FirmGrip
from moonshot.world import cell
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V


EYE_RATE = 0.5                     # the eye steers the stop this much slower than a parallel: the arm holds the 0.36 kg
                                   # block 20 mm off its plan, and corrected at the parallels' rate it overshot and
                                   # swung 5 mm either way all the way down, let go 3.3 mm off


class SetStop(FirmGrip, _Cell):
    doors_open_mm = 600.0          # fully open, as the vise take loads with them
    encloses = {SS.GRIP: "stop"}
    welded = {SS.GRIP}

    def __init__(self, folder=SS.TAKES / "set-stop"):
        self.load = SS.op50()
        super().__init__(folder)
        self.base_at, self.tilt, self.in_hand = [], [], []
        self.carry = next(e for e in self.tk["events"] if e["kind"] == "carry")
        keys = np.load(self.folder / "stop_keys.npz")
        self.keys = (keys["t"], keys["p"])
        grip = next(e for e in self.grip_events if e["grip"] == SS.GRIP)
        # the eye steers the stop (held_error) from when it is up off the table until it is let go, and leaves the hand
        # be from letting go until the hand is up off it, as setting the parallels
        self.steer = (self.keys[0][1], grip["t1"])
        # ... and leaves the hand be while the stop is on the table, as the parallels' runner does in their slots
        self.still = [(grip["t0"], self.keys[0][1]), (grip["t1"], grip["t1"] + 0.8)]
        self._now = 0.0
        self.firm_setup()
        # the stop's weight is fed forward where it hangs, at its middle between the pads, so the wrist is fed the
        # turn it makes about it too: fed at the wrist, the wrist sagged 3 deg under it (sight held the stop up), and
        # let go the hand sprang back 4 mm up and forward, the thumb into the stop
        g = json.loads((self.folder / "grips.json").read_text(encoding="utf-8"))[SS.GRIP]
        self.HAND_FORCE_AT = np.array(g["H"]).T @ (np.array(g["obj"]) - np.array(g["W"]))

    def carry_of(self, grip_event: dict) -> dict:
        return self.carry

    def planned_centre(self, t: float) -> np.ndarray:
        """Where the plan has the stop's middle (mm) at t (motion/set_stop.py, its keys)."""
        ts, ps = self.keys
        if t <= ts[0]:
            return ps[0]
        for a, b, pa, pb in zip(ts, ts[1:], ps, ps[1:]):
            if a <= t < b:
                return pa + (pb - pa) * min_jerk((t - a) / (b - a))
        return ps[-1]

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """The eye on the stop: where its middle is against the plan, and whether it stands upright (its turn about
        the vertical is left to the hand, as the parallels')."""
        self._now = t
        if side != "R" or not self.steer[0] <= t < self.steer[1]:
            return None
        m, d = self.model, self.data
        b = m.body("stop").id
        z = d.xmat[b].reshape(3, 3)[:, 2]
        axis = np.cross(z, [0.0, 0.0, 1.0])
        s = np.linalg.norm(axis)
        upright = axis / s * np.arctan2(s, z[2]) if s > 1e-9 else np.zeros(3)
        return np.r_[self.planned_centre(t) * 0.001 - d.xpos[b], upright] * EYE_RATE

    def touching(self, side: str) -> bool:
        if side == "R" and (any(a <= self._now < b for a, b in self.still) or self.fast(self._now)):
            return True
        return super().touching(side)

    def scene(self, body_xml: str) -> str:
        xml = cell.with_body(body_xml, self.load.stage, {}, "R_hand", self.load, stop_mm=V.STOP_HOME)
        return xml.replace("<worldbody>\n", "<worldbody>\n" + RACK.xml(), 1)

    def start(self) -> None:
        """The table at the loading spot, the doors open, the vise open at the load's opening and locked, the stop
        free on the table."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in ("door_left", "door_right"):
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0] = d.qpos[m.jnt_qposadr[m.joint("crank").id]]
        d.eq_active[lock] = 1
        d.eq_active[m.equality("keep_stop").id] = 0     # the keeper holds it in the vise for the load take
        a = m.jnt_qposadr[m.joint("stop").id]
        d.qpos[a + 3:a + 7] = [np.cos(SS.YAW / 2), 0.0, 0.0, np.sin(SS.YAW / 2)]

    def planned_relpose(self, grip):
        """As the parallels': the hand holds it at the grip's planned turn, about where its base stands."""
        m, d, p = self.model, self.data, self.plan
        hb, ob = m.body("R_hand").id, m.body("stop").id
        R_rel = SP.turned(SS.YAW).T @ p.xmat[hb].reshape(3, 3)
        R_obj = d.xmat[hb].reshape(3, 3) @ R_rel.T
        half = np.array([0.0, 0.0, V.STOP_MM[2] / 2 * 0.001])
        base = d.xpos[ob] - d.xmat[ob].reshape(3, 3) @ half
        return R_obj.T @ (d.xpos[hb] - (base + R_obj @ half)), R_rel

    def hand_force(self, side, t):
        """The stop's weight, carried: taken up over people's loading time, as the parallels' (sim/set_parallels.py)."""
        if side == "R" and self.carry["t0"] <= t < self.carry["t1"]:
            return np.array([0.0, 0.0, V.STOP_KG * 9.81 * min(1.0, (t - self.carry["t0"]) / SP.LOADING_S)])
        return None

    def meshes(self, folder):
        return V.render_meshes(self.load, folder)

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        hb, b = m.body("R_hand").id, m.body("stop").id
        R = d.xmat[b].reshape(3, 3)
        self.base_at.append((d.xpos[b] - R[:, 2] * V.STOP_MM[2] / 2 * 0.001) * 1000)
        self.tilt.append(float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))))
        self.in_hand.append(d.xmat[hb].reshape(3, 3).T @ (d.xpos[b] - d.xpos[hb]) * 1000)

    def outcome(self) -> dict:
        t = np.arange(len(self.base_at)) / self.fps
        B, Hh, e = np.array(self.base_at), np.array(self.in_hand), self.carry
        carried = (t >= e["t0"] + 0.2) & (t < e["t1"] - 0.2)
        ref = Hh[np.argmax(carried)]
        return {"off_mm": [round(float(v), 2) for v in B[-1] - self.load.stop()],
                "tilt_deg": round(self.tilt[-1], 2),
                "lifted_mm": round(float(B[:, 2].max() - B[0, 2]), 1),
                "max_slip_mm": round(float(np.linalg.norm(Hh[carried] - ref, axis=1).max()), 2)}


def main(argv: list[str]) -> int:
    r = SetStop()
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("set-stop", out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
