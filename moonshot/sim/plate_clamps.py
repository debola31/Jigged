"""The physics of swinging step clamps on their studs (moonshot/motion/plate_clamps.py; the Clamp it down step,
moonshot/motion/plate_seat.py): the VF-2 cell set up for the plate (moonshot/world/spoilboard.py), its doors open,
the plate on the spoilboard, each clamp a take moves a free body on its stud. The pinch holds a clamp by a declared
soft constraint while it is carried (carry_<clamp>, as the parallels' and the stop's, sim/set_parallels.py FirmGrip);
the eye steers it along its planned path in the air, and the physics decides where it lands.

    python -m moonshot.sim.plate_clamps ll-1005337-op10-seat     # runs the take in the data root's takes/
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import plate_clamps as PC
from moonshot.motion import plates
from moonshot.sim.door_cycle import NEVER_HELD
from moonshot.sim.record import glbs_in_bodies
from moonshot.sim.runner import TakeRunner
from moonshot.sim.set_parallels import FirmGrip
from moonshot.world import cell, vf2
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
DOORS = ("door_left", "door_right")
DOORS_OPEN_MM = 600.0


class PlateClamps(FirmGrip, TakeRunner):
    station = "vf2"
    never_held = NEVER_HELD
    TORQUESCALE = 5.0            # a 0.3 kg strap pinched by one end: held as firmly in turn as in place, as the parallels

    def __init__(self, folder):
        tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.table = tk["table"]
        self.plate = plates.plate(self.table["part"], self.table["setup"])
        self.clamps = plates.clamps(self.table["part"], self.table["setup"])
        self.free = tuple(self.table["free"])
        self.encloses = {f"pinch_{n}": n for n in self.free}
        self.welded = set(self.encloses)
        super().__init__(folder)
        self.firm_setup()
        self.carry = {e["obj"]: e for e in self.tk["events"] if e["kind"] == "carry"}
        k = np.load(self.folder / "clamp_keys.npz")
        self.keys = {n: list(zip(k[f"{n}_t"], k[f"{n}_R"], k[f"{n}_p"])) for n in self.free if f"{n}_t" in k.files}
        self.pose_at = {n: [] for n in self.free}
        self.in_hand = {n: [] for n in self.free}
        self._now = 0.0

    def scene(self, body_xml: str) -> str:
        return SB.with_body(body_xml, self.plate, self.clamps, self.table["state"], self.free, nuts=())

    def start(self) -> None:
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = DOORS_OPEN_MM * 0.001

    def glbs(self):
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def carry_of(self, grip_event: dict) -> dict:
        return self.carry[grip_event["on"]]

    def planned(self, name: str, t: float) -> tuple[np.ndarray, np.ndarray]:
        return PC.key_at(self.keys[name], t)

    def held_error(self, side: str, t: float):
        """While a clamp is carried, the eye is on it: its middle and its turn against the plan (its keys)."""
        self._now = t
        m, d = self.model, self.data
        held = next((n for n, e in self.carry.items() if e["side"] == side and e["t0"] <= t < e["t1"]), None)
        if held is None:
            return None
        R, p = self.planned(held, t)
        b = m.body(held).id
        return np.r_[p * 0.001 - d.xpos[b], Rotation.from_matrix(R @ d.xmat[b].reshape(3, 3).T).as_rotvec()]

    def firm_setup(self) -> None:
        super().firm_setup()
        self._speed = {s: np.linalg.norm(np.gradient(self.rd[f"{s}_W"], 1.0 / self.fps, axis=0), axis=1)
                       for s in ("R", "L")}

    def fast_side(self, side: str, t: float) -> bool:
        v = self._speed[side]
        return bool(v[min(len(v) - 1, int(round(t * self.fps)))] > 250.0)       # as FirmGrip.fast, either hand

    def touching(self, side: str) -> bool:
        if self.fast_side(side, self._now):
            return True
        return super().touching(side)

    def before_step(self, t: float) -> None:
        """FirmGrip's: each gripping hand keeps its grip's shape from as the carry closes until off the strap, here
        for either hand (FirmGrip's is the right's alone); then the machine's control."""
        from moonshot.sim.set_parallels import COUPLE_EASE_S, COUPLE_HOLD_S, COUPLE_OFF_S
        from moonshot.motion.primitives import min_jerk
        m = self.model
        for side in ("R", "L"):
            w, grip = 0.0, None
            for e in self.grip_events:
                if e["side"] != side:
                    continue
                t_c, t_off = e["t0"] + 0.1, e["t1"] + COUPLE_HOLD_S
                on = min_jerk((t - (t_c - COUPLE_EASE_S)) / COUPLE_EASE_S) * (1 - min_jerk((t - t_off) / COUPLE_OFF_S))
                if on > w:
                    w, grip = on, e["grip"]
            for i, cp in enumerate(self._couplings):
                c = cp.c + (w * self._grip_c[grip][i] if grip else 0.0)
                jf, jl = self.body.joints[f"{side}_{cp.follower}"], self.body.joints[f"{side}_{cp.leader}"]
                eq = m.equality(f"couple_{side}_{cp.follower}").id
                m.eq_data[eq, 0] = math.radians(cp.k * jl.rest + c - jf.rest)
                m.eq_data[eq, 1] = cp.k
        self.ctl.apply()

    def hand_force(self, side, t):
        """The strap's weight, carried, taken up over people's loading time (as the parallels')."""
        e = next((e for e in self.carry.values() if e["side"] == side and e["t0"] <= t < e["t1"]), None)
        if e is None:
            return None
        from moonshot.motion import set_parallels as SP
        return np.array([0.0, 0.0, SB.clamp_kg() * 9.81 * min(1.0, (t - e["t0"]) / SP.LOADING_S)])

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        for n in self.free:
            b = m.body(n).id
            R = d.xmat[b].reshape(3, 3)
            self.pose_at[n].append((d.xpos[b] * 1000, math.atan2(R[1, 0], R[0, 0]), float(np.degrees(np.arccos(
                np.clip(R[2, 2], -1, 1))))))
            side = self.carry[n]["side"] if n in self.carry else "R"
            hb = m.body(f"{side}_hand").id
            self.in_hand[n].append(d.xmat[hb].reshape(3, 3).T @ (d.xpos[b] - d.xpos[hb]) * 1000)

    def outcome(self) -> dict:
        out = {}
        t = np.arange(len(next(iter(self.pose_at.values())))) / self.fps
        for c in self.clamps:
            if c.name not in self.free:
                continue
            p_end, yaw_end, tilt = self.pose_at[c.name][-1]
            want, _ = c.pose("clamped")
            e = self.carry.get(c.name)
            o = {"off_mm": [round(float(v), 2) for v in p_end - want],
                 "yaw_off_deg": round(math.degrees((yaw_end - c.yaw + math.pi) % (2 * math.pi) - math.pi), 2),
                 "tilt_deg": round(tilt, 2)}
            if e is not None:
                Hh = np.array(self.in_hand[c.name])
                carried = (t >= e["t0"] + 0.2) & (t < e["t1"] - 0.2)
                o["max_slip_mm"] = round(float(np.linalg.norm(Hh[carried] - Hh[np.argmax(carried)], axis=1).max()), 2)
            out[c.name] = o
        b = self.data.body("blank").xpos * 1000
        out["plate_off_mm"] = [round(float(v), 2) for v in b - self.plate.centre]
        return out


def main(argv: list[str]) -> int:
    r = PlateClamps(TAKES / argv[0])
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(argv[0], json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
