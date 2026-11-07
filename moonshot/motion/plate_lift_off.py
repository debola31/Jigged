"""Lift the plate off (a plate setup's unload, after its blow-off, when the plate doesn't stay clamped for the next
setup: moonshot/planning/takes.py PLATE_UNLOAD's lift-off-plate), planned for both hands on one trunk from the
doorway: each end's hand in turn, the right's first, takes the wrench off the plate and breaks that end's nuts loose
and runs them back up their studs in strokes (moonshot/motion/plate_wrench.py use_ends, the user's decision of
2026-11-05: the wrench does it all), and lays the wrench back on the plate; each clamp is slid back off the plate and tipped onto the spoilboard to park by its end's
hand (moonshot/motion/plate_clamps.py off_keys); then both hands take the plate as it was laid down (moonshot/
motion/plate_load.py's grips) and carry it up and out through the doorway, the wrench lying on it, the take ending
with it in both hands.

Nothing gets under a plate lying on its board where the hands take it up, so both hands first slide it toward the
operator, pulling against its drag on the board, as people take a plate off a table, let go, and take it as it was
laid down (plate_load.py): a sheet (nist-ftc-09's 3 mm stainless, wholly on its board) by its fingers pressed flat on
its near edge, until that edge stands out over the board's front edge, then pinched by that edge; a plate held by its
ends (ll-1005337's) by its near edge, pinched where it already stands out over the board, until its ends stand out
over the board's front edge at their near corners while its middle is still on the board, then by its ends from
underneath there. Each hand holds it through the slide by the same declared constraint as the carry, carry_blank_R
and carry_blank_L.

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
from moonshot.motion.tool_load import InRange
from moonshot.planning.takes import PLATE_UNLOAD, plate_take
from moonshot.world import spoilboard as SB
from moonshot.world import wrench as WR

TAKES = data_root() / "takes"
LIFT_MM = 40.0               # the plate lifted straight up off the board this far before it's carried back
LIFT_S, OUT_S = 0.8, 2.0     # ... and carried out to where the load's take started
OUT_OVER_MM = 25.0           # a sheet slid toward the operator until its near edge stands this far out over the board's
                             # front edge: the fingers under it, 3-13 mm in from it (plate_load.py), clear of the board
ON_BOARD_MM = 15.0           # a plate held by its ends slid until its middle is this far in from the board's front edge,
                             # still resting on it, its ends standing out over it at their near corners
UNDER_OUT_MM = 28.0          # ... and taken from underneath there, its ends' hold this far out over that edge
SLIDE_S = 1.4                # ... unhurried; a plate's 165 mm a little longer
PLATE_SLIDE_S = 2.2
PRESS_BAND_MM = (5.0, 22.0)  # the pressing fingers' pads this far in from its near edge: clear of the wrench (30 in)
BOARD_PALM_MM = 6.0          # the pressing hand's palm kept this far over the board in front of the sheet


class PlateLiftOff(StepTake):
    # the seat's (moonshot/motion/plate_seat.py): the hips let shift toward the end it works, and the trunk held
    # inside people's range as each arm's people see it, as the hands take turns on the nuts
    SOLVER_W = {"range": 30.0, "prior": 2.0, "pose_rot": 1500.0, "pelvis": 0.005}
    body_solver = InRange

    def __init__(self, part: str, setup: str, out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = plates.clamps(part, setup)
        self.ends = PL.END_GRIP[part]
        self.slid = np.array([0.0, -self.slide_mm(), 0.0])
        self.land = self.plate.centre + self.slid       # the plate's grips where it's taken up (PlateLoad.grip_spec's own)
        self.under = self.ends                          # a plate's ends from underneath, as it was laid down
        self.under_y = self.board_front() - UNDER_OUT_MM   # ... where they stand out over the board's front edge
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_UNLOAD[1]), PC.LUMBAR, verbose)
        b = self.plate.bottom                           # the elbows and forearms over the spoilboard (as the seat's)
        self.boxes = [(np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2 - 30.0],
                       np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2 + 30.0] + 10.0)]
        specs = {f"pinch_{c.name}": self.grip_spec("pinch", c.name) for c in self.clamps}
        specs |= {f"wrench_{s}": self.grip_spec("wrench", s) for s, _ in PW.by_hand(self.clamps)}
        specs |= {"plate_R": self.grip_spec("plate", "R")}
        specs |= {f"slide_{s}": self.grip_spec("slide", s) for s in ("R", "L")}
        self.solve_grips(specs, source=self.grip_spec, depends=(PC, PW, PL, SB, WR))
        PL.mirror_grip(self, "plate_R", "plate_L")            # the left's hold on the plate the right's mirrored

    @staticmethod
    def board_front() -> float:
        return SB.TABLE_MID[1] - SB.SPOILBOARD_MM[1] / 2

    def slide_mm(self) -> float:
        """How far the plate is slid toward the operator: a sheet's near edge OUT_OVER_MM out over the board's front
        edge; a plate held by its ends till its middle is ON_BOARD_MM in from that edge, still resting on it."""
        if self.ends:
            return self.plate.centre[1] - self.board_front() - ON_BOARD_MM
        near = self.plate.centre[1] - self.plate.size[1] / 2
        return near - self.board_front() + OUT_OVER_MM

    def wrench_cols(self, shift) -> list:
        """The wrench lying on the plate, moved by shift (mm), as colliders for a hand's grip on the plate."""
        p, yaw = PW.rest(self.plate)
        R = turned(yaw)
        return [obox(p + shift + R @ c, R @ Rb, hh) for _, c, hh, Rb in WR.boxes()]

    def grip_spec(self, kind: str, name: str) -> dict:
        """A clamp's pinch on its strap where it lies clamped, a hand's on the wrench's handle, a hand's hold
        on the plate where it's taken up (name: the side; a sheet's once slid), or a hand's fingers pressed flat on a
        sheet's near edge where it lies."""
        if kind == "wrench":
            return PW.grip_spec(self, self.plate, name, self.clamps, "loosen")
        if kind == "plate":
            g = PL.PlateLoad.grip_spec(self, name)
            g["colliders"] = g["colliders"] + self.wrench_cols(self.slid)        # the wrench rides on it
            return g
        if kind == "slide":
            return self.edge_spec(name) if self.ends else self.press_spec(name)
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

    def edge_spec(self, side: str) -> dict:
        """A plate's near edge pinched where it stands out over the board's front edge, either side of its middle,
        the thumb on top and the index and middle under it (as plate_load.py's sheet): to slide it."""
        h, p = self.hand, self.plate
        c, half = p.centre, p.size / 2
        sign = 1.0 if side == "R" else -1.0
        top = c[2] + half[2]
        at = np.array([c[0] + sign * PL.EDGE_X_MM, c[1] - half[1], top])
        over = at[1] - self.board_front()                      # how far its near edge stands out: the fingers within
        under = (3.0, min(13.0, -over - 6.0))
        I = np.eye(3)
        cols = [obox(c, I, half),
                obox(np.r_[SB.TABLE_MID, p.bottom - 30.0], I, np.r_[SB.SPOILBOARD_MM[:2] / 2, 30.0]),
                *self.wrench_cols(np.zeros(3))]
        targets = {"thumb": plane(at + [0.0, 15.0, 0.0], [0, 0, 1.0], 1.5, local_bands(at, I, x=(-12, 12), y=(8, 24))),
                   "index": plane(at + [0.0, 8.0, -p.size[2]], [0, 0, -1.0], 1.5,
                                  local_bands(at, I, x=(-22, -2), y=under)),
                   "middle": plane(at + [0.0, 8.0, -p.size[2]], [0, 0, -1.0], 1.5,
                                   local_bands(at, I, x=(2, 22), y=under))}
        S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
        return dict(obj=c, side=side, q0=PL._q0(h), colliders=cols, load=0.0, targets=targets, iters=1500,
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
        """The plate slid toward the operator by both hands at its near edge (a sheet's fingers pressed flat on it, a
        plate's near edge pinched), pulling against its drag on the board, let go, and the hands up off it: when they
        are. Its keys start self.keys["blank"]."""
        t_c = self.both_take("slide", t0, self.plate.size[2] if self.ends else 10.0)
        t_load = t_c + SP.PRELOAD_S
        c = self.plate.centre
        T = PLATE_SLIDE_S if self.ends else SLIDE_S
        path = [(t_load, c), (t_load + T, c + self.slid)]
        self.keys["blank"] = [(tt, np.eye(3), p) for tt, p in path]
        t_end = path[-1][0]
        drag = SB.MDF_FRICTION * (self.plate.mass_kg + WR.kg()) * 9.81
        for s in ("R", "L"):
            g = f"slide_{s}"
            self.follow(s, t_c, t_end + 0.3, g, lambda tt, path=path, T=T: path[0][1] + self.slid * float(np.clip(
                min_jerk((tt - path[0][0]) / T), 0.0, 1.0)))
            self.load(s, t_load, t_end, drag / 2 / 9.81)
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
        done, self.keys["wrench"] = PW.use_ends(self, self.plate, self.clamps, 0.3, direction="loosen")
        t |= done
        for s, _ in PW.by_hand(self.clamps)[:-1]:     # a hand whose nuts are done first rests while the other's are
            self.transit(s, t[s], t[s] + 1.4, self.rest_of(s),                      # loosened
                         via=[self.at(s, self.side[s]["wrist"] + [0.0, -150.0, 40.0])])
            self.fingers(s, t[s] + 1.4, self.q_relax)
            t[s] += 1.4
        last = max(done.values())
        for c in self.order():
            s = PC.side_of(c)
            start = max(t[s], last)
            t_end, keys = PC.move(self, c, f"pinch_{c.name}", start, lambda t0, c=c: PC.off_keys(c, t0))
            self.keys[c.name] = keys
            t[s] = last = t_end
        t0 = self.slide_off(max(t.values()))
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
                         "free": [c.name for c in self.clamps], "plate": True, "under": self.under,
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
