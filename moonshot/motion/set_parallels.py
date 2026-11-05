"""Set the parallels (every VF-2 setup's first step, "...then set the parallels"), planned for both hands on one
trunk: the right hand takes each parallel from its rack on the table (moonshot/world/parallel_rack.py), pinched by
its top edge, thumb on the near face and index and middle on the far one, and stands it on the vise's seat where the
load take expects it (vise.Load.parallels); the far one first, so the hand never reaches over the one it has set.
The left hand stays by the operator's side.

    python -m moonshot.motion.set_parallels            # plans into the data root's takes/set-parallels
    python -m moonshot.motion.set_parallels ll-1007223 op10     # a setup's own: takes/ll-1007223-op10-set-parallels
"""
from __future__ import annotations

import sys

import numpy as np
import torch

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import setup_take as ST
from moonshot.motion.loads import scene_spec, vise_load
from moonshot.motion.primitives import PEAK_PER_MM, PEAK_PLUS_MM, blend_q, min_jerk, open_for, open_like
from moonshot.motion.setup_take import plane, vise_boxes
from moonshot.motion.step_take import StepTake
from moonshot.planning.validate import load_plan
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V

TAKES = data_root() / "takes"
ORDER = ("para_a", "para_b")
GRIP = {"para_a": "pinch_a", "para_b": "pinch_b"}
CLEAR_MM = 80.0                    # carried this high over its spot: its foot clears the jaws' tops by 30 mm
JAWS_OVER_SEAT_MM = V.VISE["jaw_top_z"] - V.VISE["seat_z"]      # 44.1: lined up here, the fingers still clear the jaws
STEEL = 7850.0                     # kg/m^3
# the reach to grasp, as the vise take's grab (moonshot/motion/setup_take.py): the hand comes up to a ready point short
# of its grip, slower than the reach (so the reach is the fastest move before the grasp, which is how the grasp-timing
# check finds its start), pauses there a moment, then reaches in people's time (person.reach_to_grasp_right_s), over
# the block and down onto it, opening widest ~74% of the way (person.peak_aperture_reach_frac). With no pause the
# hand came on from the thigh in one move and its reach measured 2.0 s
READY_FROM_GRIP = np.array([0.0, -160.0, 45.0])
RAISE_S, SETTLE_S = 1.2, 0.25
REACH_S, REACH_PEAK = 0.58, 0.76   # the reach ends as the carry closes (the grip event's start + 0.1 s): with a
                                   # welded grip that is its first touch (the hand and the block don't collide from
                                   # 0.4 s before it, moonshot/sim/runner.py APPROACH_S)
OVER_GRIP = np.array([0.0, -10.0, 45.0])   # the last of it down onto the block: from 200 mm back and 62 over in 0.55
                                           # s the physics hand ran 10 mm low coming down, and knocked parallel b
NEIGHBOUR_CLEAR_MM = 4.0           # the grip keeps this clear of the parallel left in the rack: its curled ring and
                                   # little fingers rested 1.5 mm into it
NEAR_SET_MM = 30.0                 # ... and of a parallel already set nearer than this to where it lands (pinch_spec)
# after the touch, the lifting studies' phases (Guillery 2013; person.grasp_preload_ms 139-321, grasp_loading_ms
# 163-265): the grip firms while the hand stays put, then the hand takes the weight (the carry's pull ramps in over
# LOADING_S, moonshot/sim/set_parallels.py) and starts up LIFT_DELAY_S after the carry starts, the block coming off
# its seat ~0.05-0.1 s later
PRELOAD_S, LOADING_S, LIFT_DELAY_S = 0.2, 0.21, 0.16
# the way back to the thigh from over the vise: out to the right of the crank's knob first (it stands at x -300 to
# -315, y -620, z 990, right in front of the thigh): straight down from over the vise the hand ran into the knob and
# the lever and stuck there, and over it 1090 high the hanging fingers still caught it
CLEAR_CRANK = np.array([-150.0, -700.0, 1100.0])


