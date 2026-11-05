"""A part's deburring step (nist-ftc-10's step 69, "Deburr every edge", and G1's), planned as a two-handed take at
the inspection bench (plan §5.4). Each part's take is its Job: how it lies, where the left hand holds it, and the
edges stroked. nist-ftc-10's is the first, and what the rest of this says.

The finished part lies pocket side up on the bench. The left hand comes onto its wide rim, fingers flat, and holds it
down; the right picks the swivel deburring tool off the bench, draws its blade along the outer near top edge and
then the pocket's far edge, and puts it back. Two strokes stand for every edge: the caption says the rest.

A stroke draws the blade's hook along the edge, its two arms on the edge's two faces (moonshot/world/bench_cell.py
DEBURR), the tool leaning in from the operator's side and trailing 20 deg behind the stroke, and presses it into the
edge along the faces' bisector (moonshot/sim/bench.py applies the press and keeps the hook on its path by touch).
Both edges' lower faces face the operator: the part's near side, and the pocket's far wall. The kit's placeholder blade
is straight, and its round tip slid off one face or the other however it was pressed. The tool is held turned as the
plan's body chose it when its turn was free (ROLL_DEG), so the hook is made for that; its turn is fixed only for the
strokes. The part's edges are named in its STEP's frame, which is its body's.

    python -m moonshot.motion.deburr [part]    # -> <data root>/takes/<part>-deburr (nist-ftc-10's by default):
                                               #    reference.npz, take.json
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import (CARRY_EASE_S, LIFT_S, PRELOAD_S, TAKE_MM, TAKE_S, TOP, BenchPlan, Steady, bench_box,
                                   box, instrument_colliders, part_at, settle)
from moonshot.motion.primitives import open_like
from moonshot.world import bench_cell as BC

TOOL_AT, TOOL_YAW = np.array([190.0, -230.0, TOP + BC.DEBURR["handle_r"] + 0.1]), 90.0
                            # straight away: turned 20 deg to the right the grip took the forearm to 71 deg of
                            # pronation (people's 61), the take 0.73 in their range; to the left, 0.90; here 0.91
STROKE_N = 2.0              # into the edge: a swivel blade breaks an edge under light pressure (proposed); at 4 N
                            # the part slid away from the steadying hand: the bench holds 0.4 x (5 + 5) N
TRAIL_DEG = 20.0            # the blade trails the hand along the stroke
TILT_DEG = 30.0             # the tool leans down at this toward the edge: at 45 the near edge, close to the body, took
                            # more wrist than the plan allows
ROLL_DEG = -83.0            # the tool's turn about its axis from datum A's up: the plan's body held it so at both
                            # strokes when free to choose (81-84 deg), and the hook's arms are made for it
INTO_MM = 0.5               # the hook is aimed this far into the corner, the faces stopping it, as the vise take's
                            # pushes are: aimed at the faces, a millimetre of lag left it short
TIP = BC.deburr_tip()      # where the hook's arms meet, in the tool's frame


@dataclass(frozen=True)
class Job:
    """One part's deburring take: the part as it lies on the mat (its STEP origin at at_xy), where the left hand holds
    it, the instruments that hand keeps clear of, and the strokes, each (from, to) in the part's frame (mm) along an
    edge whose lower face faces the operator (face_out, out of it) under its upper face (up, out of that): the hook's
    arms are made for edges lying so, the tool held as for nist-ftc-10's."""
    part: BC.BenchPart
    strokes: tuple
    face_out: tuple
    up: tuple
    steady: Steady = Steady()
    keep_off: tuple = ("mic1", "cal6")
    at_xy: tuple = (-80.0, -110.0)
    take_mm: float = TAKE_MM               # the tool's first rise off the bench, over TAKE_S, as it takes its weight
    settle_s: float = 0.1                  # the blade set on its edge this long before it is drawn; the stroke
                                           # starts (t0) 0.1 s before the draw
    skip: tuple = ()               # the station's instruments put away for it: a big part takes their place
    tool_x: float = TOOL_AT[0]     # where the tool lies along the bench's front (x, mm)
    tool_clear: bool = False       # the tool's grip keeps off the part, which lies near it (ll-1005337's plate, 47 mm)

    @property
    def tool_at(self) -> np.ndarray:
        return np.array([self.tool_x, *TOOL_AT[1:]])

    @property
    def bisector(self) -> np.ndarray:
        n = np.add(self.face_out, self.up)
        return n / np.linalg.norm(n)


