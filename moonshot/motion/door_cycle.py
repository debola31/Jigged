"""Close the doors and start the cycle (every VF-2 setup's step 8), planned as two takes cut together: standing in
the doorway, the hands take the fully open doors' handle bars and run them shut, the right door and then the left;
then, stepped across to the pendant, the eyes check the program and the right index presses Cycle Start (plan §4; the
record's affordances, moonshot/library/stations/vf2.json; the vf2-controls card). And open the doors, every unload's
first take: the same, the other way, out to the stops, so everything between them works with both doors fully open
(your decision 2026-11-03).

Each hand holds its bar as an operator does (your decision 2026-11-03): the palm on the bar's outer face, the fingers
round its back through the gap between bar and door and onto its inner face, the thumb across its front; nothing of
the hand past the door's edge or round outside it. So the hand moves the door by contact alone, either way: the
fingers behind the bar draw it open, the palm pushes it shut. The wrap goes on two ways, as the gap lets it: to a shut
door's bar the hand comes up beside its outer side and slides its fingers in along the gap (beside); to the bar of a
door at its stop, where the hand is turned round the bar so its thumb ends by the bar's inner face, it comes on from
in front, open, the bar between the thumb and the fingers, which close round the bar's outer side into the gap
(in_front).

    python -m moonshot.motion.door_cycle            # plans all three into the data root's takes/door-close,
                                                    # cycle-start, door-open

Declared shortcut: the step across from the doorway to the pendant is a cut, as the body model doesn't walk.
"""
from __future__ import annotations

import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import kinematics as BM
from moonshot.motion.primitives import blend_q, min_jerk, open_like
from moonshot.motion.step_take import THETA0, StepTake
from moonshot.world import cell, vf2

TAKES = data_root() / "takes"
ORIGIN = np.array([-cell.LOAD_X_MM, 0.0, 0.0])        # the VF-2's frame in the world (moonshot/world/cell.py)
OPEN_MM = 600.0                                       # how far the doors stand open: fully, the track's whole range
SLIDE_S = 2.4                                         # a door's 600 mm along its track: 0.47 m/s at most
SEAT_MM = 8.0                                         # the hand runs the door this far past the track's end, into its
SEAT_S = 0.25                                         # stop, and holds it there this long before letting go
REACH_S = 0.5                                         # movement onset to the hand on the bar, as people reach to grasp
                                                      # (person.reach_to_grasp_*_s: 0.26-0.62 s left, 0.32-0.67 right):
                                                      # the run's hand sets off a frame or two early and meets the bar
                                                      # just after, so 0.62 measured 0.70
START_S = 0.583                                       # the first reach sets off once the hanging arm has settled (it
                                                      # starts 12 mm off its plan and comes to it over 0.3 s). The
                                                      # hand-opening check's band is a frame wide: at 0.6 the run's
                                                      # right hand met the bar a frame later in its reach than the left
# With the door at its stop the hand, turned round the bar (roll), can't slide in along the gap: its thumb, which ends
# by the bar's inner face, would pass through the bar. It comes on from in front instead, open (FRONT_Q: the fingers
# straight, the thumb swung out), the bar between the thumb and the fingers, the palm onto the bar's front outer
# corner; then the fingers close round the bar's outer side into the gap as far as it lets them.
FRONT_Q = {"index_mcp_flex": -20.0, "index_pip": 0.0, "middle_mcp_flex": -20.0, "middle_pip": 0.0,
           "ring_mcp_flex": -20.0, "ring_pip": 0.0, "little_mcp_flex": -20.0, "little_pip": 0.0,
           "thumb_cmc_abd": 32.0, "thumb_cmc_flex": -20.0, "thumb_mcp_flex": -8.0, "thumb_ip": -15.0}
FRONT_IN = np.array([6.0, 0.0, 0.0])                  # the reach ends this far out of the wrap's place
FRONT_FROM = np.array([0.0, -50.0, 0.0])              # and comes this far straight in onto it,
FRONT_SLIDE_S = 0.13                                  # in this long: the reach out to the stop is the longest (420 mm),
                                                      # so its rise gets the most of REACH_S, at 17 m/s^2 at most
FRONT_EARLY_S = 0.067                                 # the hand starts closing this long before it stops: the bar is
                                                      # met by the thumb closing onto it, the same frame for either hand
                                                      # (the palm, stopping short of it, met it a frame early on the left
                                                      # and not at all on the right), and within people's reach
