"""Lay the plate down (a plate setup's "Lay the plate on the spoilboard"), planned for both hands on one trunk from
the doorway: the take starts with the plate in both hands, carried in from off-screen (the user's decision,
2026-11-05: its grips have no reach, so they're exempt from grasp timing and hand opening, named in take.json
"exempt"). The plate goes in over the table level and clear of the parked clamps and is lowered over its place: a
plate held by its ends to just over the board, held there while the eye lines it up, and let go; a sheet held by its
near edge until its fingers are just over the board, tipped onto its far side, let go, and its fingers drawn out from
under it, so it settles the last few millimetres. Either is set down without catching the fingers.

ll-1005337's 7.2 kg Delrin plate is held at the middle of each end, so neither hand holds it out at arm's length, the
hand over the end, the fingertips' pads on its face and the thumb on top. nist-ftc-09's 3 mm sheet is pinched by its
near edge, thumb on top and fingers under, either side of its middle. The hands draw out apart, so any drag on it
cancels. The plan's "slid into place" is the plate lined up over its place before it is let go: slid on the
spoilboard, the plate slid on 15 mm, the arms overloaded.

    python -m moonshot.motion.plate_load ll-1005337 op10     # plans <data root>/takes/ll-1005337-op10-lay-plate
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import plates
from moonshot.motion import solver as BS
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.set_parallels import local_bands, obox
from moonshot.motion.setup_take import plane
from moonshot.motion.step_take import StepTake
from moonshot.planning.takes import PLATE_TAKES, plate_take
from moonshot.world import spoilboard as SB

TAKES = data_root() / "takes"
LUMBAR = np.array([-381.0, -960.0, 955.0])       # in the doorway, square to the table's middle
STANCE_MM: dict[str, np.ndarray] = {}            # nearer the table for ll-1005337, its likelihood went from 29.1 to 30.5
OVER_MM = 60.0                                   # the plate carried in this high over the parked clamps' studs
FINGERS_UNDER_MM = 20.0                          # a plate pinched by its edge is let go this far over the spoilboard:
                                                 # the fingers under it clear the board
BOARD_CLEAR_MM = 25.0                            # the elbows and forearms this far off the spoilboard (and its riser)
# where the plate is let go, from its place over the board: as people set a plate down where they know it settles.
# Let go square over its place, ll-1005337's plate settled 1.4 mm toward the operator and 0.4 mm to the left as it
# dropped clear of the fingers on its end faces, and nist-ftc-09's sheet, tipped onto its far side first, 1.3 mm
# toward them, the same each run
SETTLE_LEAD_MM = {"ll-1005337": np.array([0.4, 1.4, 0.0]), "nist-ftc-09": np.array([1.0, 1.3, 0.0])}
# ... let go this far over the board: the sheet less high, so it drops less onto the fingers (at 20, 3.8 mm of skin in
# the sheet for a frame), but high enough that its weight on them doesn't press them into the board (at 16, 4.6 mm);
# ll-1005337's plate, held by its ends' faces, set down to just over the board
FINGERS_UNDER_PART_MM = {"nist-ftc-09": 18.0, "ll-1005337": 1.0}
HOLD_ENDS_S = 1.6            # a plate held by its ends held this long where it's let go, the eye lining it up
START_BACK_MM = 160.0                            # at the take's start the plate is this much nearer than where it lands
END_GRIP = {"ll-1005337": True, "nist-ftc-09": False}    # held by its ends (a plate), or by its near edge (a sheet)
EDGE_X_MM = 70.0                                 # a sheet pinched this far either side of its middle: at 110 the
                                                 # left hand's edge met the near left clamp's nut
CLAMP_CLEAR_MM = 45.0                            # the elbows and forearms this far off a clamp's stud
# a plate held by its ends is held at their middles, between the end's near and far clamps: held 110 mm in from its
# near edge, nearer the operator, the hands were on the near clamps' studs (the arms' sag under it at the middles was
# the wrists', fed the plate's turn since: hand_force_at)
ENDS_COMP_MM = 0.5                               # the pads on its end this far into it: at 1.5, the fingers under it
                                                 # were 3-4 mm into its underside, its weight on them
ENDS_SKIN_MM = 1.5                               # ... and the rest of the hand kept this far out of it: the finger
                                                 # round its end's bottom edge was 3.3 mm into it
EXEMPT = ["grasp_timing", "hand_opening"]


def rot_x(a: float) -> np.ndarray:
    """A turn about x (the plate's length), positive lifting its far (+y) side."""
    c, s = np.cos(a), np.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _q0(hand) -> dict:
    q = hand.neutral()
    q.update(index_mcp_flex=30.0, index_pip=30.0, middle_mcp_flex=30.0, middle_pip=30.0, ring_mcp_flex=35.0,
             ring_pip=35.0, little_mcp_flex=40.0, little_pip=40.0, thumb_cmc_abd=30.0, thumb_cmc_flex=15.0,
             thumb_mcp_flex=15.0, thumb_ip=10.0)
    return q


class PlateLoad(StepTake):
    SOLVER_W = {"range": 3.0, "prior": 2.0}
    # a plate held by its ends keeps its hold's turn harder: at the default pose weight the planned hand turned off its
    # hold enough that the fingertips under the end stood 6-9 mm inside it from the first frame (the weld keeps the
    # plate where the hand is)
    ENDS_W = {"pose_rot": 1500.0}

    def __init__(self, part: str, setup: str = "op10", out=None, verbose=True):
        self.part, self.setup = part, setup
        self.plate = plates.plate(part, setup)
        self.clamps = plates.clamps(part, setup)
        self.ends = END_GRIP[part]
        if self.ends:
            self.SOLVER_W = PlateLoad.SOLVER_W | PlateLoad.ENDS_W
        c = self.plate.centre
        self.place = c.copy()
        self.land = c + [0.0, 0.0, FINGERS_UNDER_PART_MM.get(part, FINGERS_UNDER_MM)] + SETTLE_LEAD_MM[part]
        stud_top = max(k.stud_z()[1] for k in self.clamps)
        self.high = np.r_[self.land[:2], stud_top + OVER_MM + self.plate.size[2] / 2]
        self.start = self.high - [0.0, START_BACK_MM, 0.0]
        super().__init__(out or TAKES / plate_take(part, setup, PLATE_TAKES["load"]), LUMBAR + STANCE_MM.get(part, 0.0),
                         verbose)
        self.solve_grips({f"plate_{s}": self.grip_spec(s) for s in ("R", "L")}, source=self.grip_spec,
                         depends=(sys.modules[__name__],))
        # the arms keep clear of the parked clamps' studs and nuts: reaching to the plate's ends, the forearms came
        # down on the near clamps' nuts and held the plate up 15 mm short of the spoilboard
        self.boxes = [(np.r_[k.stud, (k.board_z + k.stud_z()[1]) / 2],
                       np.array([CLAMP_CLEAR_MM, CLAMP_CLEAR_MM, (k.stud_z()[1] - k.board_z) / 2 + CLAMP_CLEAR_MM]))
                      for k in self.clamps]
        # ... and of the spoilboard: on nist-ftc-09's riser, its front edge stood in the forearms' way, 25 mm higher
        b = self.plate.bottom
        self.boxes.append((np.r_[SB.TABLE_MID, (SB.TABLE_Z + b) / 2],
                           np.r_[SB.SPOILBOARD_MM[:2] / 2, (b - SB.TABLE_Z) / 2] + BOARD_CLEAR_MM))

    def body_solver(self, n, fps, lumbar, prior, boxes=(), arms=("R",)):
        """StepTake's, with each hand (its wrist and along it) kept off the parked clamps' nuts and studs: holding the
        plate's left end by its face, the left hand came down on the near left clamp's nut and held the plate up
        8-14 mm off its place while it was lined up."""
        import torch
        s = BS.BodySolver(n, fps, lumbar, prior, boxes=boxes, arms=arms)
        for k in (self.clamps if self.ends else ()):           # a sheet's hands, at its near edge, are clear of them
            z0, z1 = k.board_z, k.stud_z()[1]
            c, h = np.r_[k.stud, (z0 + z1) / 2], np.array([SB.FLANGE_R, SB.FLANGE_R, (z1 - z0) / 2])
            for side in arms:
                s.side[side]["hand_boxes"].append((torch.as_tensor(self.at(side, c), dtype=torch.float64),
                                                   torch.as_tensor(h, dtype=torch.float64),
                                                   torch.ones(n, dtype=torch.float64)))
        return s

    def grip_spec(self, side: str) -> dict:
        """A hand's hold on the plate where it is let go: at the middle of its end (ll) or on its near edge (nist),
        thumb on top and fingers under."""
        h, p = self.hand, self.plate
        c, half = self.land, p.size / 2
        sign = 1.0 if side == "R" else -1.0
        top = c[2] + half[2]
        cols = [obox(c, np.eye(3), half + (ENDS_SKIN_MM if self.ends else 0.0)),    # the plate where it's let go,
                obox(np.r_[SB.TABLE_MID, p.bottom - 30.0], np.eye(3), np.r_[SB.SPOILBOARD_MM[:2] / 2, 30.0])]  # board
        if self.ends:
            at = np.array([c[0] + sign * half[0], c[1], top])
            # the fingertips' pads on the end's face, high on it, the hand over the end and the thumb on top, so it drops
            # clear of them when let go: held with the fingers under its ends, it fell through them when let go over the
            # board, and set down on them, they stuck under it or threw it off; held by the end faces low down, the
            # fingertips round the bottom edges, it fell through those
            inward = sorted([-sign * 40.0, -sign * 15.0])         # in from the end, along x
            k = ENDS_COMP_MM
            face = at + [0.0, 0.0, -p.size[2] / 2]
            targets = {
                "thumb": plane(at + [-sign * 25.0, 0.0, 0.0], [0, 0, 1.0], k,
                               local_bands(at, np.eye(3), x=inward, y=(-15, 15))),
                "index": plane(face, [sign, 0, 0], k, local_bands(at, np.eye(3), y=(-24, -4), depth=(3, 9))),
                "middle": plane(face, [sign, 0, 0], k, local_bands(at, np.eye(3), y=(4, 24), depth=(3, 9)))}
        else:
            y_near = c[1] - half[1]
            at = np.array([c[0] + sign * EDGE_X_MM, y_near, top])
            targets = {
                "thumb": plane(at + [0.0, 15.0, 0.0], [0, 0, 1.0], 1.5,
                               local_bands(at, np.eye(3), x=(-12, 12), y=(8, 24))),
                "index": plane(at + [0.0, 8.0, -p.size[2]], [0, 0, -1.0], 1.5,
                               local_bands(at, np.eye(3), x=(-22, -2), y=(3, 13))),
                "middle": plane(at + [0.0, 8.0, -p.size[2]], [0, 0, -1.0], 1.5,
                                local_bands(at, np.eye(3), x=(2, 22), y=(3, 13)))}
        S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
        q0 = _q0(h)
        if self.ends:          # the fingers curled over the end, their pads on its face, the thumb wide on top
            q0.update(index_mcp_flex=50.0, index_pip=45.0, index_dip=20.0, middle_mcp_flex=50.0, middle_pip=45.0,
                      middle_dip=20.0, ring_mcp_flex=55.0, ring_pip=55.0, little_mcp_flex=60.0, little_pip=60.0,
                      thumb_cmc_abd=45.0)
        return dict(obj=c, side=side, q0=q0, colliders=cols, load=p.mass_kg / 2, targets=targets, iters=1500,
                    starts=[S(20, 0, r, 50, 50, -15, 65, pr, -10, 5) for pr in (-30, 0, 30) for r in (0, 20)])

    def tilted(self, pitch: float) -> np.ndarray:
        """The plate's middle where it's let go, tipped `pitch` rad about its near bottom edge (negative: far side
        down)."""
        c, half = self.land, self.plate.size / 2
        pivot = np.r_[c[0], c[1] - half[1], c[2] - half[2]]
        return pivot + rot_x(pitch) @ (c - pivot)

    def plate_keys(self) -> list[tuple[float, np.ndarray, float]]:
        """The plate's planned path, (t, middle, pitch): held at the doorway, in over the table, down to 8 mm over where
        it's let go, a pause while the eye lines it up, and slowly down the rest: a plate held by its ends down on the
        fingers under them, on the board, and a sheet held by its near edge with its fingers just over the board,
        then tipped onto its far side, which comes to rest on the board, so it doesn't drop onto the fingers when it's
        let go (let go level, the impact pressed the skin 4 mm into it)."""
        k = [(0.0, self.start, 0.0), (0.6, self.start, 0.0), (2.4, self.high, 0.0)]
        over = np.r_[self.land[:2], self.land[2] + 8.0]
        k += [(3.8, over, 0.0), (4.4, over, 0.0), (5.4, self.land, 0.0)]
        if self.ends:          # held there while the eye lines it up: in 0.8 s, it was let go 6-13 mm off and 10-18 high
            return k + [(HOLD_ENDS_S + 5.4, self.land, 0.0)]
        drop = self.land[2] - self.place[2]
        pitch = -float(np.arcsin(drop / self.plate.size[1]))
        return k + [(6.2, self.tilted(pitch), pitch), (6.5, self.tilted(pitch), pitch)]

    def plan(self):
        keys = self.keys = self.plate_keys()

        def key(t, keys=keys):
            if t <= keys[0][0]:
                return keys[0][1], keys[0][2]
            for (a, pa, ra), (b, pb, rb) in zip(keys, keys[1:]):
                if a <= t < b:
                    w = min_jerk((t - a) / (b - a))
                    return pa + (pb - pa) * w, ra + (rb - ra) * w
            return keys[-1][1], keys[-1][2]
        at = lambda t: key(t)[0]                                                                     # noqa: E731
        turn = lambda t: rot_x(key(t)[1])                                                            # noqa: E731
        self.key_at = key
        t_down = keys[-1][0]
        let_go = 0.25
        self.look(0.0, self.land)
        for s in ("R", "L"):
            g = self.grips[f"plate_{s}"]
            self.side[s]["fkeys"] = [(0.0, g["q"])]          # holding it from the first frame
            self.follow(s, 0.0, t_down + let_go + 0.05, f"plate_{s}", at, turn)
            self.effort(s, 0.0, 0.5, f"plate_{s}")
            self.effort(s, t_down, 0.5, f"plate_{s}")
            self.effort(s, t_down + 0.2, 0.0, None)
            self.load(s, 0.0, t_down, self.plate.mass_kg / 2)
            # the grip starts before the take so the carry holds from its first frame (sim/plate_load.py)
            self.event("grip", -0.2, t_down + let_go, side=s, grip=f"plate_{s}", on="blank")
            self.event("carry", -0.2, t_down, side=s, obj="blank")
            self.fingers(s, t_down + 0.25, g["q"])
            self.fingers(s, t_down + 0.7, open_like(self.hand, g["q"], 0.5))
            H1, W1 = self.grip_pose(f"plate_{s}", at(t_down), turn(t_down))
            # the hands drawn out level, apart (in the side's world +x for either hand: out past its ends, or along
            # the sheet's near edge, the fingers out from under it), so any drag on it cancels: drawn out toward the
            # operator, the sheet came 6.6 mm with them; then the plate settled onto the board, the hands up off it
            # (a sheet's fingers a little down as they come out, off its weight: level, the skin went 3.6 mm into it)
            out = np.array([60.0, 0.0, 0.0]) if self.ends else np.array([45.0, 0.0, -2.0])
            off = W1 + out
            a = t_down + let_go + 0.05
            self.add(s, a, a + 0.8, lambda tt, a=a, H1=H1, W1=W1, off=off:
                     [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.8), 2.0)])
            self.add(s, a + 0.8, a + 1.2, lambda tt, a=a + 0.8, H1=H1, off=off:
                     [("pose", H1, off + [0.0, 0.0, 50.0 * min_jerk((tt - a) / 0.4)], 1.0)])
            self.side[s]["wrist"] = off + [0.0, 0.0, 50.0]
        t = t_down + let_go + 1.25
        for s in ("R", "L"):
            # back toward the operator before dropping to rest: straight to it, the hand came down on the riser's
            # front edge
            self.transit(s, t, t + 1.3, self.rest_of(s), via=[self.at(s, self.side[s]["wrist"] + [0.0, -120.0, 0.0])])
            self.fingers(s, t + 1.3, self.q_relax)
        self.clip("load", 0.0, t + 0.5, "Lay the plate on the spoilboard")
        self.t = t + 1.5

    def hand_force_at(self) -> np.ndarray:
        """Where each hand's half of the plate's weight acts, in the right hand's frame (mm from the wrist; the
        runner's HAND_FORCE_AT, the left's mirrored): at the hand's own x, so the hands share the weight, but out at the
        plate's middle in y, so each wrist is fed its half of the turn the weight makes about the line between the
        hands (fed at the wrist, the wrists gave under the 7.2 kg plate's and it was carried tipped 18 deg, its far
        edge set down first)."""
        g = self.grips["plate_R"]
        H, W = np.asarray(g["H"], float), np.asarray(g["W"], float)
        return H.T @ np.array([0.0, self.land[1] - W[1], 0.0])

    def in_hands(self) -> tuple[np.ndarray, np.ndarray]:
        """Where the plate starts, its middle (mm) and turn: where the planned right hand's grip holds it at the first
        frame, which the welds then keep (sim/plate_load.py). Held out and high at the start, the planned hands turn
        their 7.2 kg load ~6 deg off level about the line between them (the left hand alike); started level, the
        plate's end was 9.5 mm into the fingers for the whole carry."""
        g = self.grips["plate_R"]
        f0 = self.frames_at(0)["R"]
        Rg = f0["H"] @ np.asarray(g["H"], float).T                  # the hand's turn off its grip, the plate's with it
        Wg = np.asarray(g["obj"], float) + np.asarray(g["W_rel"], float)
        return f0["W"] + Rg @ (np.asarray(g["obj"], float) - Wg), Rg

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        at, R = self.in_hands()
        tk |= {"table": {"part": self.part, "setup": self.setup, "state": "parked", "free": [], "plate": True},
               "hand_force_at": self.hand_force_at().tolist(), "in_hands": {"p": at.tolist(), "R": R.tolist()},
               "exempt": [{"grip": f"plate_{s}", "checks": EXEMPT,
                           "why": "the take starts with the plate in both hands, carried in from off-screen: its "
                                  "grips have no reach (the user's decision, 2026-11-05)"} for s in ("R", "L")],
               "plate_keys": {"t": [k[0] for k in self.keys], "p": [k[1].tolist() for k in self.keys],
                              "pitch": [k[2] for k in self.keys]},
               "start_mm": self.start.tolist(), "place_mm": self.place.tolist()}
        f.write_text(json.dumps(tk, indent=1), encoding="utf-8")


def build(part: str, setup: str = "op10", verbose=True) -> PlateLoad:
    take = PlateLoad(part, setup, verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    if verbose:
        print(f"PlateLoad {part} {setup}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    build(*sys.argv[1:3])