JOBS = {"nist-ftc-10": Job(
    BC.NIST_FTC_10,
    strokes=(((-5.0, 0.0, 37.5), (-55.0, 0.0, 37.5)),       # the outer near top edge, toward the right
             ((12.0, 0.0, -25.0), (-50.0, 0.0, -25.0))),    # the pocket's far edge, toward the right
    face_out=(0.0, 0.0, 1.0), up=(0.0, -1.0, 0.0))}          # the near side and the pocket's far wall; datum A
# ll-1005337, the 600 x 400 Delrin plate, along the bench's front, its near long edge 83 mm in from the bench's edge
# and its far edge clear of the gauge-block case: the calipers, the micrometer and the thread gauge are put away, as
# it lies where they were kept. The left hand flat on its top, fingers forward, across the 25 mm rib between its two
# columns of recesses (STEP X -212.5 to -187.5), where nist-ftc-10's take has it: 60 mm left of the body's middle and
# well out in front. On the near margin alone (26.5 mm, between the edge and the recesses) the pads could find no
# place (the grip's pads 58-302 against nist-ftc-10's under 1); out at the plate's left, 270 mm left of the middle, the
# trunk turned and the right hand's reach for the tool struck its shank. The blade along the near top edge twice, in
# front of the body. The caption says the tabs cut and filed, and the rest
JOBS["ll-1005337"] = Job(
    BC.LL_1005337,
    strokes=(((-398.0, 150.0, -0.95), (-398.0, 85.0, -0.95)),       # the near top edge, toward the right
             ((-398.0, 260.0, -0.95), (-398.0, 190.0, -0.95))),     # ... and again, further left
    face_out=(-1.0, 0.0, 0.0), up=(0.0, 0.0, 1.0),
    steady=Steady(at=(-200.0, 270.0, -0.95),
                  pads=tuple((f, (-200.0, 270.0, -0.95), (0.0, 0.0, 1.0), (("x", b), ("y", (-25, 25))))
                             for f, b in (("index", (8, 20)), ("middle", (-5, 5)), ("ring", (-22, -10)))),
                  push=(0.0, 0.0, 1.0)),
    # the tool 15 mm further right, 47 mm clear of the plate's end: at nist-ftc-10's place, 25 mm off it, the thumb
    # reaching for the handle's flank struck the plate's corner, which stands 7 mm higher than the handle
    keep_off=(), at_xy=(150.0, 100.0), skip=("cal6", "mic1", "thread"), tool_x=205.0, tool_clear=True)


def end_hold(top, near, far, along=(-6.0, 1.0)) -> Steady:
    """The left hand at a short part's left end, fingers pointing right along it: the index on its top, the thumb on
    its near face and the middle on its far face, each (point, outward normal) in the part's frame, the pads within
    `along` of their points along the world's X. A 75 mm part leaves no room beside a 50 mm stroke for a hand flat
    across it, as nist-ftc-10's 158 mm does; held by its end, the strokes have its right 50 mm."""
    across = lambda at, n, k: (at, n, (("x", along), (k, (-5.0, 5.0))))     # noqa: E731
    return Steady(at=top[0], push=top[1],
                  pads=(("index", *across(*top, "y")), ("thumb", *across(*near, "z")),
                        ("middle", *across(*far, "z"))),
                  starts=HAND_FROM_LEFT)


