"""The physics of setting step clamps on their studs and turning their nuts with the wrench (moonshot/motion/
plate_clamps.py and plate_wrench.py; the Clamp it down step, moonshot/motion/plate_seat.py): the VF-2 cell set up for
the plate (moonshot/world/spoilboard.py), its doors open, the plate on the spoilboard, each clamp a take moves a free
body on its stud, its nut on its thread (clamp_thread_<i>), and the ratcheting wrench lying on the plate, its ring on
the ratchet's hinge in its head, the pawl the hinge's limit (pawl, moonshot/world/wrench.py). The pinch holds a
clamp, or the wrench, by a declared soft constraint while it is carried (carry_<clamp>, carry_wrench_<side>, as the
parallels' and the stop's, sim/set_parallels.py FirmGrip); the eye steers it along its planned path, turns the
wrench's box end onto a nut's flats where they really are, and the physics decides where a clamp lands and how far a
nut turns.

    python -m moonshot.sim.plate_clamps ll-1005337-op10-set-clamps-left    # runs the take in the data root's takes/
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
WRENCH_TURN_SCALE = 0.02     # the wrench's weld's turn against its place while the hand strokes it (MuJoCo's torquescale)
STRAP_TURN_GAIN = 3.0        # a strap's turn off its place, as the eye lines it up on its slot, weighed this many times
                             # the eye's own (a radian as 100 mm, moonshot/sim/runner.py correction): at its own, a near
                             # strap's 1.6 deg turn off on its way over the plate's end came out 1.1 deg past it as it
                             # went down, where its place is 1 deg


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
        # the wrench in each end's own hand in turn (moonshot/motion/plate_wrench.py use_ends), each hand's weld its
        # own (eq_name)
        self.encloses = {f"pinch_{n}": n for n in self.free} \
            | ({"wrench_R": "wrench", "wrench_L": "wrench"} if self.wrench else {}) | self.more_encloses()
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
        self.wrench_sides = sorted({e["side"] for e in self.grip_events if e["grip"].startswith("wrench_")})

    def more_encloses(self) -> dict:
        """More grips held by a declared constraint, for a step that also carries something else (the plate)."""
        return {}

    def eq_name(self, grip: str) -> str:
        """Each hand's weld on the wrench its own, carry_wrench_R and carry_wrench_L: the hands take it in turn."""
        return f"carry_wrench_{grip[-1]}" if grip.startswith("wrench_") else super().eq_name(grip)

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

    def export(self, folder=None) -> None:
        """The runner's take record, and in checks.json (moves_with) the wrench's ring riding with the wrench, as a
        caliper's slider on its beam (moonshot/sim/bench.py): the ring is the wrench's, in its head."""
        if self.wrench:
            self.checks["moves_with"] = {"wrench": ["wrench_ring"], "wrench_ring": ["wrench"]}
        super().export(folder)

    def glbs(self):
        """The machine's links, and the wrench's body and ring from its model (moonshot/library/generators.py
        ratchet_wrench, its parts in the wrench's own frame), stored Y up: the turn to Z up in each in_body."""
        out = glbs_in_bodies(self.model, "vf2", vf2.render_links())
        if self.wrench:
            for body, part in (("wrench", "ratchet_wrench"), ("wrench_ring", "ratchet_wrench_ring")):
                out[body] = [{"path": f"{WR.LINKS}/{part}.glb", "in_body": WR.Y_UP_IN_BODY, "link": part}]
        return out

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
        not seen, and set down harder it was pinned there, off the flats, and slid off onto the clamp. The turn onto the
        next nut's flats is eased in over the carry to it (to_flats), as a hand lines a wrench up on its way to the nut:
        turned there only over the nut, up to 30 deg at once, it swung the box end 25-57 mm off the nut. The wrench is
        turned about its box end: the eye's turn of the hand, which holds it 135 mm along its handle, comes with the
        hand's move that keeps the box end where it is."""
        self._now = t
        m, d = self.model, self.data
        e = self.carrying(side, t)
        if e is None:
            return None
        held = e["obj"]
        R, p = self.planned(held, t)
        over = held == "wrench" and self.nut_under(p)
        if held == "wrench" and not self.stroking(side, t):
            R = self.to_flats(side, t, R) @ R
        b = m.body(held).id
        turn = Rotation.from_matrix(R @ d.xmat[b].reshape(3, 3).T).as_rotvec()
        err = np.r_[p * 0.001 - d.xpos[b], turn]
        if held == "wrench":
            hb = m.body(f"{side}_hand").id
            err[:3] += np.cross(turn, d.xpos[hb] - d.xpos[b])         # the hand's move for a turn about the box end
        else:
            err[3:] *= STRAP_TURN_GAIN
        if over:
            err[2] = max(err[2], -WRENCH_PUSH_MM * 0.001)
        return err

    def nut_under(self, p: np.ndarray):
        """The clamp whose nut the wrench's planned box end (middle p mm) is over, if any."""
        return next((c for c in self.clamps if c.name in self.nuts and np.linalg.norm(p[:2] - np.asarray(c.stud)) < 5.0),
                    None)

    def working(self, side: str, t: float) -> dict | None:
        """The side's hand's work on a nut at t, its box end on it, stroking (work_nut), if any."""
        return next((e for e in self.tk["events"] if e["kind"] == "work_nut" and e["side"] == side
                     and e["t0"] <= t < e["t1"]), None)

    def stroking(self, side: str, t: float) -> bool:
        """Is the side's hand swinging the wrench's handle, or swinging it back, its box end on a nut?"""
        return self.working(side, t) is not None

    def ratchet_q(self) -> float:
        m, d = self.model, self.data
        return float(d.qpos[m.jnt_qposadr[m.joint("wrench_ratchet").id]])

    def onto_flats(self, R: np.ndarray, c: SB.Clamp) -> float:
        """The turn about z (rad) that brings the wrench's planned head (frame R) square on the flats of a clamp's nut,
        as the nut stands now: the ratchet ring's twelve points fit the nut every 30 deg from its yaw (the head's and
        the ratchet's), the nut's flats out at 30 + 60k deg from its turn (moonshot/world/wrench.py ring_boxes,
        spoilboard._nut_geoms): no more than 15 deg either way."""
        m, d = self.model, self.data
        turn = float(d.qpos[m.jnt_qposadr[m.joint(f"{c.name}_nut_turn").id]])
        ring = math.atan2(R[1, 0], R[0, 0]) + self.ratchet_q()
        fit = 2 * math.pi / WR.POINTS
        return (turn - ring + fit / 2) % fit - fit / 2

    def to_flats(self, side: str, t: float, R: np.ndarray) -> np.ndarray:
        """The turn onto the flats of the next nut the side's hand works (onto_flats), eased in (min-jerk) from as the
        wrench comes up off the last nut, or off the plate, to as its box end is held over the next, and whole from
        then until its work starts; none with no nut to come."""
        from moonshot.motion import plate_wrench as PW
        from moonshot.motion.primitives import min_jerk
        works = sorted((w for w in self.tk["events"] if w["kind"] == "work_nut" and w["side"] == side),
                       key=lambda w: w["t0"])
        nxt = next((w for w in works if w["t0"] > t), None)
        if nxt is None:
            return np.eye(3)
        before = [w for w in works if w["t1"] <= t]
        carry = self.carrying(side, t)
        t_from = before[-1]["t1"] + PW.UP_S if before else carry["t0"]
        t_to = nxt["t0"] - PW.DWELL_S - PW.DOWN_S - PW.OVER_S
        s = float(np.clip(min_jerk(np.clip((t - t_from) / max(t_to - t_from, 1e-6), 0.0, 1.0)), 0.0, 1.0))
        c = next(k for k in self.clamps if f"{k.name}_nut" == nxt["obj"])
        return Rotation.from_rotvec([0.0, 0.0, s * self.onto_flats(R, c)]).as_matrix()

    def pawl(self, t: float) -> None:
        """The ratchet's pawl: the ring's hinge in the head limited, while the box end works a nut, on the side it
        drives, at where the ring last stood that way (tightening, the head turning clockwise from above, the ring
        held from turning back in it, ratchet_q no higher; loosening, no lower), and free the other way, so the handle
        swung back leaves the ring on the nut; off a nut, the ring held where it stands in the head."""
        m = self.model
        j = m.joint("wrench_ratchet").id
        q = self.ratchet_q()
        e = next((w for w in (self.working(s, t) for s in self.wrench_sides) if w is not None), None)
        if e is None:
            if self._pawl is not None or self._lock is None:      # held where it stood as the box end came off
                self._lock = q
            self._pawl = None
            m.jnt_range[j] = [self._lock - 1e-5, self._lock + 1e-5]
            return
        if self._pawl is None:
            self._pawl = q
        if e["direction"] == "tighten":
            self._pawl = min(self._pawl, q)
            m.jnt_range[j] = [-1e3, self._pawl]
        else:
            self._pawl = max(self._pawl, q)
            m.jnt_range[j] = [self._pawl, 1e3]

    def enclose(self, t: float) -> None:
        """FirmGrip's, and while the hand works the wrench on a nut its weld holds the handle at the pinch, turning
        freely in it (WRENCH_TURN_SCALE), as a wrench's handle turns in the fist: the box end on the nut, the nut and
        the hand say how it stands. Held stiffly in turn through a stroke, the arm, a little behind its arc about the
        stud, turned the hand off it and tipped the box end 20-30 deg up off the nut."""
        super().enclose(t)
        from moonshot.motion import plate_wrench as PW
        m, d = self.model, self.data
        for side in self.wrench_sides:
            eq = m.equality(self.eq_name(f"wrench_{side}")).id
            if not d.eq_active[eq]:
                self._stroke_anchor[side] = None
                continue
            stroking = self.stroking(side, t)
            if stroking and self._stroke_anchor.get(side) is None:
                hb, wb = m.body(f"{side}_hand").id, m.body("wrench").id
                pinch = d.xpos[wb] + d.xmat[wb].reshape(3, 3) @ PW.grab_at() * 0.001
                # the weld's point (MuJoCo's eq_data: 0:3 in the hand, body2; 3:6 the same point in the wrench,
                # body1) moved from the hand's origin to the pinch, where they are now
                self._stroke_anchor[side] = m.eq_data[eq, 3:6].copy()
                m.eq_data[eq, 0:3] = d.xmat[hb].reshape(3, 3).T @ (pinch - d.xpos[hb])
                m.eq_data[eq, 3:6] = PW.grab_at() * 0.001
                m.eq_data[eq, 10] = WRENCH_TURN_SCALE
            elif not stroking and self._stroke_anchor.get(side) is not None:
                m.eq_data[eq, 0:3] = 0.0
                m.eq_data[eq, 3:6] = self._stroke_anchor[side]
                m.eq_data[eq, 10] = self.TORQUESCALE
                self._stroke_anchor[side] = None

    def firm_setup(self) -> None:
        super().firm_setup()
        self._stroke_anchor: dict[str, np.ndarray | None] = {}
        self._pawl = self._lock = None
        self._speed = {s: np.linalg.norm(np.gradient(self.rd[f"{s}_W"], 1.0 / self.fps, axis=0), axis=1)
                       for s in ("R", "L")}

    def fast_side(self, side: str, t: float) -> bool:
        v = self._speed[side]
        return bool(v[min(len(v) - 1, int(round(t * self.fps)))] > 250.0)       # as FirmGrip.fast, either hand

    def touching(self, side: str) -> bool:
        """When the eye's steering pauses (TakeRunner.correction): as FirmGrip's while the hand moves fast, either
        hand; while the hand strokes the wrench on a nut, as on a mechanism's handle (the vise's crank): the nut, not
        the eye, says where the box end goes, and steered there the eye wound up against it and the hand flailed once
        the box end came off (steered onto the hand's own plan instead, the hand flailed on the near nut's first
        strokes, and the wrench dragged the plate). Otherwise, while the hand carries a clamp or the wrench, the eye
        keeps steering it whatever the hand brushes: paused by a little finger's touch on the spoilboard (0.7 N)
        through a carry, the left hand's 11 mm lag stood and the strap stalled 17 mm short of its place and fell back
        off the plate."""
        if self.fast_side(side, self._now) or self.stroking(side, self._now):
            return True
        if self.carrying(side, self._now) is not None:
            return False
        return super().touching(side)

    def before_step(self, t: float) -> None:
        """FirmGrip's: each gripping hand keeps its grip's shape from as the carry closes until off the strap, here
        for either hand (FirmGrip's is the right's alone); the wrench's pawl (pawl); then the machine's control."""
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
        if self.wrench:
            self.pawl(t)
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
            up0 = (self.nut_up or {}).get(n, clamp.nut_z(SB.state_of(self.table["state"], clamp))
                                          - clamp.nut_z("clamped"))
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
