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
from moonshot.motion.primitives import min_jerk
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
        self.carry = {e["obj"]: e for e in self.tk["events"] if e["kind"] == "carry"}
        keys = np.load(self.folder / "parallel_keys.npz")
        self.keys = {n: (keys[f"{n}_t"], keys[f"{n}_p"]) for n in SP.ORDER}
        grips = {e["grip"]: e for e in self.grip_events}
        # the eye leaves the hand be while the parallel is in its slot, where pulling the hand onto its plan drags it
        # into the slot's walls, and from letting go until the hand is up off it, where pulling the hand back onto its
        # plan (15 mm off it, as the eye steered the parallel) would sweep the open fingers into it. Out of the slot it
        # steers the parallel (held_error), down onto the seat and on it until it is let go: left be once it touched,
        # it was dragged 3 mm across the seat by the planned hand's last slight turning
        self.steer = {n: (self.keys[n][0][1], grips[SP.GRIP[n]]["t1"]) for n in SP.ORDER}
        self.still = [(grips[SP.GRIP[n]]["t0"], self.keys[n][0][1]) for n in SP.ORDER]
        self.still += [(grips[SP.GRIP[n]]["t1"], grips[SP.GRIP[n]]["t1"] + 0.8) for n in SP.ORDER]
        self._now = 0.0

    def planned_centre(self, name: str, t: float) -> np.ndarray:
        """Where the plan has the parallel's middle (mm) at t (motion/set_parallels.py, its keys)."""
        ts, ps = self.keys[name]
        if t <= ts[0]:
            return ps[0]
        for a, b, pa, pb in zip(ts, ts[1:], ps, ps[1:]):
            if a <= t < b:
                return pa + (pb - pa) * min_jerk((t - a) / (b - a))
        return ps[-1]

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """In free air the eye is on the parallel: where its middle is, and whether it stands upright, against the plan,
        so a grip closed a few mm off doesn't set it down that far off, and the planned hand's own slight turning on the
        way (7 deg) doesn't set it down leaning. Its turn about the vertical is left to the hand: the arm can't turn the
        hand that way much here, and asking it to wound the correction up to its limit, the fingers into the jaw."""
        self._now = t
        m, d = self.model, self.data
        held = next((n for n in SP.ORDER if self.steer[n][0] <= t < self.steer[n][1]), None)
        if side != "R" or held is None:
            return None
        b = m.body(held).id
        z = d.xmat[b].reshape(3, 3)[:, 2]
        axis = np.cross(z, [0.0, 0.0, 1.0])
        s = np.linalg.norm(axis)
        upright = axis / s * np.arctan2(s, z[2]) if s > 1e-9 else np.zeros(3)
        return np.r_[self.planned_centre(held, t) * 0.001 - d.xpos[b], upright]

    def touching(self, side: str) -> bool:
        if side == "R" and any(a <= self._now < b for a, b in self.still):
            return True
        return super().touching(side)

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
            a = m.jnt_qposadr[m.joint(n).id]
            d.qpos[a + 3:a + 7] = [np.cos(RACK.YAW / 2), 0.0, 0.0, np.sin(RACK.YAW / 2)]   # turned with the rack

    def planned_relpose(self, grip):
        """The pinch squares the parallel to the pads, as two flat faces pressed between fingertips do: the hand holds
        it at the grip's planned turn, about where its base stands when the fingers close. Its base stays put, so it
        only stands up in its slot, not dragged sideways by the hand's few mm of error (the whole planned pose jammed it
        in the slot; turned about its middle, its foot swung into the slot's wall); as closed, it was carried leaning
        10-18 deg and set down on an edge."""
        m, d, p = self.model, self.data, self.plan
        hb, ob = m.body("R_hand").id, m.body(self.encloses[grip]).id
        R_rel = SP.turned(RACK.YAW).T @ p.xmat[hb].reshape(3, 3)   # the hand in the parallel's frame, as planned: it
                                                                    # stands upright, turned with the rack
        R_obj = d.xmat[hb].reshape(3, 3) @ R_rel.T
        half = np.array([0.0, 0.0, self.load.parallel_h / 2 * 0.001])
        base = d.xpos[ob] - d.xmat[ob].reshape(3, 3) @ half
        return R_obj.T @ (d.xpos[hb] - (base + R_obj @ half)), R_rel

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