# G1's first rise, as nist-ftc-10's: its load came on in 133 ms (167 once; people's 163-265), the tool off the bench 4
# frames after the load's onset however slowly the hand rose (over 0.45-0.6 s) or the carry's correction eased in
# (0.3-0.45 s); held still 0.1 s first, or taking 4.25 mm, 100 ms
G1_TAKE_MM = 4.5
# ... and its blade set on each edge for longer: on ll-1007223's low step it landed 2 mm high and out and settled onto
# the edge under its press over 0.3 s, 3 of the draw's first frames off it
G1_SETTLE_S = 0.4
# the shoulder turned in, the forearm palm down: the left hand comes from the left, fingers to the right
HAND_FROM_LEFT = tuple((20, 0, 0, 40, 35, sr, 95, p, 0, 0) for sr in (15, 40) for p in (70, 90))
JOBS["ll-1007223"] = Job(
    BC.LL_1007223,
    # the stem's near top edge and the lowest step's, each its right 50 mm: the near side's two long edges whose
    # lower faces face the operator (the far top edge has the 11 mm bore through it)
    # ending 1.5 mm short of its end: run to 0.5 mm short, the hook lagged past it and dropped off the part
    strokes=(((35.0, 0.0, -14.0), (35.0, 0.0, 36.0)), ((49.0, 27.0, -14.0), (49.0, 27.0, 36.0))),
    face_out=(1.0, 0.0, 0.0), up=(0.0, -1.0, 0.0), take_mm=G1_TAKE_MM, settle_s=G1_SETTLE_S,
    steady=end_hold(((29.5, 0.0, -31.0), (0.0, -1.0, 0.0)), ((35.0, 8.0, -31.0), (1.0, 0.0, 0.0)),
                    ((24.0, 8.0, -31.0), (-1.0, 0.0, 0.0))),
    # 40 mm right of where nist-ftc-10 lies and 20 mm back: there the hand holding the tool to the low step's edge, its
    # curled little finger 100 mm right of the blade and 80 mm nearer the operator, came down on the micrometer
    at_xy=(-40.0, -90.0))
JOBS["ct-slbeam"] = Job(
    BC.CT_SLBEAM,
    # the base's near top edge, 50 of its 57 mm right of the upright: its one long edge facing the operator
    strokes=(((25.0, 0.0, 19.05), (75.0, 0.0, 19.05)),),
    face_out=(0.0, -1.0, 0.0), up=(0.0, 0.0, 1.0), take_mm=G1_TAKE_MM, settle_s=G1_SETTLE_S,
    # held down by the upright's top, flat, fingers forward, as nist-ftc-10's rim is: fingers pointing right along it,
    # its 51 mm top took the left arm past people's (posture median 30-34, theirs 28.7), and pinched by its faces as
    # ll-1007223's stem is, the arm's sway lifted the part 2.3 mm off the mat
    steady=Steady(at=(9.5, 19.05, 50.8), push=(0.0, 0.0, 1.0),
                  pads=tuple((f, (9.5, 19.05, 50.8), (0.0, 0.0, 1.0), (("x", b), ("y", (-10, 10))))
                             for f, b in (("index", (2, 8)), ("middle", (-8, -2))))),
    # 40 mm right of and 25 mm back from nist-ftc-10's: there the hand holding the tool to the edge, 19 mm up, came
    # down on the micrometer (ll-1007223's)
    at_xy=(-78.0, -122.0))
JOBS["nist-ftc-09"] = Job(
    BC.NIST_FTC_09,
    # the near long side's top edge, toward the right; the sheet overhangs the mat 25 mm all round, so the hook's
    # lower arm clears the rubber below the 3 mm edge. Right of the micrometer: where nist-ftc-10's first stroke runs,
    # 27 mm lower, the hand holding the tool came down on it and held the tool 14 mm over the edge
    # two strokes along it, one after the other: with one, the take's start (the trunk's sway as the body settles,
    # common to the bench's takes) was 7% of its frames, past people's for the left arm
    # the hand trailing 100 mm right of the blade clear of the rough-surface block (52 mm tall) at the second's end
    strokes=(((-95.25, 3.04, -30.0), (-95.25, 3.04, 20.0)), ((-95.25, 3.04, 21.0), (-95.25, 3.04, 71.0))),
    face_out=(-1.0, 0.0, 0.0), up=(0.0, 1.0, 0.0), take_mm=G1_TAKE_MM, settle_s=G1_SETTLE_S,
    # flat on the sheet, fingers forward, nearer the body and its middle than nist-ftc-10's hand on its rim: there,
    # 27 mm lower, the trunk leant to the left past people's for 25 frames
    steady=Steady(at=(-75.0, 3.04, -95.0), push=(0.0, 1.0, 0.0),
                  pads=tuple((f, (-75.0, 3.04, -95.0), (0.0, 1.0, 0.0), (("x", b), ("y", (-12, 14))))
                             for f, b in (("index", (8, 20)), ("middle", (-7, 5)), ("ring", (-22, -10))))),
    at_xy=(20.0, -52.0))                                     # its near side where nist-ftc-10's is