def fingers_open_for(hand, q: dict, size_mm: float, lag_mm: float = 0.0) -> dict:
    """As primitives.open_for, the grasp shape opened as wide as people open for a block size_mm across, but by the
    fingers alone, the thumb held as the grip has it: taking a parallel from the rack the thumb goes down into the
    17 mm between it and its neighbour, and swung out for the reach (open_for) it came down on the neighbour's top
    and knocked it rattling in its slot."""
    from moonshot.body.aperture import aperture_mm
    names = list(q)
    ext = dict(q)
    for n in ("index", "middle", "ring", "little"):
        ext |= {f"{n}_mcp_flex": -5.0, f"{n}_pip": 8.0, f"{n}_dip": 4.0}
    want = PEAK_PER_MM * size_mm + PEAK_PLUS_MM + lag_mm
    lo, hi = 0.0, 1.0
    for _ in range(14):
        mid = (lo + hi) / 2
        o = hand.clamp({n: q[n] + mid * (ext[n] - q[n]) for n in q})
        if aperture_mm(np.array([[o[n] for n in names]]), names)[0] < want:
            lo = mid
        else:
            hi = mid
    return hand.clamp({n: q[n] + hi * (ext[n] - q[n]) for n in q})


def reach(take: StepTake, grip: str, t0: float, size_mm: float, start=None, lag_mm: float = 0.0,
          opening=open_for) -> float:
    """The right hand's reach to grasp `grip`'s block from wherever it is at t0: up to the ready point, a pause, the
    paced reach, the fingers opening for a block size_mm across (`opening`'s shape) and closing on it. start: the
    finger shape the reach starts from (relaxed by default). Returns the time the reach ends, when the carry should
    close."""
    g = take.grips[grip]
    H, W = take.grip_pose(grip)
    ready = W + READY_FROM_GRIP
    t_ready = t0 + RAISE_S
    take.transit("R", t0, t_ready, ready)
    take.add("R", t_ready, t_ready + SETTLE_S, lambda tt, p=ready: [("pos", p, 1.0)])
    t_reach = t_ready + SETTLE_S
    take.transit("R", t_reach, t_reach + REACH_S, W, via=[W + OVER_GRIP], fade=(H, 1.0))
    t_c = t_reach + REACH_S
    take.fingers("R", t0 + 0.2, take.q_relax)
    take.fingers("R", t_reach, start or take.q_relax)
    take.fingers("R", t_reach + REACH_PEAK * REACH_S, opening(take.hand, g["q"], size_mm, lag_mm))
    take.fingers("R", t_c, g["q"])
    return t_c


def lift_keys(t_c: float, c0, up, over, near, c1, lift_delay: float = LIFT_DELAY_S) -> tuple[list, float, float, float]:
    """The block's planned path from its touch at t_c: put while the grip firms (the preload), straight up to the height
    it is carried at, across, over its spot, down until its foot is level with the jaws' tops, a pause while the eye
    lines it up, and slowly down onto the seat. Returns the keys, when the load comes on, when it starts across and
    when it is down."""
    t_load = t_c + PRELOAD_S
    t_up = t_load + lift_delay + 0.8
    t_over = t_up + 1.8
    t_near, t_down = t_over + 0.5, t_over + 1.9
    keys = [(t_load + lift_delay, c0), (t_up, up), (t_up + 0.3, up), (t_over, over), (t_near, near),
            (t_near + 0.4, near), (t_down, c1)]
    return keys, t_load, t_up, t_down


def turned(yaw: float) -> np.ndarray:
    """A turn about the vertical, radians."""
    c, s = np.cos(yaw), np.sin(yaw)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def obox(c, R, h):
    """A box turned by R (its columns the box's axes), for the grip solve."""
    return lambda p, c=np.asarray(c, float), R=np.asarray(R, float), h=np.asarray(h, float): G.sdf_box(p, c, R, h)


