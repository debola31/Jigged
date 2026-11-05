"""The physics of setting step clamps on their studs and turning their nuts with the wrench (moonshot/motion/
plate_clamps.py and plate_wrench.py; the Clamp it down step, moonshot/motion/plate_seat.py): the VF-2 cell set up for
the plate (moonshot/world/spoilboard.py), its doors open, the plate on the spoilboard, each clamp a take moves a free
body on its stud, its nut on its thread (clamp_thread_<i>), and the wrench lying on the plate. The pinch holds a
clamp, or the wrench, by a declared soft constraint while it is carried (carry_<clamp>, carry_wrench, as the
parallels' and the stop's, sim/set_parallels.py FirmGrip); the eye steers it along its planned path, turns the
wrench's box end onto a nut's flats where they really are, and the physics decides where a clamp lands and how far a
nut turns.

    python -m moonshot.sim.plate_clamps ll-1005337-op10-set-clamps     # runs the take in the data root's takes/
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
from moonshot.world import wrench as WR

TAKES = data_root() / "takes"
DOORS = ("door_left", "door_right")
DOORS_OPEN_MM = 600.0
WRENCH_PUSH_MM = 2.0         # the eye pushes the wrench's box end down onto a nut by at most this much error


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
        self.nuts = tuple(self.table.get("nuts", self.free))    # nuts on their threads, turned by hand
        self.nut_up = self.table.get("nut_up")                  # ... starting this far over the clamped strap
        self.wrench = self.table.get("wrench")                  # where the wrench lies, if the take uses it
        self.encloses = {f"pinch_{n}": n for n in self.free} | ({"wrench_R": "wrench"} if self.wrench else {}) \
            | self.more_encloses()
        self.welded = set(self.encloses)
        super().__init__(folder)
        self.firm_setup()
        # each carry (the wrench may be carried more than once: picked up, laid down, picked up again)
        self.carries = [e for e in self.tk["events"] if e["kind"] == "carry" and e["obj"] != "blank"]
        self.carry = {e["obj"]: e for e in self.carries}
        k = np.load(self.folder / "clamp_keys.npz")
        self.keys = {n: list(zip(k[f"{n}_t"], k[f"{n}_R"], k[f"{n}_p"])) for n in (*self.free, "wrench")
                     if f"{n}_t" in k.files}
        self.pose_at = {n: [] for n in self.free}
        self.in_hand = {n: [] for n in self.free}
        self._now = 0.0

    def more_encloses(self) -> dict:
        """More grips held by a declared constraint, for a step that also carries something else (the plate)."""
        return {}

    def scene(self, body_xml: str) -> str:
        xml = SB.with_body(body_xml, self.plate, self.clamps, self.table["state"], self.free, nuts=self.nuts,
                           nut_up=self.nut_up)
        if self.wrench:
            xml = xml.replace("<worldbody>\n", "<worldbody>\n" + WR.xml("wrench", self.wrench["at"],
                                                                         self.wrench["yaw"]), 1)
        return xml

    def start(self) -> None:
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = DOORS_OPEN_MM * 0.001

    def glbs(self):
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def carry_of(self, grip_event: dict) -> dict:
        return next(e for e in self.carries if e["obj"] == grip_event["on"] and e["side"] == grip_event["side"]
                    and grip_event["t0"] <= e["t0"] <= grip_event["t1"])

    def carrying(self, side: str, t: float) -> dict | None:
        """The carry the side's hand is in at t, if any."""
        return next((e for e in self.carries if e["side"] == side and e["t0"] <= t < e["t1"]), None)

    def planned(self, name: str, t: float) -> tuple[np.ndarray, np.ndarray]:
        return PC.key_at(self.keys[name], t)

    def held_error(self, side: str, t: float):
        """While a clamp or the wrench is carried, the eye is on it: its middle and its turn against the plan (its
        keys). The wrench's box end, over a nut and not swinging, is turned onto the nut's flats where they really are;
        and over a nut the eye never pushes it down more than WRENCH_PUSH_MM: come down on the hex's top, it is felt,
        not seen, and set down harder it was pinned there, off the flats, and slid off onto the clamp."""
        self._now = t
        m, d = self.model, self.data
        e = self.carrying(side, t)
        if e is None:
            return None
        held = e["obj"]
        R, p = self.planned(held, t)
        over = held == "wrench" and self.nut_under(p)
        if over and not self.swinging(t):
            R = self.onto_flats(R, p) @ R
        b = m.body(held).id
        err = np.r_[p * 0.001 - d.xpos[b], Rotation.from_matrix(R @ d.xmat[b].reshape(3, 3).T).as_rotvec()]
        if over:
            err[2] = max(err[2], -WRENCH_PUSH_MM * 0.001)
        return err

    def nut_under(self, p: np.ndarray):
        """The clamp whose nut the wrench's planned box end (middle p mm) is over, if any."""
        return next((c for c in self.clamps if c.name in self.nuts and np.linalg.norm(p[:2] - np.asarray(c.stud)) < 5.0),
                    None)

    def swinging(self, t: float) -> bool:
        """Is the wrench's planned turn changing at t (a stroke's swing, or its swing back in the air)?"""
        k = self.keys["wrench"]
        i = next((i for i in range(len(k) - 1) if k[i][0] <= t < k[i + 1][0]), None)
        return i is not None and not np.allclose(k[i][1], k[i + 1][1], atol=1e-9)

    def stroking(self, side: str, t: float) -> bool:
        """Is the side's hand swinging the wrench's handle with its box end on a nut (a stroke, turn_nut)?"""
        return any(e["kind"] == "turn_nut" and e["side"] == side and e["t0"] <= t < e["t1"] for e in self.tk["events"])

    def onto_flats(self, R: np.ndarray, p: np.ndarray) -> np.ndarray:
        """The turn about z that brings the wrench's planned box end (frame R, middle p mm) square on the flats of the
        nut it is over, as the nut stands now: its walls face in at 30 + 60k deg from its yaw, the nut's flats out at
        30 + 60k deg from its turn (moonshot/world/wrench.py boxes, spoilboard._nut_geoms); none away from a nut."""
        m, d = self.model, self.data
        c = self.nut_under(p)
        if c is None:
            return np.eye(3)
        turn = float(d.qpos[m.jnt_qposadr[m.joint(f"{c.name}_nut_turn").id]])
        off = (turn - math.atan2(R[1, 0], R[0, 0]) + math.pi / 6) % (math.pi / 3) - math.pi / 6
        return Rotation.from_rotvec([0.0, 0.0, off]).as_matrix()

    def firm_setup(self) -> None:
        super().firm_setup()
        self._speed = {s: np.linalg.norm(np.gradient(self.rd[f"{s}_W"], 1.0 / self.fps, axis=0), axis=1)
                       for s in ("R", "L")}

    def fast_side(self, side: str, t: float) -> bool:
        v = self._speed[side]
        return bool(v[min(len(v) - 1, int(round(t * self.fps)))] > 250.0)       # as FirmGrip.fast, either hand

    def touching(self, side: str) -> bool:
        """When the eye's steering pauses (TakeRunner.correction): as FirmGrip's while the hand moves fast, either
        hand; while the hand strokes the wrench on a nut, as on a mechanism's handle (the vise's crank): the nut, not
        the eye, says where the box end goes, and steered there the eye wound up against it and the hand flailed once
        the box end came off. Otherwise, while the hand carries a clamp or the wrench, the eye keeps steering it
        whatever the hand brushes: paused by a little finger's touch on the spoilboard (0.7 N) through a carry, the
        left hand's 11 mm lag stood and the strap stalled 17 mm short of its place and fell back off the plate."""
        if self.fast_side(side, self._now) or self.stroking(side, self._now):
            return True
        if self.carrying(side, self._now) is not None:
            return False
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
        """The strap's weight or the wrench's, carried, taken up over people's loading time (as the parallels')."""
        e = self.carrying(side, t)
        if e is None:
            return None
        from moonshot.motion import set_parallels as SP
        kg = WR.kg() if e["obj"] == "wrench" else SB.clamp_kg()
        return np.array([0.0, 0.0, kg * 9.81 * min(1.0, (t - e["t0"]) / SP.LOADING_S)])

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        for n in self.nuts:                                     # each nut's run (mm, down negative) and turn (deg)
            sl, tu = m.joint(f"{n}_nut_slide"), m.joint(f"{n}_nut_turn")
            self.__dict__.setdefault("nut_at", {}).setdefault(n, []).append(
                (float(d.qpos[m.jnt_qposadr[sl.id]]) * 1000, math.degrees(float(d.qpos[m.jnt_qposadr[tu.id]]))))
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
        t = np.arange(len(self.recorder.hands["R"]["W"])) / self.fps
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
        for n, rows in getattr(self, "nut_at", {}).items():
            run, turn = rows[-1]
            clamp = next(c for c in self.clamps if c.name == n)
            up0 = (self.nut_up or {}).get(n, clamp.nut_z(self.table["state"]) - clamp.nut_z("clamped"))
            out[f"{n}_nut"] = {"run_mm": round(run, 3), "turn_deg": round(turn, 1),
                               "over_strap_mm": round(up0 + run, 3)}
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