PEAK_AT = {"beside": 0.78, "front": 0.8}              # the hand opens widest this far into the planned reach, by the
                                                      # way it comes onto the bar: ~74% of the reach the hand-opening
                                                      # check measures, which starts a frame before the plan's and ends
                                                      # as the hand meets the bar
SPREAD_DEG = (-5.0, -10.0, 10.0)                      # the index's spread on the reach's last part, at its widest, and
                                                      # meeting the bar (index_mcp_abd; the hook opens 84 mm to 77)
CLOSE_S = 0.2                                         # the fingers close round the bar
AIM_EFFORT = 1.0                                      # co-contraction on the way to the bar (runner.STIFFEN_ARM): the
                                                      # fingers slide into the gap with 3.5-7 mm to spare, at 0.3 the
                                                      # arm trailed its plan by 8 mm and 3-4 deg
GRIP_EFFORT = 0.5                                     # the grip's effort holding the bar (runner squeeze and stiffening)
LEFT_AFTER_S = 2.79                                   # the left hand sets off this long after the right door starts
                                                      # (at 2.8 it met the bar a frame early in its reach, door-close)
# the wrap, placed rather than solved: the hand's shape and its place on the bar, as the grip solver (grasp.Problem)
# found it against the skin with the doors shut, the fingers' pads on the bar's inner face and the thumb's toward its
# front, the skin clear of its door (4 mm) and the other bar (36 mm), at most 3 mm into the bar itself. The hand is
# level: tilted up as first solved (13 deg), it needed the wrist bent up past its range, and the planned hand pitched
# down 20 deg instead, its fingertips onto the bar's front corner
GRIP_Z_SHUT, GRIP_Z_OPEN = 1050.0, 1000.0            # where on the bar (it runs 680-1160 mm up) the hand holds it, the
                                                      # wrist ~26 mm above, the door shut and at its stop (grip_z): at
                                                      # the elbow, the forearm level (the affordance's height) by the
                                                      # chest, where at 1000 the hand had to pitch down 10-12 deg (the
                                                      # wrist can't bend up that far) and its thumb met the bar's front
                                                      # corner; 50 mm lower at the stop, where the forearm passes under
                                                      # the pendant (its underside 1090 mm up; at 1050 the forearm met it
                                                      # and the hand never reached the bar). The hand slides down the bar
                                                      # as it runs the door out, as an arm reaching out lowers its hand
WRAP_Q = {"index_mcp_abd": -0.5, "index_mcp_flex": 55.1, "index_pip": 62.6, "index_dip": 49.2,
          "middle_mcp_abd": -5.1, "middle_mcp_flex": 46.9, "middle_pip": 69.2, "middle_dip": 38.9,
          "cmc4_flex": 3.0, "ring_mcp_abd": 7.2, "ring_mcp_flex": 31.2, "ring_pip": 76.9, "ring_dip": 26.7,
          "cmc5_flex": 7.5, "little_mcp_abd": 10.3, "little_mcp_flex": 7.3, "little_pip": 61.1, "little_dip": 36.6,
          "thumb_cmc_abd": 31.9, "thumb_cmc_flex": 25.0, "thumb_cmc_roll": 11.2, "thumb_mcp_abd": 2.6,
          "thumb_mcp_flex": 54.5, "thumb_ip": 15.8}
WRAP_TURN, WRAP_TILT = -4.0, -1.8                     # the hand frame's turn about the bar and tilt (wrap_frame)
WRAP_OUT, WRAP_BACK, WRAP_UP = 40.1, 83.3, 25.9       # the wrist from the bar's middle: out, in front of it, above
ROLL_SHUT, ROLL_OPEN = 20.0, -40.0                    # the hand's turn round the bar, door shut and at its stop (roll)
# With the door shut, the hand slides its fingers into the gap from the bar's outer side, along it: the wrap can't be
# put on by curling round the bar, which needs more room behind it than the 36 mm gap, and the half-curled fingers
# coming at it from in front caught its outer front corner. Each digit is shaped to slide in clear (HOOK_Q, found on
# the physics hand's capsules, moonshot/body/skeleton.py): the index and middle hooked at the knuckles and nearly
# straight, the ring half curled, the little finger straight at the knuckle and bent at its middle joint (its knuckle
# sits in front of the bar's back), the thumb swung out straight across the bar's front; the end joints and the thumb's
# roll follow as the hand couples them (body.hand.couple, which the physics holds). 3.5-7 mm clear of the bar and door.
HOOK_Q = {"index_mcp_flex": 52.0, "index_pip": 20.0, "middle_mcp_flex": 52.0, "middle_pip": 20.0,
          "ring_mcp_flex": 28.0, "ring_pip": 35.0, "little_mcp_flex": -14.0, "little_pip": 65.0,
          "thumb_cmc_abd": 32.0, "thumb_cmc_flex": -20.0, "thumb_mcp_flex": -8.0, "thumb_ip": 0.0}
