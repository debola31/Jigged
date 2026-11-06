"""The physics of laying the plate down (moonshot/motion/plate_load.py): the VF-2 cell set up for the plate
(moonshot/world/spoilboard.py), its doors open and the clamps parked, the plate a free body starting in both hands.
Each hand holds it by a declared soft constraint from the first frame (carry_blank_R, carry_blank_L: the carry_*
grip assist, a weld per hand on the one plate), the arms fed half its weight each while it is carried; the eye
steers it along its planned path; it is let go just over the spoilboard, the fingers drawn out from under it, and
the physics decides where it lies.

    python -m moonshot.sim.plate_load ll-1005337-op10-lay-plate     # runs the take in the data root's takes/
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import plate_load as PL
from moonshot.motion import plates
from moonshot.motion.primitives import min_jerk
from moonshot.sim.door_cycle import NEVER_HELD
from moonshot.sim.record import glbs_in_bodies
from moonshot.sim.runner import TakeRunner
from moonshot.world import cell, vf2
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
DOORS = ("door_left", "door_right")
DOORS_OPEN_MM = 600.0
TORQUESCALE = 20.0
WELD_SOLREF, WELD_SOLIMP = (0.002, 1.0), (0.98, 0.995, 0.001)   # (at 0.95-0.99, held from underneath, the plate
                                                                 # settling at the lowering's end sagged in the hands
                                                                 # onto the fingertips under its ends, 3.9-4.1 mm in it)
DRAW_S = 0.85                # the fingers drawn out from under a plate's end (motion/plate_load.py's let-go)
SKIN_FRICTION = 0.6          # the skin's (moonshot/body/skeleton.py), on the plate above the fingers
DRAW_PULL = 1.45             # ... the pull fed forward that many times its drag, to break it free: at its drag alone the
                             # fingers stayed under the plate and the hands drew it back toward the operator 34 mm (at
                             # 1.35, 15 mm); at twice (on the board too), the right wrist's muscles ran 1.33 times
                             # their most, at 1.5 1.12 for a frame
SETTLE_S = 0.3               # a plate let go comes to rest this long after the hands are off it: off the fingers under
                             # its ends, it drops their thickness onto the board


class PlateLoad(TakeRunner):
    station = "vf2"
    never_held = NEVER_HELD
    encloses = {"plate_R": "blank", "plate_L": "blank"}
    welded = {"plate_R", "plate_L"}

    def __init__(self, folder):
        tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.table = tk["table"]
        place = plates.plate(self.table["part"], self.table["setup"])
        self.place = place
        # in the hands at the start, where the planned right hand's grip holds it (motion/plate_load.py in_hands)
        self.in_hands = np.asarray(tk["in_hands"]["p"], float), np.asarray(tk["in_hands"]["R"], float)
        self.plate = SB.Plate(tuple(self.in_hands[0]), place.size_mm, place.density)
        self.clamps = plates.clamps(self.table["part"], self.table["setup"])
        pk = tk["plate_keys"]
        self.keys = list(zip(pk["t"], np.array(pk["p"], float), pk["pitch"]))
        self.HAND_FORCE_AT = np.asarray(tk["hand_force_at"], float)     # the plate's weight's turn fed to the wrists
        super().__init__(folder)
        self.at_t: list[np.ndarray] = []
        self.touched: list[bool] = []             # either hand on the plate, each frame
        self.tilt: list[float] = []
        self.in_hand = {s: [] for s in ("R", "L")}
        self.carry = {e["side"]: e for e in self.tk["events"] if e["kind"] == "carry"}
        self.held_to = {e["side"]: e["t1"] for e in self.grip_events}     # each hand's grip's end, the weld's
        self._now = 0.0

    def eq_name(self, grip: str) -> str:
        """Each hand's weld on the one plate: carry_blank_R and carry_blank_L (moonshot/validate/objects.py reads
        either as the plate's carry)."""
        return f"carry_{self.encloses[grip]}_{grip[-1]}"

    def scene(self, body_xml: str) -> str:
        return SB.with_body(body_xml, self.plate, self.clamps, "parked")

    def weld_stiffly(self) -> None:
        """The runner's welds, each holding the plate's turn TORQUESCALE times as stiffly as its place (MuJoCo's weld
        torquescale): at 1, held by its two ends, the plate's own weight tipped it 57 mm about the line between the
        hands in the first 0.3 s."""
        m = self.model
        for g in self.encloses:
            eq = m.equality(self.eq_name(g)).id
            m.eq_data[eq, 10] = TORQUESCALE
            m.eq_solref[eq] = WELD_SOLREF               # and stiffer than a light tool's: at the runner's, the
            m.eq_solimp[eq, :3] = WELD_SOLIMP           # 7.2 kg plate sagged 5 mm in the hands, onto the fingers

    def start(self) -> None:
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = DOORS_OPEN_MM * 0.001
        a = m.jnt_qposadr[m.body("blank").jntadr[0]]                # the plate turned as the hands hold it
        x, y, z, w = Rotation.from_matrix(self.in_hands[1]).as_quat()
        d.qpos[a + 3:a + 7] = [w, x, y, z]

    def before_step(self, t: float) -> None:
        self.ctl.apply()

    def glbs(self):
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def planned(self, t: float) -> tuple[np.ndarray, float]:
        """The plate's planned middle (mm) and pitch (rad, about x) at t."""
        keys = self.keys
        if t <= keys[0][0]:
            return keys[0][1], keys[0][2]
        for (a, pa, ra), (b, pb, rb) in zip(keys, keys[1:]):
            if a <= t < b:
                w = min_jerk((t - a) / (b - a))
                return pa + (pb - pa) * w, ra + (rb - ra) * w
        return keys[-1][1], keys[-1][2]

    def held_error(self, side: str, t: float):
        """While the plate is held the eye is on it: where it is against its planned path, and how it is turned."""
        m, d = self.model, self.data
        e = self.carry.get(side)
        if e is None or not (e["t0"] <= t < e["t1"]):
            return None
        b = m.body("blank").id
        R = d.xmat[b].reshape(3, 3)
        p, pitch = self.planned(t)
        Rp = Rotation.from_euler("x", pitch).as_matrix()
        return np.r_[p * 0.001 - d.xpos[b], Rotation.from_matrix(Rp @ R.T).as_rotvec()]

    def hand_force(self, side: str, t: float):
        """Half the plate's weight while it's held, acting out at its middle (motion/plate_load.py hand_force_at),
        to the last: until the hand's grip lets go, though the carry (the eye on it) ends as it is set down: unborne
        from then, it dropped 17 mm in the hands. A plate let go onto the fingers under its ends: then each hand's pull
        out from under its end, a little up off the board, against the skin's friction on the plate (DRAW_S): drawn
        out by the arm's tracking alone, the fingers stayed under it, and drew it back toward the operator 32 mm."""
        e = self.carry.get(side)
        if e is None:
            return None
        if e["t0"] <= t < self.held_to[side]:
            return np.array([0.0, 0.0, self.place.mass_kg / 2 * 9.81])
        t0 = self.held_to[side] + PL.UNDER_OPEN_S                 # the hand opened, the thumb off its top, first
        if (self.table.get("under") and t0 <= t < t0 + DRAW_S
                and self.hand_on_plate(side)):                    # pulled while the fingers are still under it: pulled
            out = 1.0 if side == "R" else -1.0                    # on once out, the hands flew 200 mm past the plan
            return np.array([out * DRAW_PULL * SKIN_FRICTION * self.place.mass_kg / 2 * 9.81, 0.0, 0.0])
        return None

    def hand_on_plate(self, side: str) -> bool:
        """Does the side's hand touch the plate?"""
        m, d = self.model, self.data
        b, mine = m.body("blank").id, self.side_bodies[side]
        return any((m.geom_bodyid[c.geom1] == b and m.geom_bodyid[c.geom2] in mine)
                   or (m.geom_bodyid[c.geom2] == b and m.geom_bodyid[c.geom1] in mine) for c in d.contact[:d.ncon])

    def enclose(self, t: float) -> None:
        super().enclose(t)
        self.weld_stiffly()

    def hold_apart(self, body: int, mode: int) -> None:
        """The runner's; but a plate whose ends are held from underneath (take.json table "under") touches the hands
        again as they let go, so it rests on the fingers under its ends and slips off them onto the board as they are
        drawn out: kept apart while they let go, it fell through them (9.5 mm of skin in it)."""
        if mode == 2 and self.table.get("under"):
            mode = 0
        super().hold_apart(body, mode)

    def touching(self, side: str) -> bool:
        """While the plate is carried the eye steers it whatever the hand brushes (the runner pauses the steering
        while an arm touches anything): with the fingers grazing a nut on the way in it was set down 5 mm off, onto a
        parked clamp's nose."""
        e = self.carry.get(side)
        if e is not None and e["t0"] <= self._now < e["t1"]:
            return False
        return super().touching(side)

    def correction(self, t: float):
        self._now = t
        return super().correction(t)

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        b = m.body("blank").id
        self.at_t.append(d.xpos[b] * 1000)
        self.tilt.append(float(np.degrees(np.arccos(np.clip(d.xmat[b].reshape(3, 3)[2, 2], -1, 1)))))
        for s in ("R", "L"):
            hb = m.body(f"{s}_hand").id
            self.in_hand[s].append(d.xmat[hb].reshape(3, 3).T @ (d.xpos[b] - d.xpos[hb]) * 1000)
        self.touched.append(self.hand_on_plate("R") or self.hand_on_plate("L"))

    def let_go_frame(self) -> int:
        """The frame the plate is let go at, come to rest: the later of a second after the carry ends and SETTLE_S
        after the last frame a hand touches it. Laid from underneath, it rests on the fingers under its ends for
        a second or more after the carry, and drops onto the board as they come out."""
        after = int((max(e["t1"] for e in self.carry.values()) + 1.0) * self.fps)
        touched = [k for k, on in enumerate(self.touched) if on]
        off = touched[-1] + int(SETTLE_S * self.fps) if touched else 0
        return min(len(self.at_t) - 1, max(after, off))

    def outcome(self) -> dict:
        t = np.arange(len(self.at_t)) / self.fps
        P = np.array(self.at_t)
        out = {"off_mm": [round(float(v), 2) for v in P[-1] - self.place.centre],
               "tilt_deg": round(self.tilt[-1], 2),
               "moved_after_let_go_mm": round(float(np.linalg.norm(P[-1] - P[self.let_go_frame()])), 2)}
        for s, e in self.carry.items():
            Hh = np.array(self.in_hand[s])
            held = (t >= max(e["t0"], 0.0) + 0.2) & (t < e["t1"] - 0.2)
            out[f"max_slip_{s}_mm"] = round(float(np.linalg.norm(Hh[held] - Hh[np.argmax(held)], axis=1).max()), 2)
        return out


def main(argv: list[str]) -> int:
    r = PlateLoad(TAKES / argv[0])
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(argv[0], json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
