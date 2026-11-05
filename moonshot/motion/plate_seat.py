"""Clamp the plate down (a plate setup's "Set <n> step clamps on its margin and tighten each nut"), planned for both
hands on one trunk from the doorway: each clamp, parked slid back off the plate's end and tipped onto the spoilboard,
brought up level by its end's hand and slid onto the plate's margin and its heel block (moonshot/motion/
plate_clamps.py), the -x end's by the left hand and the +x end's by the right, one clamp at a time; then the right
hand takes the wrench off the plate and runs each nut down its stud onto its strap and snugs it, in strokes (the
user's decision, 2026-11-05: the wrench does it all; moonshot/motion/plate_wrench.py), and lays the wrench back.

    python -m moonshot.motion.plate_seat ll-1005337 op10      # plans <data root>/takes/ll-1005337-op10-set-clamps
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import plate_clamps as PC
from moonshot.motion import plate_wrench as PW
from moonshot.motion import plates
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_TAKES, plate_take
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
BOARD_CLEAR_MM = 10.0        # the forearms this much further off the spoilboard than the solver's own 45 mm


class PlateSeat(StepTake):
    # as the blow-off's: a long take of held poses; and the pinch's turn held harder: at the default the left hand's
    # planned frame stood 13-20 deg off its pinch while the right's held it
    SOLVER_W = {"range": 3.0, "prior": 2.0, "pose_rot": 1500.0}

    def __init__(self, part: str, setup: str, only: tuple[str, ...] = (), out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = [c for c in plates.clamps(part, setup) if not only or c.name in only]
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_TAKES["seat"]), PC.LUMBAR, verbose)
        # the elbows and forearms over the spoilboard (and its riser) and the table under it: reaching for a far clamp,
        # the forearm came down on the board's front edge and the hand stopped 243 mm short of the clamp
        b = self.plate.bottom
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + BOARD_CLEAR_MM)]
        specs = {f"pinch_{c.name}": self.grip_spec("pinch", c.name) for c in self.clamps}
        self.solve_grips(specs | {"wrench_R": self.grip_spec("wrench", "")}, source=self.grip_spec,
                         depends=(PC, PW, SB))

    def grip_spec(self, kind: str, name: str) -> dict:
        """A clamp's pinch on its strap where it lies parked, or the right hand's pinch on the wrench's handle."""
        if kind == "wrench":
            return PW.grip_spec(self, self.plate)
        c = next(k for k in self.clamps if k.name == name)
        return PC.grip_spec(self, c, "parked", self.plate)

    def order(self) -> list:
        """Alternating ends, the right's first, far clamps first: the arms reach the far ones over the near ones
        still parked, and once a clamp is down, nothing reaches over it (set near first, the near clamps were knocked
        off their places as the hands came back from the far ones)."""
        left = sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: -c.stud[1])
        right = sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: -c.stud[1])
        out = []
        for a, b in zip(left + [None] * len(right), right + [None] * len(left)):
            out += [x for x in (b, a) if x is not None]
        return out

    def nut_order(self) -> list:
        """The right hand's round of the nuts with the wrench: its own end's far then near, then the left end's near
        then far."""
        return (sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: -c.stud[1])
                + sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: c.stud[1]))

    def plan(self):
        t = {"L": 0.3, "R": 0.3}
        self.keys = {}
        last = 0.3
        for c in self.order():
            s = PC.side_of(c)
            start = max(t[s], last)                      # one clamp moved at a time, the eye on it
            t_end, keys = PC.move(self, c, f"pinch_{c.name}", start, lambda t0, c=c: PC.on_keys(c, t0))
            self.keys[c.name] = keys
            t[s] = last = t_end
        t["R"], self.keys["wrench"] = PW.use(self, self.plate, self.nut_order(), max(t["R"], last))
        for s in ("L", "R"):            # back toward the operator, over the clamps now down, before dropping to rest
            self.transit(s, t[s], t[s] + 1.4, self.rest_of(s),
                         via=[self.at(s, self.side[s]["wrist"] + [0.0, -150.0, 40.0])])
            self.fingers(s, t[s] + 1.4, self.q_relax)
        end = max(t.values()) + 1.4
        self.clip("seat", 0.0, end, "Set the step clamps on its margin")
        self.t = end + 0.3

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        at, yaw = PW.rest(self.plate)
        tk |= {"table": {"part": self.part, "setup": self.setup, "state": "parked",
                         "free": [c.name for c in self.clamps], "plate": True,
                         "wrench": {"at": at.tolist(), "yaw": yaw}}}
        f.write_text(json.dumps(tk, indent=1), encoding="utf-8")
        np.savez(self.out / "clamp_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_R": [k[1] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_p": [k[2] for k in v] for n, v in self.keys.items()})


def build(part: str, setup: str, only=(), out=None, verbose=True) -> PlateSeat:
    take = PlateSeat(part, setup, only, out, verbose)
    take.plan()
    take.solve()
    take.save()
    if verbose:
        print(f"PlateSeat {part} {setup}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only = tuple(a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--only="))
    build(args[0], args[1], only[0] if only else (), TAKES / args[2] if len(args) > 2 else None)