HOOK_IN = np.array([4.0, 4.0, 0.0])                   # the slide ends this far out and deeper than the wrap's place
HOOK_OUT = 90.0                                       # and starts this much further out
ONTO_W = 2.0                                          # how hard the plan holds the hand to its pose onto the bar
HOOK_SLIDE_S = 0.18                                   # the slide, the reach's last part
# a hand at rest: the arm hanging straight down by the thigh, palm to it, as people stand (their likeliest arm,
# validate/posture.py, likelihood 18.5), the trunk nearly upright; held by its pose, as a position alone let the
# planner turn the arm in (31 deg, at people's limit, likelihood 32)
REST_POSE = [5.0, 0.0, 0.0, 20.0, 7.0, -20.0, 12.0, -3.0, 0.0, -3.0]
REST_W = 0.1
PENDANT_CLEAR_MM = 30.0       # the arm planned this much further off the pendant: on the way out to the right door at
                              # its stop, the forearm trailing its plan caught the pendant's corner and stopped the hand
CLOSE_LUMBAR = ORIGIN + np.array([0.0, -1100.0, 955.0])   # in the doorway, centred, the chest 130 mm off the bars
START_LUMBAR = np.array([70.0, -1470.0, 955.0])           # in front of the pendant, the button by the right shoulder
SCREEN = ORIGIN + np.array([850.0, -1030.0, 1550.0])      # the pendant's screen, where the program name shows


def box(c, h):
    return lambda p, c=np.asarray(c, float), h=np.asarray(h, float): G.sdf_box(p, c, np.eye(3), h)


def collider(name, shift=(0.0, 0.0, 0.0)):
    """A record collider as a box SDF in the world, moved by shift (mm, the station frame)."""
    c = vf2.record()["colliders"][name]
    lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
    return box(ORIGIN + (lo + hi) / 2 + shift, (hi - lo) / 2)


def bands(c, **lims):
    c = np.asarray(c, float)

    def f(p):
        out = 0.0
        for k, (lo, hi) in lims.items():
            v = p["xyz".index(k)] - c["xyz".index(k)]
            out = out + (lo - v).clamp(min=0) ** 2 + (v - hi).clamp(min=0) ** 2
        return 0.5 * out
    return f


def grip_z(open_mm: float) -> float:
    """The height the hand holds the bar at with the door open_mm (GRIP_Z_SHUT to GRIP_Z_OPEN)."""
    return GRIP_Z_SHUT + (GRIP_Z_OPEN - GRIP_Z_SHUT) * float(np.clip(open_mm / OPEN_MM, 0.0, 1.0))


def bar_centre(door: str, open_mm: float, z: float | None = None) -> np.ndarray:
    """The middle of the door's handle bar at the height the hand takes it (grip_z), with the door open_mm, world."""
    rec = vf2.record()
    c, a = rec["colliders"][f"{door}_pull"], rec["affordances"][f"{door}_handle"]
    mid = (np.array(c["box_min_mm"], float) + np.array(c["box_max_mm"], float)) / 2
    return ORIGIN + np.r_[mid[:2], grip_z(open_mm) if z is None else z] + np.array(a["pull"], float) * open_mm


def wrap_frame() -> np.ndarray:
    """The wrapped hand's frame (columns long, radial, dorsal) on the right bar, in the right hand's world: the palm
    toward the bar's outer face (dorsal +x), thumb up, the long axis into the machine; turned WRAP_TURN about the
    vertical (+: the long axis toward the inner face) and tilted WRAP_TILT up about the dorsal axis."""
    a, b = np.radians(WRAP_TILT), np.radians(WRAP_TURN)
    long, radial, dorsal = np.array([0, np.cos(a), np.sin(a)]), np.array([0, -np.sin(a), np.cos(a)]), np.array([1.0, 0, 0])
    Rz = np.array([[np.cos(b), -np.sin(b), 0], [np.sin(b), np.cos(b), 0], [0, 0, 1.0]])
    return Rz @ np.stack([long, radial, dorsal], 1)


