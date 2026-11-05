"""Clamp the plate down (a plate setup's "Set <n> step clamps on its margin and tighten each nut"), planned for both
hands on one trunk from the doorway: each clamp, parked slid back off the plate's end and tipped onto the spoilboard,
brought up level by its end's hand and slid onto the plate's margin and its heel block (moonshot/motion/
plate_clamps.py), the -x end's by the left hand and the +x end's by the right, alternating so a hand rests while the
other works.

In progress (2026-11-04): one clamp's move lands level and square on its stud but 4-5 mm long, and with the pinch at
3-7 mm deep the hand's curled fingers met the heel block; the nuts aren't turned yet, as how the nut's thread is
modelled waits on the user's decision (a free nut on its stud needs `clamp_thread_<i>`, which isn't declared).

    python -m moonshot.motion.plate_seat ll-1005337 op10      # plans <data root>/takes/ll-1005337-op10-set-clamps
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import plate_clamps as PC
from moonshot.motion import plates
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_TAKES, plate_take

TAKES = data_root() / "takes"


class PlateSeat(StepTake):
    SOLVER_W = {"range": 3.0, "prior": 2.0}       # as the blow-off's: a long take of held poses

    def __init__(self, part: str, setup: str, only: tuple[str, ...] = (), out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = [c for c in plates.clamps(part, setup) if not only or c.name in only]
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_TAKES["seat"]), PC.LUMBAR, verbose)
        self.solve_grips({f"pinch_{c.name}": self.pinch_spec(c.name) for c in self.clamps}, source=self.pinch_spec,
                         depends=(PC,))

    def pinch_spec(self, name: str) -> dict:
        c = next(k for k in self.clamps if k.name == name)
        return PC.grip_spec(self, c, "parked", self.plate)

    def order(self) -> list:
        """Alternating ends, near clamps first: the left hand's and the right's in turn."""
        left = sorted([c for c in self.clamps if PC.side_of(c) == "L"], key=lambda c: c.stud[1])
        right = sorted([c for c in self.clamps if PC.side_of(c) == "R"], key=lambda c: c.stud[1])
        out = []
        for a, b in zip(left + [None] * len(right), right + [None] * len(left)):
            out += [x for x in (b, a) if x is not None]
        return out

    def plan(self):
        t = {"L": 0.3, "R": 0.3}
        self.keys = {}
        last = 0.3
        for c in self.order():
            s = PC.side_of(c)
            start = max(t[s], last - 1.5)                # a hand starts its next as the other's is setting down
            t_end, keys = PC.move(self, c, f"pinch_{c.name}", start, lambda t0, c=c: PC.on_keys(c, t0))
            self.keys[c.name] = keys
            t[s], last = t_end, t_end
        for s in ("L", "R"):
            self.transit(s, t[s], t[s] + 1.2, self.rest_of(s))
            self.fingers(s, t[s] + 1.2, self.q_relax)
        end = max(t.values()) + 1.2
        self.clip("seat", 0.0, end, "Set the step clamps on its margin")
        self.t = end + 0.3

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        tk |= {"table": {"part": self.part, "setup": self.setup, "state": "parked",
                         "free": [c.name for c in self.clamps], "plate": True}}
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