def out(part: str) -> Path:
    return data_root() / "takes" / f"{part}-deburr"


def loose(job: Job) -> str:
    """The mat under the middle of the part's colliders, the part on it, and the tool."""
    at = part_at(job.part, job.at_xy)
    lo = np.min([b[0] for b in job.part.boxes.values()], axis=0)
    hi = np.max([b[1] for b in job.part.boxes.values()], axis=0)
    w, x, y, z = job.part.up
    mid = at + Rotation.from_quat([x, y, z, w]).as_matrix() @ ((lo + hi) / 2)
    return BC.mat_body(mid) + BC.part_body(at, job.part) + BC.deburr_body(job.tool_at, TOOL_YAW)


def on_cylinder(a, u, r, lo, hi, side=None, comp=2.0, w=1.0, side_w=30.0):
    """A pad on a cylinder (axis from a along u, radius r): sunk comp into it, facing its axis, between lo and hi
    along it, and, given side (a unit vector across the axis), on that side of it."""
    A, U = torch.as_tensor(np.asarray(a, float)), torch.as_tensor(np.asarray(u, float))
    S = None if side is None else torch.as_tensor(np.asarray(side, float))

    def f(c, n):
        rel = c - A
        t = rel @ U
        radial = rel - t * U
        dist = torch.linalg.norm(radial)
        out = (dist - (r - comp)) ** 2 + 20 * (1.0 + n @ (radial / dist)) ** 2
        out = out + 0.5 * (torch.relu(lo - t) ** 2 + torch.relu(t - hi) ** 2)
        if S is not None:
            out = out + side_w * (1.0 - (radial / dist) @ S) ** 2
        return w * out
    return f