def roll(open_mm: float) -> float:
    """How far (deg) the wrapped hand has turned round its bar, from the wrap as placed (WRAP_TURN), with the door
    open_mm: +: the long axis toward the bar's inner face. With the door shut the bar stands in front of the chest
    and the hand points in across it; at the stop the bar stands out past the shoulder and the hand points out along
    the arm. Turned the one way at both, the wrist bent past people's range (44-47 deg of flexion at the stop, likelihood
    50-67 shut); the loose wrap turns round the bar with the skin no deeper in it (4.3 mm, as placed 3.1)."""
    return ROLL_SHUT + (ROLL_OPEN - ROLL_SHUT) * float(np.clip(open_mm / OPEN_MM, 0.0, 1.0))


def Rz(deg: float) -> np.ndarray:
    c, s = np.cos(np.radians(deg)), np.sin(np.radians(deg))
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


class _Doors(StepTake):
    """What opening and closing the doors share: one door at a time, each hand reaching for its own bar in one
    movement, as people reach to grasp, the hand opening on the way and closing round the bar; running the door along
    its track to the stop; letting go and backing off the bar before the hand comes back to rest. Standing in the
    doorway, the operator can't step toward a door at its stop, so the reach out to it leans on people's range; the
    planner holds the body to their posture harder than at a bench (SOLVER_W): at its weights the trunk leant past
    their side-bend 46 of 260 frames, and the arm reached the stop turned out past their likeliest (likelihood 44);
    and at people's range 5 the plan's trunk side-bent to 1 deg inside their range, which the run's trunk, pushed by
    the door, passed (8.5-9.4 deg against their 8.4)."""
    SOLVER_W = {"prior": 1.0, "range": 20.0}

    def __init__(self, out, verbose=True):
        super().__init__(out, CLOSE_LUMBAR, verbose)
        f = BM.fk(REST_POSE, self.lumbar)
        self.rest, self.rest_H = f["W"], f["H"]             # the same in the mirrored world for the left hand
        for s in self.side.values():
            s["wrist"] = self.rest.copy()
        # the pendant hangs in front of the right door's bar near full open: the right arm reaches in under it, kept
        # PENDANT_CLEAR_MM further off it than the plan needs, as the arm trails its plan in the physics
        c = vf2.record()["colliders"]["pendant_face"]
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        self.boxes = [(ORIGIN + (lo + hi) / 2, (hi - lo) / 2 + PENDANT_CLEAR_MM)]

    def solve(self, theta0=None, iters=3000):
        """Planned from both arms hanging at rest (REST_POSE), where they start and end."""
        rest = list(REST_POSE[3:]) + [0.0, 0.0]
        super().solve(theta0 if theta0 is not None else list(REST_POSE[:3]) + rest + rest, iters)

    def hang(self, side: str, t0: float, t1: float) -> None:
        """The side's hand hangs at rest, the arm straight down by the thigh, palm to it, from t0 to t1."""
        self.add(side, t0, t1, lambda t: [("pose", self.rest_H, self.rest, REST_W)])

    def bar_grip(self, door: str, side: str, open_mm: float) -> dict:
        """The wrap on the door's bar with the door open_mm, placed rather than solved (WRAP_*), in the side's world,
        where either bar is the right door's: the palm on its outer face, the fingers round its back through the gap
        and onto its inner face, the thumb across its front."""
        obj = self.at(side, bar_centre(door, open_mm))
        H = wrap_frame()
        W = obj + np.array([WRAP_OUT, -WRAP_BACK, WRAP_UP])
        q = self.hand.clamp(self.hand.neutral() | WRAP_Q)
        return {"q": q, "H": H, "W": W, "obj": obj, "side": side, "W_rel": W - obj, "theta": np.array(THETA0)}

    def shape(self, q: dict, change: dict) -> dict:
        """The wrap q changed by `change`, the end joints, the palm's cupping and the thumb's roll coupled to it."""
        given = {k for k in q if not k.endswith("_dip") and not k.startswith("cmc") and k != "thumb_cmc_roll"}
        return self.hand.couple(self.hand.clamp(q | change), set_=given)

    def opening(self, side, came, t0, t_in, t_c, way) -> None:
        """The hand's opening on a reach: it takes the shape it comes in with (came) by the reach's last part (t_in),
        its index spread away from the thumb (SPREAD_DEG), and opens on to its widest at PEAK_AT of the reach, the
        index spread further; then the index draws in to the thumb as the hand meets the bar (t_c), so the hand is
        widest where people's is (person.peak_aperture_reach_frac). The index's spread moves it along the bar, so
        it keeps the shape's clearance in the gap; straightening the thumb instead swung its tip onto the bar."""
        spread = lambda deg: self.hand.clamp(came | {"index_mcp_abd": deg})     # noqa: E731
        self.fingers(side, t0, self.finger_at(side, t0))
        self.fingers(side, t_in, spread(SPREAD_DEG[0]))
        self.fingers(side, t0 + PEAK_AT[way] * REACH_S, spread(SPREAD_DEG[1]))
        self.fingers(side, t_c, spread(SPREAD_DEG[2]))

    def beside(self, side, g, H, W, t0, t_c, t_on) -> tuple[dict, float]:
        """The reach to a shut door's bar (the side's world): up beside the bar's outer side, the fingers hooked
        (HOOK_Q) at the gap's depth and HOOK_OUT out; then slid in along the gap (HOOK_SLIDE_S, ending at t_c), the
        hand opening widest PEAK_AT of the way; then the fingers close round the bar (CLOSE_S) as the hand settles
        onto the wrap's place, held there to t_on. Returns the hook and when the fingers start to close."""
        hook = self.shape(g["q"], HOOK_Q)
        Wi = W + HOOK_IN
        pre = Wi + np.array([HOOK_OUT, 0.0, 0.0])
        t_in = t_c - HOOK_SLIDE_S
        self.transit(side, t0, t_in, self.at(side, pre), fade=(H, 2.0))
        self.add(side, t_in, t_on, lambda t: [("pose", H, pre + (Wi - pre) * min_jerk((t - t_in) / HOOK_SLIDE_S)
                                               + (W - Wi) * min_jerk((t - t_c) / CLOSE_S), ONTO_W)])
        self.opening(side, hook, t0, t_in, t_c, "beside")
        return hook, t_c

    def in_front(self, side, g, H, W, from_mm, t0, t_c, t_on) -> tuple[dict, float]:
        """The reach to the bar of a door at its stop (the side's world), from in front: up in front of the bar, the
        hand open (FRONT_Q), then straight in onto it (FRONT_SLIDE_S, ending at t_c), the bar between the thumb and the
        fingers; then the fingers close round it (CLOSE_S) as the hand settles onto the wrap's place, held there to
        t_on. Returns the open hand and when the fingers start to close, just before it stops."""
        came = self.shape(g["q"], FRONT_Q)
        We = W + FRONT_IN
        pre = We + FRONT_FROM
        t_in = t_c - FRONT_SLIDE_S
        self.transit(side, t0, t_in, self.at(side, pre), fade=(H, 2.0))
        self.add(side, t_in, t_on, lambda t: [("pose", H, pre + (We - pre) * min_jerk((t - t_in) / FRONT_SLIDE_S)
                                               + (W - We) * min_jerk((t - t_c) / CLOSE_S), ONTO_W)])
        self.opening(side, came, t0, t_in, t_c - FRONT_EARLY_S, "front")
        return came, t_c - FRONT_EARLY_S

    def slide(self, side: str, door: str, grip: str, from_mm: float, to_mm: float, t0: float) -> float:
        """The side's hand reaches at t0 for its door's bar, in one movement (REACH_S) onto it, beside it when the door
        is shut and from in front when it's at its stop, opening widest PEAK_AT of the way and closing round the bar
        as it arrives. Then it runs the door from from_mm to to_mm, turning round the bar as it goes (roll), past the
        track's end by SEAT_MM, so the door is pressed into its stop as a hand runs a sliding door home, held there
        SEAT_S; lets go, backs off the bar the way a reach to it so placed comes and comes back to rest. Returns when
        the door starts to move."""
        g = self.grips[grip]
        turned = lambda mm: Rz(roll(mm) if side == "R" else -roll(mm))     # noqa: E731  in the world, round the bar
        H, W = self.grip_pose(grip, bar_centre(door, from_mm), turned(from_mm))        # in the side's world
        t_c = t0 + REACH_S
        t_pull = t_c + CLOSE_S + 0.1
        t_end = t_pull + SLIDE_S + SEAT_S
        if from_mm < OPEN_MM / 2:
            came, t_shut = self.beside(side, g, H, W, t0, t_c, t_pull)
        else:
            came, t_shut = self.in_front(side, g, H, W, from_mm, t0, t_c, t_pull)
        self.fingers(side, t_shut + CLOSE_S, g["q"])
        # the arm braced as the hand homes in on the bar, so it keeps to its path (unbraced it trailed by 25 mm and
        # 15 deg and its fingers caught the bar's front corner); then the grip's effort as the fingers close
        self.effort(side, t0, 0.0, None)
        self.effort(side, t0 + 0.15, AIM_EFFORT, None)
        self.effort(side, t_shut, AIM_EFFORT, None)
        self.effort(side, t_shut + CLOSE_S, GRIP_EFFORT, grip)
        self.effort(side, t_pull, GRIP_EFFORT, grip)
        self.event("grip", t_c, t_end + 0.1, side=side, grip=grip)
        mm = lambda t: from_mm + (to_mm - from_mm) * min_jerk((t - t_pull) / SLIDE_S)     # noqa: E731
        self.follow(side, t_pull, t_end, grip, lambda t: bar_centre(door, mm(t)), lambda t: turned(mm(t)))
        self.event("pull_door", t_pull, t_end, side=side, door=door, from_mm=from_mm, to_mm=to_mm, move_s=SLIDE_S)
        self.effort(side, t_end, GRIP_EFFORT, grip)
        self.effort(side, t_end + 0.15, 0.0, None)
        # letting go: the fingers open to the shape they come onto a bar so placed with, and the hand backs off the way
        # such a reach comes: out along the gap from a shut door, back toward the body from one at its stop
        He, We = self.grip_pose(grip, bar_centre(door, to_mm), turned(to_mm))
        if to_mm < OPEN_MM / 2:
            came, off = self.shape(g["q"], HOOK_Q), HOOK_IN + np.array([HOOK_OUT, 0.0, 0.0])
        else:
            came, off = self.shape(g["q"], FRONT_Q), FRONT_IN + FRONT_FROM
        self.fingers(side, t_end + 0.1, g["q"])
        self.fingers(side, t_end + 0.3, came)
        self.add(side, t_end, t_end + 0.45, lambda t, He=He, We=We, off=off: [
            ("pose", He, We + off * min_jerk((t - t_end - 0.15) / 0.3), 2.0)])
        self.side[side]["wrist"] = We + off
        self.transit(side, t_end + 0.45, t_end + 1.45, self.rest_of(side), fade=(self.rest_H, REST_W))
        self.hang(side, t_end + 1.45, np.inf)
        self.fingers(side, t_end + 1.0, blend_q(came, self.q_relax, 0.5))
        self.fingers(side, t_end + 1.45, self.q_relax)
        self.t = max(self.t, t_end + 1.6)
        return t_pull