def local_bands(c, R, **lims):
    """As setup_take.bands, in the frame of an object turned by R: x and y along its own axes, depth below c."""
    c = np.asarray(c, float)

    def f(p):
        q = (p - torch.as_tensor(c, dtype=p.dtype)) @ torch.as_tensor(R, dtype=p.dtype)
        out = torch.zeros((), dtype=p.dtype)
        for k, (lo, hi) in lims.items():
            v = (c[2] - p[2]) if k == "depth" else q["xyz".index(k)]
            out = out + torch.relu(lo - v) ** 2 + torch.relu(v - hi) ** 2
        return 0.5 * out
    return f

# standing 90 mm left of and 140 mm nearer the table than the vise take's operator (setup_take.LUMBAR): the rack waits
# ahead and to the left, and from the vise take's place the trunk turned past people's range to reach it (in range
# 71% and 80% of frames there, standing back or only left; 95-100% from here, the hands within 1.5 mm of their targets)
LUMBAR = ST.LUMBAR + np.array([-90.0, 140.0, 0.0])

class SetParallels(StepTake):
    def __init__(self, out=TAKES / "set-parallels", load: V.Load = V.REFERENCE, verbose=True, grips_from=None):
        """grips_from: a take's grips.json to take the pinches from (StepTake.take_grips), not solved again."""
        super().__init__(out, LUMBAR, verbose)
        self.vload = load
        self.rack, self.dest = RACK.slots(load), load.parallels()
        self.kg = STEEL * V.PARALLEL_L * V.PARALLEL_T * load.parallel_h * 1e-9
        if grips_from:
            self.take_grips(grips_from, [GRIP[n] for n in ORDER])
        else:
            self.solve_grips({GRIP[n]: self.pinch_spec(n) for n in ORDER}, source=self.pinch_spec, depends=(RACK,))

    def centre(self, base) -> np.ndarray:
        return np.asarray(base, float) + np.array([0.0, 0.0, self.vload.parallel_h / 2])

    def at_landing(self, name: str, solids: list) -> list:
        """Solids as they stand round the parallel where it lands, moved to where it stands in the rack: the grip is
        solved there, and the hand holds it the same way when it sets it down, so its fingers clear the jaws then too
        (beside the fixed jaw, solved at the rack alone, they went into it)."""
        c0, c1 = self.centre(self.rack[name]), self.centre(self.dest[name])

        def moved(p, f):                                 # the rack's turn undone: it lands square to the jaws
            return f(torch.as_tensor(c1, dtype=p.dtype) + (p - torch.as_tensor(c0, dtype=p.dtype)) @
                     torch.as_tensor(RACK.R, dtype=p.dtype))
        return [lambda p, f=f: moved(p, f) for f in solids]

    def pinch_spec(self, name: str) -> dict:
        h = self.hand
        top = self.rack[name] + np.array([0.0, 0.0, self.vload.parallel_h])
        half_t = V.PARALLEL_T / 2
        q0 = h.neutral()
        q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
                  ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
                  thumb_mcp_flex=20.0, thumb_ip=15.0)
        Rr = RACK.R                                      # it stands turned with its rack
        near, far = top + Rr @ [0.0, -half_t, -4.5], top + Rr @ [0.0, half_t, -4.5]   # the pads within 6 mm of the
        # top, so even the thumb's tip stays above the rack's walls
        others = [b for b in ORDER if b != name]
        half = [V.PARALLEL_L / 2, half_t, self.vload.parallel_h / 2]
        cols = [obox(self.centre(self.rack[name]), Rr, half)]
        cols += [obox(self.centre(self.rack[b]), Rr, np.add(half, NEIGHBOUR_CLEAR_MM)) for b in others]
        cols += [obox(c, Rr, hh) for c, hh in RACK.boxes()]
        cols += vise_boxes({}, self.vload.parallel_h, self.vload.opening0)
        set_before = {b: self.dest[b] for b in ORDER[:ORDER.index(name)]}
        # a parallel already set within NEAR_SET_MM of this one's spot is kept NEIGHBOUR_CLEAR_MM clear of, as the one
        # left in the rack is: with ll-1007223's 24 mm between them the run's fingers, letting go of parallel b, met
        # parallel a and set it rocking (2.4 mm off); the reference's stand 43 mm apart
        close = {b: p for b, p in set_before.items()
                 if abs(float(p[1] - self.dest[name][1])) - V.PARALLEL_T < NEAR_SET_MM}
        cols += self.at_landing(name, vise_boxes({b: p for b, p in set_before.items() if b not in close},
                                                 self.vload.parallel_h, self.vload.opening0, include_table=False))
        cols += self.at_landing(name, [obox(self.centre(p), np.eye(3), np.add(half, NEIGHBOUR_CLEAR_MM))
                                       for p in close.values()])
        S = lambda *a: list(a) + [0.0, 0.0]                                                          # noqa: E731
        return dict(obj=self.centre(self.rack[name]), side="R", q0=q0, colliders=cols, load=self.kg,
                    targets={"thumb": plane(near, Rr @ [0, -1, 0], 1.5, local_bands(top, Rr, x=(-10, 10), depth=(3, 6))),
                             "index": plane(far, Rr @ [0, 1, 0], 1.5, local_bands(top, Rr, x=(-30, -8), depth=(3, 6))),
                             "middle": plane(far, Rr @ [0, 1, 0], 1.5, local_bands(top, Rr, x=(8, 30), depth=(3, 6)))},
                    iters=1500,
                    starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])

    def plan(self):
        t = 0.3
        self.keys = {}
        for name in ORDER:
            grip = GRIP[name]
            g = self.grips[grip]
            H, W = self.grip_pose(grip)
            c0, c1 = self.centre(self.rack[name]), self.centre(self.dest[name])
            self.look(t, c0)
            # the reach starts from the hand half closed toward its pinch and opens wider than a relaxed hand: for a
            # 3.1 mm plate people's widest (open_for, 58 mm) is a relaxed hand's own, and from a relaxed hand the
            # reach had no widest point (it measured the hand widest as it started)
            t_c = reach(self, grip, t, V.PARALLEL_T, start=blend_q(self.q_relax, g["q"], 0.5), lag_mm=10.0,
                        opening=fingers_open_for)
            t_on = t_c - 0.1                             # the grip's start: its carry closes 0.1 s after it
            self.effort("R", t_c, 0.0, grip)
            self.effort("R", t_c + 0.2, 0.6, grip)
            # the parallel's planned path: straight up, out of its slot's 8 mm walls and to the height it is carried
            # at, before moving across (dragged sideways while still in it, it caught on the walls and swung in the
            # hand; carried across while still rising, it swept the other parallel's top and the moving jaw's), over
            # its spot, down until its foot is level with the jaws' tops, a pause there while the eye lines it up, and
            # down between the jaws slowly (in one 0.8 s move it wandered 5 mm and was let go still in the air; lined
            # up only 10 mm over the seat, the fingers beside parallel a had met the fixed jaw on the way)
            over = c1 + np.array([0.0, 0.0, CLEAR_MM])
            up, near = np.array([c0[0], c0[1], over[2]]), c1 + np.array([0.0, 0.0, JAWS_OVER_SEAT_MM])
            keys, t_load, t_up, t_down = lift_keys(t_c, c0, up, over, near, c1)
            t_over, t_near = keys[3][0], keys[4][0]
            self.keys[name] = keys

            def obj_at(tt, keys=keys):
                if tt <= keys[0][0]:
                    return keys[0][1]
                for (a, pa), (b, pb) in zip(keys, keys[1:]):
                    if a <= tt < b:
                        return pa + (pb - pa) * min_jerk((tt - a) / (b - a))
                return keys[-1][1]

            def R_at(tt, a=t_up + 0.3, b=t_over):          # turned square to the jaws on the way across
                return turned(-RACK.YAW * min_jerk((tt - a) / (b - a)))
            self.look(t_up, c1)
            # the hand stays put on the seat until the fingers are open off it: lifting on from t_down + 0.3, it began
            # moving on before it let go, and dragged the parallel 3 mm across the seat
            t_lift = t_down + 0.6
            self.follow("R", t_c, t_lift, grip, obj_at, R_at)
            # going down between the jaws, the hand keeps the grip's turn firmly: the carry lets it turn about the
            # vertical as the arm reaches across, and turned so, parallel a's far end met the fixed jaw
            self.add("R", t_near - 0.2, t_lift, lambda tt, grip=grip, obj_at=obj_at, R_at=R_at:
                     [("pose", *self.grip_pose(grip, obj_at(tt), R_at(tt)), 4.0)])
            self.load("R", t_load, t_down, self.kg)
            self.event("grip", t_on, t_down + 0.25, side="R", grip=grip, on=name)
            self.event("carry", t_load, t_down, side="R", obj=name)
            self.effort("R", t_down - 0.1, 0.6, grip)
            self.effort("R", t_down + 0.2, 0.0, None)
            self.fingers("R", t_down + 0.25, g["q"])
            # just off it while the hand stays put, and open the rest of the way once up over the parallels' tops: open
            # wide on the seat, the middle finger beside parallel b went 9 mm into parallel a, and knocked it over
            self.fingers("R", t_down + 0.55, open_like(self.hand, g["q"], 0.06))
            self.fingers("R", t_down + 0.8, open_like(self.hand, g["q"], 0.06))
            self.fingers("R", t_down + 1.05, open_like(self.hand, g["q"], 0.4))
            H1, W1 = self.grip_pose(grip, c1, R_at(t_down))
            off = W1 + np.array([0.0, -20.0, 110.0])    # fingertips 60 mm over the jaws' tops: at 60 the hand, moving on
                                                        # to the rack, caught a fingertip on the moving jaw
            self.add("R", t_lift, t_lift + 0.45, lambda tt, a=t_lift, H1=H1, W1=W1, off=off:
                     [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.45), 2.0)])
            self.side["R"]["wrist"] = off
            t = t_lift + 0.45
        self.transit("R", t, t + 1.6, self.rest_of("R"), via=[CLEAR_CRANK])
        self.fingers("R", t + 1.6, self.q_relax)
        self.clip("set_parallels", 0.0, t + 0.6, "Set the parallels")
        self.t = t + 1.8