class DeburrPlan(BenchPlan):
    # its grips weigh people's posture at 3, not the shared 0.3, and their pads x3 to keep contact: the pen grip took
    # the shoulder to 53 deg of rotation (people's 31); at 5 alone the pads came off it, and at (5, 5) the forearm
    # turned to 77 deg of pronation (0.72 in people's range, 0.91 at (3, 3))
    grip_weights = (3.0, 3.0)
    # and its body people's range at 3.5, as inspect's (BodySolver.W["range"], 0.5): on the body whose colliders fit
    # its skin, both arms held to people's, the left steadying hand's shoulder turned past theirs for 34 frames
    solver_w = {"range": 3.5}

    def __init__(self, job: Job, verbose=True, folder=None):
        super().__init__(folder or out(job.part.name), verbose)
        self.job, self.bench_part, self.steady_on = job, job.part, job.steady
        rest = self.rests = settle(loose(job), skip=job.skip)
        self.part, self.tool0 = rest["part"], rest["deburr_tool"]
        self.paths["deburr_tool"] = [(0.0, self.tool0[1], self.tool0[0])]
        self.solve_grips(self.grip_specs(), rest)

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        h = self.hand
        bc, bh = bench_box()
        specs = {}
        # the tool off the bench: a pen grip near its front, thumb and middle on its sides, index on top
        p0, R0 = self.tool0
        ax = R0[:, 0]
        D = BC.DEBURR
        hand_cyl = lambda p: G.sdf_cyl(p, p0, p0 + ax * D["handle_len"], D["handle_r"])      # noqa: E731
        blade = lambda p: G.sdf_cyl(p, p0 + ax * D["handle_len"], p0 + ax * (D["handle_len"] + D["blade_len"]),  # noqa: E731
                                    D["blade_r"] + 2.0)
        q0 = h.neutral()
        q0.update(index_mcp_flex=35, index_pip=30, middle_mcp_flex=45, middle_pip=45, ring_mcp_flex=45, ring_pip=55,
                  little_mcp_flex=45, little_pip=55, thumb_cmc_abd=25, thumb_cmc_flex=5, thumb_mcp_flex=20, thumb_ip=15)
        # across the handle: up, and its upper flanks on the hand's left and right; lying on the bench, the handle's
        # sides are 7.6 mm off it, less than a thumb is thick, so the pads pinch it from 45 deg above. The bands along
        # it are wide: the fingers lie along the tool, so the middle reaches past the index
        left, up = R0[:, 1], R0[:, 2]
        upper_left, upper_right = (up + left) / math.sqrt(2), (up - left) / math.sqrt(2)
        on = lambda lo, hi, side: on_cylinder(p0, ax, D["handle_r"], lo, hi, side=side, side_w=10.0)  # noqa: E731
        # clear of the rough-surface block beside it: solved without it, the hand rested on the block, its fingers
        # over the tool and never on it, and only the carry lifted it
        specs["tool"] = dict(of="deburr_tool", obj=p0, q0=q0, iters=1000,
                             # ... and of the part where it lies near (Job.tool_clear: ll-1005337's plate, 47 mm off)
                             colliders=[hand_cyl, blade, box(bc, bh)] + instrument_colliders(self.rests, ("rough",), 3.0)
                             + (self.part_colliders(3.0) if self.job.tool_clear else []),
                             targets={"thumb": on(70, 115, upper_left), "index": on(85, 125, up),
                                      "middle": on(80, 125, upper_right)},
                             # from the shoulder turned out and the forearm less turned: from 55-90 deg of
                             # pronation the shoulder ended rotated in to 53 deg (people's 31)
                             starts=[S(20, 0, r, 45, 45, sr, 75, p, 0, 0) for p in (30, 55) for sr in (-35, -10)
                                     for r in (0, 15)])
        specs["steady"] = self.steady_spec()
        # the left hand comes onto the rim beside the micrometer and over the calipers: kept off them, as its thumb
        # pushed the micrometer 3.9 mm
        specs["steady"]["colliders"] += instrument_colliders(self.rests, self.job.keep_off, grow=5.0)
        return specs

    # --- the verbs ------------------------------------------------------------------------------------------------
    def stroke_pose(self, e, s):
        """The tool's pose (R, origin) with its blade tip on edge point e (world), the stroke going along s."""
        n = self.to_world(self.job.bisector, vec=True)
        out = np.array([n[0], n[1], 0.0]) / np.linalg.norm(n[:2])          # the edge's outward side, level
        tilt, b, roll = math.radians(TILT_DEG), math.radians(TRAIL_DEG), math.radians(ROLL_DEG)
        a = (-out * math.cos(tilt) - np.array([0.0, 0.0, 1.0]) * math.sin(tilt)) * math.cos(b) - s * math.sin(b)
        a /= np.linalg.norm(a)
        z0 = np.array([0.0, 0.0, 1.0]) - a * a[2]
        z0 /= np.linalg.norm(z0)
        z = math.cos(roll) * z0 + math.sin(roll) * np.cross(z0, a)
        R = np.stack([a, np.cross(z, a), z], 1)
        # the arms' corner one arm's radius off each face, then INTO_MM into the corner
        corner = (e + (self.to_world(self.job.face_out, vec=True) + self.to_world(self.job.up, vec=True))
                  * BC.DEBURR["hook_r"]
                  - n * INTO_MM)
        return R, corner - R @ TIP

    def pick_up(self):
        t0 = self.t
        g = self.grips["tool"]
        _, Wg = self.grip_pose("tool", t0)
        self.look(t0, self.tool0[0] + self.tool0[1] @ [110, 0, 0])
        # ready in front of the bench's edge and high enough that the hanging fingers clear its top: 4 mm in front and
        # 110 mm up, they caught its edge and held the hand 115 mm off the tool as the carry closed
        # widest 0.08 s before the hand came to rest, it was widest 82% of the way through its reach; 0.13 s, 67%;
        # 0.105 s, 72%, and on the body whose colliders fit its skin, 69%. Its fingers closing from 0.5 open sweep 4 mm
        # into the bench under the handle (closed, 1 mm; opened 0.8, 7 mm over it), and closing at the grip they shoved
        # the tool 12 mm: it comes in shallower and to rest 5 mm over the grip, closing as it comes down
        tg = self.reach("R", "tool", t0, ready=Wg + [0, -170, 140], approach=Wg + [0, -30, 45], opened=0.8, lead=0.09,
                        above=5.0)
        self.effort("R", tg, 0.0, "tool")
        self.effort("R", tg + 0.25, 0.3, "tool")
        self.t_grab = tg
        R0, p0 = self.tool0[1], self.tool0[0]
        self.t_lift = tg + PRELOAD_S
        self.move("deburr_tool", self.t_lift, self.t_lift + TAKE_S, R0, p0 + [0, 0, self.job.take_mm])
        self.move("deburr_tool", self.t_lift + TAKE_S, self.t_lift + LIFT_S, R0, p0 + [0, 0, 35])
        # off the bench, the free ring and little fingers curl into the palm, out of the part's way (left out, the
        # little finger brushed the part's ear and pushed it 5 mm)
        self.fingers("R", tg + 0.5, g["q"])
        self.fingers("R", tg + 1.0, curled(g["q"]))
        self.t = self.t_lift + LIFT_S
        self.clip("pick up", t0, self.t, "PICK UP  the deburring tool, held like a pen")

    def stroke(self, i, frm, to, approach=1.2):
        """Carry the tool over the edge, set the blade on it, draw it along, lift it off."""
        a, b = self.to_world(frm), self.to_world(to)
        s = (b - a) / np.linalg.norm(b - a)
        n = self.to_world(self.job.bisector, vec=True)
        R, p_a = self.stroke_pose(a, s)
        _, p_b = self.stroke_pose(b, s)
        t0 = self.t
        up = self.to_world(self.job.up, vec=True)
        self.look(t0, a)
        # high over the part first: carried straight in, the hand caught the part's ear and the tool hit it
        self.move("deburr_tool", t0, t0 + approach * 0.65, R, p_a + n * 25 + up * 50)
        self.move("deburr_tool", t0 + approach * 0.65, t0 + approach, R, p_a + n * 25)
        # in front of the edge's lower face and above it, a moment to see the hook onto it, then in and down: coming in
        # down the bisector a little low, the hook's top arm went in under datum A and threw the part; level with the
        # edge, it hung below it on the face
        out = self.to_world(self.job.face_out, vec=True)
        self.move("deburr_tool", t0 + approach, t0 + approach + 0.35, R, p_a + out * 6 + up * 6)
        tc = t0 + approach + 0.35 + 0.4 + 0.35
        self.move("deburr_tool", tc - 0.35, tc, R, p_a)
        dur = np.linalg.norm(b - a) / 40.0                     # 40 mm/s along the edge
        t_draw = tc + self.job.settle_s                        # set on the edge, pressed, then drawn along it
        self.move("deburr_tool", t_draw, t_draw + dur, R, p_b)
        t1 = t_draw + dur
        self.look(tc, (a + b) / 2)
        self.event("press", tc - 0.05, t1 + 0.05, side="R", normal=n.tolist(), force=STROKE_N,
                   contact="part", at="deburr_blade", obj="deburr_tool", point=TIP.tolist())
        self.held.append((t0 + approach * 0.7, t1 + 0.4))             # the tool's turn fixed: the hook needs it
        self.move("deburr_tool", t1 + 0.05, t1 + 0.4, R, p_b + n * 25 + up * 30)    # up clear of the walls
        self.strokes.append({"edge_mm": [list(frm), list(to)], "t0": t_draw - 0.1, "t1": t1, "force_N": STROKE_N})
        self.t = t1 + 0.4
        self.clip(f"stroke {i + 1}", t0, self.t, "DEBURR  the blade drawn along the edge, light and even")

    def put_back(self):
        t0 = self.t
        R0, p0 = self.tool0[1], self.tool0[0]
        g = self.grips["tool"]
        self.look(t0, p0)
        self.move("deburr_tool", t0, t0 + 0.5, self.paths["deburr_tool"][-1][1],
                  self.paths["deburr_tool"][-1][2] + [0, 0, 40])                  # up over the part first: carried
        self.move("deburr_tool", t0 + 0.5, t0 + 1.1, R0, p0 + [0, 0, 30])        # straight home, the hook caught its wall
        t_down = t0 + 1.6
        self.move("deburr_tool", t0 + 1.1, t_down, R0, p0 + [0, 0, 0.3])
        self.fingers("R", t0 + 0.6, curled(g["q"]))
        self.fingers("R", t_down - 0.3, g["q"])                # uncurled again to set it down
        # free to turn about its axis in transport (the body's choice), held to the plan's turn at the strokes
        bounds = [self.t_lift + LIFT_S] + [t for w in self.held for t in w] + [t_down - 0.6]
        free = list(zip(bounds[::2], bounds[1::2]))
        self.carry("tool", self.t_grab, t_down + 0.05, free=free, point=TIP)
        _, W = self.grip_pose("tool", t_down)
        self.effort("R", t_down - 0.1, 0.3, "tool")
        self.effort("R", t_down + 0.05, 0.0, "tool")
        self.event("grip", self.t_grab, t_down + 0.15, side="R", grip="tool", on="deburr_tool")
        self.event("carry", self.t_lift, t_down + 0.05, obj="deburr_tool", grip="tool", ease_in=CARRY_EASE_S)
        self.fingers("R", t_down + 0.05, g["q"])
        self.fingers("R", t_down + 0.4, open_like(self.hand, g["q"], 0.5))
        self.wrist["R"] = W
        self.transit("R", t_down + 0.1, t_down + 0.6, W + [0, -25, 55], via=[W + [0, 0, 20]])
        self.fingers("R", t_down + 1.3, self.q_relax)
        self.transit("R", t_down + 0.6, t_down + 1.7, self.rest, via=[W + [0, -230, 60]])   # back past the bench's edge first
        self.t = t_down + 1.7
        self.clip("put back", t0, self.t, "PUT BACK  the tool where it was")
        return t_down

    def compose(self):
        self.strokes, self.held = [], []
        self.t = 0.5
        self.pick_up()
        for i, (frm, to) in enumerate(self.job.strokes):
            self.stroke(i, frm, to)
        t_down = self.put_back()
        self.steady(0.3, t_down + 0.2)
        self.t = max(self.t, t_down + 1.8)


def curled(q: dict) -> dict:
    """A grip with its free fingers, ring and little, curled into the palm."""
    return q | {"ring_mcp_flex": 75.0, "ring_pip": 90.0, "little_mcp_flex": 75.0, "little_pip": 90.0}


def build(part: str = "nist-ftc-10", solve=True, verbose=True, folder=None) -> DeburrPlan:
    """folder: where the take is planned, if not its own folder under takes/ (a trial's)."""
    job = JOBS[part]
    plan = DeburrPlan(job, verbose=verbose, folder=folder)
    plan.compose()
    if solve:
        plan.solve()
        plan.save({"part": part, "strokes": plan.strokes, "part_at": part_at(job.part, job.at_xy).tolist(),
                   "tool_at": job.tool_at.tolist(), "tool_yaw": TOOL_YAW, "loose": loose(job)})
    return plan


if __name__ == "__main__":
    argv = sys.argv[1:]
    build(*argv[:1], folder=argv[argv.index("--out") + 1] if "--out" in argv else None)
