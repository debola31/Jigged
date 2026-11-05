"""Lift the plate off (a plate setup's unload, after its blow-off, when the plate doesn't stay clamped for the next
setup: moonshot/planning/takes.py PLATE_UNLOAD's lift-off-plate), planned for both hands on one trunk from the
doorway: the right hand takes the wrench off the plate and breaks each nut loose and runs it back up its stud in
strokes (moonshot/motion/plate_wrench.py, the user's decision of 2026-11-05: the wrench does it all), and lays the
wrench back on the plate; each clamp is slid back off the plate and tipped onto the spoilboard to park by its end's
hand (moonshot/motion/plate_clamps.py off_keys); then both hands take the plate as it was laid down (moonshot/
motion/plate_load.py's grips) and carry it up and out through the doorway, the wrench lying on it, the take ending
with it in both hands.

A sheet (nist-ftc-09's 3 mm stainless) lies wholly on its spoilboard, nothing under its edge to get the fingers
under: both hands' fingers pressed flat on its near edge first slide it toward the operator until that edge stands
out over the board's front edge (the hand holding it to the sheet by the same declared constraint as the carry,
carry_blank_R and carry_blank_L, for the fingers' friction), as people take a sheet off a table; they let go, and
take it by that edge as it was laid down.

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
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.set_parallels import local_bands, obox, turned
from moonshot.motion.setup_take import plane
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_UNLOAD, plate_take
from moonshot.world import spoilboard as SB
from moonshot.world import wrench as WR

TAKES = data_root() / "takes"
LIFT_MM = 40.0               # the plate lifted straight up off the board this far before it's carried back
LIFT_S, OUT_S = 0.8, 2.0     # ... and carried out to where the load's take started
OUT_OVER_MM = 25.0           # a sheet slid toward the operator until its near edge stands this far out over the board's
                             # front edge: the fingers under it, 3-13 mm in from it (plate_load.py), clear of the board
SLIDE_S = 1.4                # ... unhurried
PRESS_BAND_MM = (5.0, 22.0)  # the pressing fingers' pads this far in from its near edge: clear of the wrench (30 in)
BOARD_PALM_MM = 6.0          # the pressing hand's palm kept this far over the board in front of the sheet


class PlateLiftOff(StepTake):
    SOLVER_W = {"range": 3.0, "prior": 2.0, "pose_rot": 1500.0}

    def __init__(self, part: str, setup: str, out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = plates.clamps(part, setup)
        self.ends = PL.END_GRIP[part]
        self.slid = np.zeros(3) if self.ends else np.array([0.0, -self.slide_mm(), 0.0])
        self.land = self.plate.centre + self.slid       # the plate's grips where it lies (PlateLoad.grip_spec's own)
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_UNLOAD[1]), PC.LUMBAR, verbose)
        b = self.plate.bottom                           # the elbows and forearms over the spoilboard (as the seat's)
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + 10.0)]
        specs = {f"pinch_{c.name}": self.grip_spec("pinch", c.name) for c in self.clamps}
        specs |= {"wrench_R": self.grip_spec("wrench", ""), "plate_R": self.grip_spec("plate", "R"),
                  "plate_L": self.grip_spec("plate", "L")}
        if not self.ends:
            specs |= {f"press_{s}": self.grip_spec("press", s) for s in ("R", "L")}
        self.solve_grips(specs, source=self.grip_spec, depends=(PC, PW, PL, SB, WR))

    def slide_mm(self) -> float:
        """How far a sheet is slid toward the operator: its near edge OUT_OVER_MM out over the board's front edge."""
        near = self.plate.centre[1] - self.plate.size[1] / 2
        return near - (SB.TABLE_MID[1] - SB.SPOILBOARD_MM[1] / 2) + OUT_OVER_MM

    def wrench_cols(self, shift) -> list:
        """The wrench lying on the plate, moved by shift (mm), as colliders for a hand's grip on the plate."""
        p, yaw = PW.rest(self.plate)
        R = turned(yaw)
        return [obox(p + shift + R @ c, R @ Rb, hh) for _, c, hh, Rb in WR.boxes()]

    def grip_spec(self, kind: str, name: str) -> dict:
        """A clamp's pinch on its strap where it lies clamped, the right hand's on the wrench's handle, a hand's hold
        on the plate where it's taken up (name: the side; a sheet's once slid), or a hand's fingers pressed flat on a
        sheet's near edge where it lies."""
        if kind == "wrench":
            return PW.grip_spec(self, self.plate)
        if kind == "plate":
            g = PL.PlateLoad.grip_spec(self, name)
            g["colliders"] = g["colliders"] + self.wrench_cols(self.slid)        # the wrench rides on it
            return g
        if kind == "press":
            return self.press_spec(name)
        c = next(k for k in self.clamps if k.name == name)
        return PC.grip_spec(self, c, "clamped", self.plate)

    def press_spec(self, side: str) -> dict:
        """The hand's fingers flat on the sheet's near edge, either side of its middle where it is later pinched, the
        index and middle pads and the thumb's on its top PRESS_BAND_MM in, the palm out over the board in front of it."""
        h, p = self.hand, self.plate
        c, half = p.centre, p.size / 2
        sign = 1.0 if side == "R" else -1.0
        top = c[2] + half[2]
        at = np.array([c[0] + sign * PL.EDGE_X_MM, c[1] - half[1], top])
        I, (y0, y1) = np.eye(3), PRESS_BAND_MM
        near = SB.TABLE_MID[1] - SB.SPOILBOARD_MM[1] / 2
        front = np.array([SB.TABLE_MID[0], (near + at[1]) / 2, p.bottom - 30.0])     # the board's strip before it
        cols = [obox(c, I, half),
                obox(front, I, [SB.SPOILBOARD_MM[0] / 2, (at[1] - near) / 2, 30.0 + BOARD_PALM_MM]),
                *self.wrench_cols(np.zeros(3))]
        targets = {"index": plane(at, [0, 0, 1.0], 1.5, local_bands(at, I, x=(-22, -4), y=(y0, y1))),
                   "middle": plane(at, [0, 0, 1.0], 1.5, local_bands(at, I, x=(4, 22), y=(y0, y1))),
                   "thumb": plane(at, [0, 0, 1.0], 1.5, local_bands(at, I, x=sorted([-sign * 50.0, -sign * 28.0]),
                                                                     y=(y0, y1)))}
        q0 = h.neutral()
        q0.update(index_mcp_flex=20.0, index_pip=20.0, middle_mcp_flex=20.0, middle_pip=20.0, ring_mcp_flex=25.0,
                  ring_pip=25.0, little_mcp_flex=30.0, little_pip=30.0, thumb_cmc_abd=40.0, thumb_cmc_flex=10.0)
        S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
        return dict(obj=c, side=side, q0=q0, colliders=cols, load=0.0, targets=targets, iters=1500,
                    starts=[S(20, 0, r, 50, 50, -15, 65, pr, -10, 5) for pr in (-30, 0, 30) for r in (0, 20)])

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
        """The plate's planned path once both hands hold it, (t, middle): up off the board from where it's taken up,
        then back and up to where the load's take started, out through the doorway."""
        c = self.land
        stud_top = max(k.stud_z()[1] for k in self.clamps)
        up = c + [0.0, 0.0, LIFT_MM]
        high = np.r_[c[:2], stud_top + PL.OVER_MM + self.plate.size[2] / 2]
        out = high - [0.0, PL.START_BACK_MM, 0.0]
        return [(t0, c), (t0 + LIFT_S, up), (t0 + LIFT_S + 0.8, high), (t0 + LIFT_S + 0.8 + OUT_S, out)]

    def both_take(self, grip: str, t0: float, size_mm: float) -> float:
        """Both hands to their grips on the plate together, each as a clamp's reach, the grips closing at once (the
        earlier hand held there): when they close."""
        t_c = {s: PC.reach(self, s, f"{grip}_{s}", t0, size_mm)[0] for s in ("R", "L")}
        end = max(t_c.values())
        for s in ("R", "L"):
            if t_c[s] < end:
                H, W = self.grip_pose(f"{grip}_{s}")
                self.add(s, t_c[s], end, lambda tt, H=H, W=W: [("pose", H, W, 2.0)])
        return end

    def slide_off(self, t0: float) -> float:
        """A sheet slid toward the operator by both hands' fingers pressed flat on its near edge, let go, and the
        hands up off it: when they are. Its keys start self.keys["blank"]."""
        t_c = self.both_take("press", t0, 10.0)
        t_load = t_c + SP.PRELOAD_S
        c = self.plate.centre
        path = [(t_load, c), (t_load + SLIDE_S, c + self.slid)]
        self.keys["blank"] = [(tt, np.eye(3), p) for tt, p in path]
        t_end = path[-1][0]
        drag = SB.MDF_FRICTION * (self.plate.mass_kg + WR.kg()) * 9.81
        for s in ("R", "L"):
            g = f"press_{s}"
            self.follow(s, t_c, t_end + 0.3, g, lambda tt, path=path: path[0][1] + self.slid * float(np.clip(
                min_jerk((tt - path[0][0]) / SLIDE_S), 0.0, 1.0)))
            self.effort(s, t_c, 0.0, g)
            self.effort(s, t_c + 0.2, 0.5, g)
            self.effort(s, t_end, 0.5, g)
            self.effort(s, t_end + 0.2, 0.0, None)
            self.event("grip", t_c - 0.1, t_end + 0.25, side=s, grip=g, on="blank")
            self.event("carry", t_load, t_end, side=s, obj="blank", drag_N=drag / 2)
            q = self.grips[g]["q"]
            self.fingers(s, t_end + 0.25, q)
            self.fingers(s, t_end + 0.6, open_like(self.hand, q, 0.4))
            H1, W1 = self.grip_pose(g, c + self.slid)
            off = W1 + np.array([0.0, -40.0, 60.0])
            self.add(s, t_end + 0.3, t_end + 0.8, lambda tt, a=t_end + 0.3, H1=H1, W1=W1, off=off:
                     [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
            self.side[s]["wrist"] = off
        return t_end + 0.8

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
        if not self.ends:
            t0 = self.slide_off(t0)
        t_c = self.both_take("plate", t0, self.plate.size[2])
        t_load = t_c + SP.PRELOAD_S
        path = self.plate_path(t_load + SP.LIFT_DELAY_S)
        self.keys["blank"] = self.keys.get("blank", []) + [(tt, np.eye(3), p) for tt, p in path]

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
