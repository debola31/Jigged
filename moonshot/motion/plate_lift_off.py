"""Lift the plate off (a plate setup's unload, after its blow-off, when the plate doesn't stay clamped for the next
setup: moonshot/planning/takes.py PLATE_UNLOAD's lift-off-plate), planned for both hands on one trunk from the
doorway: the right hand takes the wrench off the plate and breaks each nut loose and runs it back up its stud in
strokes (moonshot/motion/plate_wrench.py, the user's decision of 2026-11-05: the wrench does it all), and lays the
wrench back on the plate; each clamp is slid back off the plate and tipped onto the spoilboard to park by its end's
hand (moonshot/motion/plate_clamps.py off_keys); then both hands take the plate as it was laid down (moonshot/
motion/plate_load.py's grips) and carry it up and out through the doorway, the wrench lying on it, the take ending
with it in both hands.

    python -m moonshot.motion.plate_lift_off ll-1005337 op20  # plans <data root>/takes/ll-1005337-op20-lift-off-plate
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
from moonshot.motion.primitives import min_jerk
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_UNLOAD, plate_take
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
LIFT_MM = 40.0               # the plate lifted straight up off the board this far before it's carried back
LIFT_S, OUT_S = 0.8, 2.0     # ... and carried out to where the load's take started


class PlateLiftOff(StepTake):
    SOLVER_W = {"range": 3.0, "prior": 2.0, "pose_rot": 1500.0}

    def __init__(self, part: str, setup: str, out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = plates.clamps(part, setup)
        self.ends = PL.END_GRIP[part]
        self.land = self.plate.centre.copy()          # the plate's grips where it lies (PlateLoad.grip_spec's own)
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_UNLOAD[1]), PC.LUMBAR, verbose)
        b = self.plate.bottom                           # the elbows and forearms over the spoilboard (as the seat's)
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + 10.0)]
        specs = {f"pinch_{c.name}": self.grip_spec("pinch", c.name) for c in self.clamps}
        specs |= {"wrench_R": self.grip_spec("wrench", ""), "plate_R": self.grip_spec("plate", "R"),
                  "plate_L": self.grip_spec("plate", "L")}
        self.solve_grips(specs, source=self.grip_spec, depends=(PC, PW, PL, SB))

    def grip_spec(self, kind: str, name: str) -> dict:
        """A clamp's pinch on its strap where it lies clamped, the right hand's on the wrench's handle, or a hand's
        hold on the plate where it lies (name: the side)."""
        if kind == "wrench":
            return PW.grip_spec(self, self.plate)
        if kind == "plate":
            return PL.PlateLoad.grip_spec(self, name)
        c = next(k for k in self.clamps if k.name == name)
        return PC.grip_spec(self, c, "clamped", self.plate)

    def order(self) -> list:
        """Alternating ends, the right's first, near clamps first: nothing then reaches over a clamp still on the
        plate."""
        left = sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: c.stud[1])
        right = sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: c.stud[1])
        out = []
        for a, b in zip(left + [None] * len(right), right + [None] * len(left)):
            out += [x for x in (b, a) if x is not None]
        return out

    def nut_order(self) -> list:
        """The right hand's round of the nuts with the wrench: its own end's near then far, then the left end's far
        then near."""
        return (sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: c.stud[1])
                + sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: -c.stud[1]))

    def plate_path(self, t0: float):
        """The plate's planned path once both hands hold it, (t, middle): up off the board, then back and up to where
        the load's take started, out through the doorway."""
        c = self.plate.centre
        stud_top = max(k.stud_z()[1] for k in self.clamps)
        up = c + [0.0, 0.0, LIFT_MM]
        high = np.r_[c[:2], stud_top + PL.OVER_MM + self.plate.size[2] / 2]
        out = high - [0.0, PL.START_BACK_MM, 0.0]
        return [(t0, c), (t0 + LIFT_S, up), (t0 + LIFT_S + 0.8, high), (t0 + LIFT_S + 0.8 + OUT_S, out)]

    def plan(self):
        t = {"L": 0.3, "R": 0.3}
        self.keys = {}
        t["R"], self.keys["wrench"] = PW.use(self, self.plate, self.nut_order(), 0.3, direction="loosen")
        last = t["R"]
        for c in self.order():
            s = PC.side_of(c)
            start = max(t[s], last)
            t_end, keys = PC.move(self, c, f"pinch_{c.name}", start, lambda t0, c=c: PC.off_keys(c, t0))
            self.keys[c.name] = keys
            t[s] = last = t_end
        t0 = max(t.values())
        # both hands to the plate together, each as a clamp's reach, the grips closing at once
        t_c = 0.0
        for s in ("R", "L"):
            tc, _ = PC.reach(self, s, f"plate_{s}", t0, self.plate.size[2])
            t_c = max(t_c, tc)
        t_load = t_c + SP.PRELOAD_S
        path = self.plate_path(t_load + SP.LIFT_DELAY_S)
        self.keys["blank"] = [(tt, np.eye(3), p) for tt, p in path]

        def at(tt, path=path):
            if tt <= path[0][0]:
                return path[0][1]
            for (a, pa), (b, pb) in zip(path, path[1:]):
                if a <= tt < b:
                    return pa + (pb - pa) * min_jerk((tt - a) / (b - a))
            return path[-1][1]
        t_end = path[-1][0]
        for s in ("R", "L"):
            g = f"plate_{s}"
            self.follow(s, t_c, t_end + 0.5, g, at)
            self.effort(s, t_c, 0.0, g)
            self.effort(s, t_c + 0.2, 0.5, g)
            self.effort(s, t_end + 0.5, 0.5, g)
            self.load(s, t_load, t_end + 0.5, self.plate.mass_kg / 2)
            self.event("grip", t_c - 0.1, t_end + 0.6, side=s, grip=g, on="blank")
            self.event("carry", t_load, t_end + 0.6, side=s, obj="blank")
        self.clip("lift-off", 0.0, t_end + 0.5, "Loosen the clamps and lift the plate off")
        self.t = t_end + 0.6

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        at, yaw = PW.rest(self.plate)
        g = self.grips["plate_R"]                       # its weight's half out at its middle, as the load's
        H, W = np.asarray(g["H"], float), np.asarray(g["W"], float)
        tk |= {"table": {"part": self.part, "setup": self.setup, "state": "clamped",
                         "free": [c.name for c in self.clamps], "plate": True,
                         "wrench": {"at": at.tolist(), "yaw": yaw}},
               "plate_force_at": (H.T @ np.array([0.0, self.land[1] - W[1], 0.0])).tolist()}
        f.write_text(json.dumps(tk, indent=1), encoding="utf-8")
        np.savez(self.out / "clamp_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_R": [k[1] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_p": [k[2] for k in v] for n, v in self.keys.items()})


def build(part: str, setup: str, out=None, verbose=True) -> PlateLiftOff:
    take = PlateLiftOff(part, setup, out, verbose)
    take.plan()
    take.solve()
    take.save()
    if verbose:
        print(f"PlateLiftOff {part} {setup}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    args = sys.argv[1:]
    build(args[0], args[1], TAKES / args[2] if len(args) > 2 else None)
