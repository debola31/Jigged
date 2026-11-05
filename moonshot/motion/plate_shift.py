"""Shift the plate (a plate setup whose plate is the setup before's, slid along the table: "Loosen the clamps, slide
the plate <shift> and clamp it again"; moonshot/planning/takes.py PLATE_TAKES's shift-plate), planned for both hands
on one trunk from the doorway: the right hand takes the wrench off the plate and breaks each nut loose, a little
(moonshot/motion/plate_wrench.py, the user's decision of 2026-11-05: the wrench does it all), and lays it back on the
plate; both hands take the plate by its ends (moonshot/motion/plate_load.py's grips) and slide it along the
spoilboard to the setup's place, under the clamps' noses, the arms bearing its weight so it slides lightly, and let
it go; then the right hand snugs each nut again, the wrench where the plate has carried it.

    python -m moonshot.motion.plate_shift ll-1005337 op20     # plans <data root>/takes/ll-1005337-op20-shift-plate
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import plate_clamps as PC
from moonshot.motion import plate_load as PL
from moonshot.motion import plate_wrench as PW
from moonshot.motion import plates
from moonshot.motion import set_parallels as SP
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_TAKES, plate_take
from moonshot.planning.validate import load_plan
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
LOOSE_MM = 0.5               # each nut run up this far: the clamps' bite off the plate, so it slides under their noses
SLIDE_S = 1.6                # the slide, unhurried


def before(part: str, setup: str) -> str:
    """The setup whose plate a shift setup slides."""
    ids = [s["id"] for s in load_plan(part)["setups"]]
    return ids[ids.index(setup) - 1]


class PlateShift(StepTake):
    SOLVER_W = {"range": 3.0, "prior": 2.0, "pose_rot": 1500.0}

    def __init__(self, part: str, setup: str, out=None, verbose=True):
        self.part, self.setup = part, setup
        self.prev = before(part, setup)
        self.plate0 = plates.plate(part, self.prev)   # where it lies, and where it goes
        self.plate = plates.plate(part, setup)
        self.clamps = plates.clamps(part, setup)
        self.ends = PL.END_GRIP[part]
        self.land = self.plate0.centre.copy()         # its grips where it lies (PlateLoad.grip_spec's own)
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_TAKES["shift"]), PC.LUMBAR, verbose)
        b = self.plate.bottom
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + 10.0)]
        specs = {"wrench_R": self.grip_spec("wrench", ""), "plate_R": self.grip_spec("plate", "R"),
                 "plate_L": self.grip_spec("plate", "L")}
        self.solve_grips(specs, source=self.grip_spec, depends=(PC, PW, PL, SB))

    def grip_spec(self, kind: str, side: str) -> dict:
        """The right hand's pinch on the wrench's handle where it lies, or a hand's hold on the plate where it lies."""
        if kind == "wrench":
            return PW.grip_spec(self, self.plate0)
        return PL.PlateLoad.grip_spec(self, side)

    def nut_order(self) -> list:
        return (sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: c.stud[1])
                + sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: -c.stud[1]))

    def plan(self):
        self.keys = {}
        t, loosen = PW.use(self, self.plate0, self.nut_order(), 0.3, "loosen", gap_mm=LOOSE_MM)
        t_c = 0.0
        for s in ("R", "L"):                            # both hands to the plate's ends, the grips closing at once
            tc, _ = PC.reach(self, s, f"plate_{s}", t, self.plate0.size[2])
            t_c = max(t_c, tc)
        t_load = t_c + SP.PRELOAD_S
        a, b = self.plate0.centre, self.plate.centre
        t_end = t_load + SP.LIFT_DELAY_S + SLIDE_S
        self.keys["blank"] = [(t_load, np.eye(3), a), (t_load + SP.LIFT_DELAY_S, np.eye(3), a),
                              (t_end, np.eye(3), b), (t_end + 0.3, np.eye(3), b)]

        def at(tt, a=a, b=b, t0=t_load + SP.LIFT_DELAY_S):
            return a + (b - a) * min_jerk((tt - t0) / SLIDE_S)
        for s in ("R", "L"):
            g = f"plate_{s}"
            q = self.grips[g]["q"]
            self.follow(s, t_c, t_end + 0.5, g, at)
            self.effort(s, t_c, 0.0, g)
            self.effort(s, t_c + 0.2, 0.5, g)
            self.effort(s, t_end + 0.3, 0.5, g)
            self.effort(s, t_end + 0.5, 0.0, None)
            self.load(s, t_load, t_end + 0.3, self.plate.mass_kg / 2)
            self.event("grip", t_c - 0.1, t_end + 0.55, side=s, grip=g, on="blank")
            self.event("carry", t_load, t_end + 0.3, side=s, obj="blank")
            self.fingers(s, t_end + 0.55, q)
            self.fingers(s, t_end + 0.9, open_like(self.hand, q, 0.4))
            H1, W1 = self.grip_pose(g, b)
            off = W1 + np.array([0.0, -30.0, 70.0])
            self.add(s, t_end + 0.5, t_end + 1.0, lambda tt, a=t_end + 0.5, H1=H1, W1=W1, off=off:
                     [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
            self.side[s]["wrist"] = off
        t = t_end + 1.0
        self.transit("L", t, t + 1.3, self.rest_of("L"))
        self.fingers("L", t + 1.3, self.q_relax)
        t, tighten = PW.use(self, self.plate, self.nut_order(), t, "tighten", gap_mm=LOOSE_MM)
        self.keys["wrench"] = loosen + tighten          # its two carries' paths, one after the other
        self.transit("R", t, t + 1.3, self.rest_of("R"))
        self.fingers("R", t + 1.3, self.q_relax)
        self.clip("shift", 0.0, t + 1.3, "Loosen the clamps, slide the plate and clamp it again")
        self.t = t + 1.6

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        at, yaw = PW.rest(self.plate0)
        g = self.grips["plate_R"]
        H, W = np.asarray(g["H"], float), np.asarray(g["W"], float)
        tk |= {"table": {"part": self.part, "setup": self.prev, "state": "clamped",
                         "free": [c.name for c in self.clamps], "plate": True,
                         "wrench": {"at": at.tolist(), "yaw": yaw}},
               "plate_force_at": (H.T @ np.array([0.0, self.land[1] - W[1], 0.0])).tolist(),
               "plate_to": self.plate.centre.tolist()}
        f.write_text(json.dumps(tk, indent=1), encoding="utf-8")
        np.savez(self.out / "clamp_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_R": [k[1] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_p": [k[2] for k in v] for n, v in self.keys.items()})


def build(part: str, setup: str, out=None, verbose=True) -> PlateShift:
    take = PlateShift(part, setup, out, verbose)
    take.plan()
    take.solve()
    take.save()
    if verbose:
        print(f"PlateShift {part} {setup}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    args = sys.argv[1:]
    build(args[0], args[1], TAKES / args[2] if len(args) > 2 else None)