class DoorClose(_Doors):
    """Close the doors from fully open: the right one, then the left, each hand's palm pushing its door's bar home
    along the track; the left hand reaches for its bar as the right door comes home."""

    def __init__(self, out=TAKES / "door-close", verbose=True):
        super().__init__(out, verbose)
        self.grips = {"door_right": self.bar_grip("door_right", "R", OPEN_MM),
                      "door_left": self.bar_grip("door_left", "L", OPEN_MM)}

    def plan(self):
        self.look(0.0, bar_centre("door_right", OPEN_MM))
        self.hang("R", 0.0, START_S)
        t_pull = self.slide("R", "door_right", "door_right", OPEN_MM, -SEAT_MM, START_S)
        self.look(t_pull + 0.4 * SLIDE_S, bar_centre("door_right", 0.0))
        t_left = t_pull + LEFT_AFTER_S
        self.hang("L", 0.0, t_left)
        self.look(t_left - 0.2, bar_centre("door_left", OPEN_MM))
        t_pull = self.slide("L", "door_left", "door_left", OPEN_MM, -SEAT_MM, t_left)
        self.look(t_pull + 0.4 * SLIDE_S, bar_centre("door_left", 0.0))
        self.look(t_pull + SLIDE_S, ORIGIN + np.array([0.0, -400.0, 950.0]))
        self.clip("close_doors", 0.0, self.t - 1.0, "Close the door")