def build(verbose=True, part: str | None = None, setup: str | None = None):
    """Plans into the data root's takes/set-parallels, for the reference load; or with a part and setup, that setup's
    own run for its clean into takes/<part>-<setup>-set-parallels (moonshot/planning/takes.py per_setup): its
    parallels, at their height, set where its load take puts them (loads.vise_load), the vise open at its opening and
    its part, as it enters the setup, waiting on the table (take.json "scene", loads.scene_spec)."""
    if part:
        load = vise_load(load_plan(part), setup)
        # parallels of the reference's height stand in the rack as the published take's do and are taken from the same
        # stance, so they are pinched as it pinches them: solved again against ll-1007223 op10's narrower vise, the
        # solver settled on another pinch for parallel a (its penetration term 53.6 against 23.0), which set it down
        # 2.43 mm off where the published one sets it 0.8 mm off
        published = TAKES / "set-parallels" / "grips.json"
        same = abs(load.parallel_h - V.REFERENCE.parallel_h) < 1e-6 and published.exists()
        take = SetParallels(out=TAKES / f"{part}-{setup}-set-parallels", load=load, verbose=verbose,
                            grips_from=published if same else None)
        take.extra = scene_spec(part, setup, stock="in", vise="open")
    else:
        take = SetParallels(verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    np.savez(take.out / "parallel_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in take.keys.items()},
             **{f"{n}_p": [k[1] for k in v] for n, v in take.keys.items()})   # the planned paths, for the physics
    if verbose:
        print(f"SetParallels: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    build("--quiet" not in sys.argv, *args[:2])
