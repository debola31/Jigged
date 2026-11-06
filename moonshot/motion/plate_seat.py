"""Clamp the plate down (a plate setup's "Set <n> step clamps on its margin and tighten each nut"), planned for both
hands on one trunk from the doorway: each clamp, parked slid back off the plate's end and tipped onto the spoilboard,
brought up level by its end's hand and slid onto the plate's margin and its heel block (moonshot/motion/
plate_clamps.py), the -x end's by the left hand and the +x end's by the right, one clamp at a time; then the right
hand takes the wrench off the plate and runs each nut down its stud onto its strap and snugs it, in strokes (the
user's decision, 2026-11-05: the wrench does it all; moonshot/motion/plate_wrench.py), and lays the wrench back.

A plate too long for one stance (moonshot/planning/takes.py SPLIT_SEAT) is clamped in two takes, the left end's then
the right's, each from a stance in front of that end's clamps (END_IN_MM), joined across a cut as the operator steps
over: in each, that end's hand sets its clamps and the right hand runs their nuts down; the right end's take starts
with the left end's clamps down.

    python -m moonshot.motion.plate_seat ll-1005337 op10 --end=left   # plans takes/ll-1005337-op10-set-clamps-left
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
from moonshot.planning.takes import PLATE_TAKES, SEAT_ENDS, SPLIT_SEAT, plate_take
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
BOARD_CLEAR_MM = 10.0        # the forearms this much further off the spoilboard than the solver's own 45 mm
END_IN_MM = 190.0            # a split take's stance this far in from its end's studs toward the plate's middle: that
                             # end's shoulder in front of its clamps, the right hand's strokes on the left end's nuts
                             # just across the body's middle (from the plate's middle, ll-1005337's far right nut's
                             # strokes turned the trunk 15 deg past people's range)
SIDE_OF_END = {"left": "L", "right": "R"}


class PlateSeat(StepTake):
    # as the blow-off's: a long take of held poses; and the pinch's turn held harder: at the default the left hand's
    # planned frame stood 13-20 deg off its pinch while the right's held it
    # ... and the hips let shift toward the end it works (the pelvis's own weight a quarter of the solver's): with the
    # hips kept over the stance, a far nut's strokes turned and bent the trunk past people's range
    SOLVER_W = {"range": 3.0, "prior": 2.0, "pose_rot": 1500.0, "pelvis": 0.005}

    def __init__(self, part: str, setup: str, only: tuple[str, ...] = (), out=None, verbose=True,
                 end: str | None = None):
        if (end is not None and (part not in SPLIT_SEAT or end not in SEAT_ENDS)) \
                or (end is None and part in SPLIT_SEAT and not only):
            raise ValueError(f"{part}'s set-clamps takes: one per end of {SEAT_ENDS} if split ({SPLIT_SEAT}), else one")
        self.part, self.setup, self.end = part, setup, end
        self.plate = plates.plate(part, setup)
        self.all_clamps = plates.clamps(part, setup)
        self.clamps = [c for c in self.all_clamps if (not only or c.name in only)
                       and (end is None or PC.side_of(c) == SIDE_OF_END[end])]
        name = PLATE_TAKES["seat"] + (f"-{end}" if end else "")
        super().__init__(out or TAKES / plate_take(part, setup, name), self.stance(), verbose)
        # the elbows and forearms over the spoilboard (and its riser) and the table under it: reaching for a far clamp,
        # the forearm came down on the board's front edge and the hand stopped 243 mm short of the clamp
        b = self.plate.bottom
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + BOARD_CLEAR_MM)]
        specs = {f"pinch_{c.name}": self.grip_spec("pinch", c.name) for c in self.clamps}
        self.solve_grips(specs | {"wrench_R": self.grip_spec("wrench", "")}, source=self.grip_spec,
                         depends=(PC, PW, SB))

    def stance(self) -> np.ndarray:
        """Where the body stands (its lumbar pivot, mm): the doorway's middle, or for one end's take, END_IN_MM in from
        that end's studs."""
        if self.end is None:
            return np.asarray(PC.LUMBAR, float)
        x = self.clamps[0].stud[0]
        return np.r_[x + (END_IN_MM if self.end == "left" else -END_IN_MM), PC.LUMBAR[1:]]

    def table_state(self) -> str | dict[str, str]:
        """The clamps as the take starts (spoilboard.state_of): all parked, or for the right end's take, the left
        end's down."""
        if self.end != "right":
            return "parked"
        return {c.name: "parked" if PC.side_of(c) == "R" else "clamped" for c in self.all_clamps}

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
            if t[s] == 0.3:             # (a hand with nothing to do in this take, the other end's, left at rest)
                continue
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
        tk |= {"table": {"part": self.part, "setup": self.setup, "state": self.table_state(),
                         "free": [c.name for c in self.clamps], "plate": True,
                         "wrench": {"at": at.tolist(), "yaw": yaw}}}
        f.write_text(json.dumps(tk, indent=1), encoding="utf-8")
        np.savez(self.out / "clamp_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_R": [k[1] for k in v] for n, v in self.keys.items()},
                 **{f"{n}_p": [k[2] for k in v] for n, v in self.keys.items()})


def build(part: str, setup: str, only=(), out=None, verbose=True, end: str | None = None) -> PlateSeat:
    take = PlateSeat(part, setup, only, out, verbose, end)
    take.plan()
    take.solve()
    take.save()
    if verbose:
        print(f"PlateSeat {part} {setup}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    build(args[0], args[1], tuple(flags["only"].split(",")) if "only" in flags else (),
          TAKES / args[2] if len(args) > 2 else None, end=flags.get("end"))