class DoorOpen(_Doors):
    """Open the doors fully, to their stops (every setup's unload starts so): the right one, then the left, each
    hand's fingers behind its door's bar drawing it out along the track; the left hand reaches for its bar as the right
    door reaches its stop."""

    def __init__(self, out=TAKES / "door-open", verbose=True):
        super().__init__(out, verbose)
        self.grips = {"open_right": self.bar_grip("door_right", "R", 0.0),
                      "open_left": self.bar_grip("door_left", "L", 0.0)}

    def plan(self):
        self.look(0.0, bar_centre("door_right", 0.0))
        self.hang("R", 0.0, START_S)
        t_pull = self.slide("R", "door_right", "open_right", 0.0, OPEN_MM + SEAT_MM, START_S)
        self.look(t_pull + 0.4 * SLIDE_S, bar_centre("door_right", OPEN_MM))
        t_left = t_pull + LEFT_AFTER_S
        self.hang("L", 0.0, t_left)
        self.look(t_left - 0.2, bar_centre("door_left", 0.0))
        t_pull = self.slide("L", "door_left", "open_left", 0.0, OPEN_MM + SEAT_MM, t_left)
        self.look(t_pull + 0.4 * SLIDE_S, bar_centre("door_left", OPEN_MM))
        self.look(t_pull + SLIDE_S, ORIGIN + np.array([0.0, -400.0, 950.0]))
        self.clip("open_doors", 0.0, self.t - 1.0, "Open the door")


class CycleStart(StepTake):
    def __init__(self, out=TAKES / "cycle-start", verbose=True):
        super().__init__(out, START_LUMBAR, verbose)
        self.button = ORIGIN + np.array(vf2.record()["affordances"]["cycle_start"]["at_mm"], float)
        self.solve_grips({"cycle_start": self.press_spec()}, source=self.press_spec)

    def press_spec(self) -> dict:
        h = self.hand
        b = self.button                                       # the button's front face (it stands 10 mm proud)
        q0 = h.neutral()
        q0.update(index_mcp_flex=15, index_pip=20, middle_mcp_flex=75, middle_pip=95, ring_mcp_flex=80, ring_pip=95,
                  little_mcp_flex=80, little_pip=90, thumb_cmc_flex=15, thumb_cmc_abd=5, thumb_mcp_flex=40, thumb_ip=35)
        return dict(obj=self.button, side="R", q0=q0, colliders=[collider("pendant_face")],
                    targets={"index": G.plane_target(b, np.array([0, -1.0, 0]), 2.0, bands(b, x=(-4, 4), z=(-4, 4)))},
                    starts=[[10, 0, 10, pl, 60, 0, 60, p, -10, 0, 0, 0] for p in (0, 40) for pl in (60, 85)], iters=900)

    def plan(self):
        g = self.grips["cycle_start"]
        H, W = self.grip_pose("cycle_start")
        back = W + np.array([0, -45.0, 0])
        self.look(0.0, SCREEN)
        self.look(1.1, self.button)
        self.transit("R", 0.6, 1.6, back, fade=(H, 2.0))
        self.fingers("R", 1.2, open_like(self.hand, g["q"], 0.3))
        self.fingers("R", 1.6, g["q"])
        self.add("R", 1.6, 2.4, lambda t: [("pose", H, back + (W - back) * min_jerk((t - 1.6) / 0.3), 2.0)])
        self.effort("R", 1.75, 0.0, "cycle_start")
        self.effort("R", 1.9, 0.2, "cycle_start")
        self.effort("R", 2.2, 0.2, "cycle_start")
        self.effort("R", 2.35, 0.0, None)
        self.event("press", 1.75, 2.3, side="R", button="cycle_start")
        self.add("R", 2.4, 2.7, lambda t: [("pose", H, W + (back - W) * min_jerk((t - 2.4) / 0.3), 2.0)])
        self.side["R"]["wrist"] = back
        self.transit("R", 2.7, 3.7, self.rest_of("R"))
        self.fingers("R", 3.7, self.q_relax)
        self.look(2.4, ORIGIN + np.array([cell.LOAD_X_MM - 381.0, -400.0, 950.0]))
        self.clip("cycle_start", 0.0, 3.0, "Check the program and press Cycle Start")
        self.t = 3.9


def build(verbose=True):
    for cls in (DoorClose, CycleStart, DoorOpen):
        take = cls(verbose=verbose)
        take.plan()
        take.solve()
        take.save()
        if verbose:
            print(f"{type(take).__name__}: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
