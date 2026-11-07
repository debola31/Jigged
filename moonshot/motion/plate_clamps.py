"""Setting a step clamp on the plate and taking it off (moonshot/world/spoilboard.py), the move a plate setup's Clamp
it down and unload steps share: a hand pinches the strap across its width behind the stud, brings it up level from
where it lies parked (slid back along its slot and tipped nose-down onto the spoilboard), slides it forward along its
slot over the plate's end, and sets it down on the plate's margin and its heel block; taking it off is the same in
reverse. The nearer hand does each clamp: the left the plate's -x end's, the right its +x end's, from one stance in
the doorway (every clamp's nut within 4 mm of either hand's reach there, the planner found, the trunk bent 32 deg at
most). Swung onto the plate about the stud from across the table instead, the pinched hand had to turn a quarter turn
about the vertical and stalled 52 deg short (the arm's reach, 2026-11-04).

The hand holds the pinch on the strap along its planned path (StepTake.follow) and the physics welds the strap to
the hand for the carry (carry_<clamp>, the declared grip assist), the eye steering the strap along its path
(moonshot/sim/plate_clamps.py).
"""
from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from moonshot.motion import set_parallels as SP
from moonshot.motion.primitives import min_jerk, open_for, open_like
from moonshot.motion.set_parallels import local_bands, obox
from moonshot.motion.setup_take import plane
from moonshot.motion.step_take import StepTake
from moonshot.world import spoilboard as SB

LUMBAR = np.array([-381.0, -920.0, 955.0])   # in the doorway, square to the table's middle: either hand reaches its
                                             # end's clamps (planner, 2026-11-04); 60 mm nearer than at first, as the
                                             # load's was tried: swinging the wrench on a far nut from 60 mm further
                                             # back, the elbow straightened to 3 deg and the arm fell 50-70 mm behind
                                             # the handle, the box end tipped 26 deg off the nut
GRAB_MM = -36.0              # the pinch's middle this far along the strap from its middle (toward the heel): behind
                             # the stud, clear of the nut's flange both parked and clamped
DEPTH_MM = (3.0, 7.0)        # the pads this far down the strap's sides from its top, well above what it rests on
PAD_IN_MM = 0.5              # ... and this far into them as the pinch is solved: at 1.5, closing on a far clamp at the
                             # arm's reach, a fingertip stood 4.2-4.3 mm into the strap's rail (the skin's limit 3.5)
CLEAR_MM = 5.0               # the strap carried this high over where it lands: the pads clear the plate and the block
                             # (at 3, the physics hand ran 2-3 mm low and dragged the heel along the block)
LEVEL_S, SLIDE_S, HOLD_S, DOWN_S = 0.5, 1.2, 0.9, 0.8     # unhurried, and a pause over its place while the eye lines it
                                                          # up: in 2.0 s it landed 4.2 mm long; brought up level in 1 s,
                                                          # it took 400-570 ms to come up off the board once loaded;
                                                          # held 0.4 s, a far clamp, slid 6.6 mm past its place, was
                                                          # still 5.8 past as it went down, and the eye's pull back
                                                          # landed it 4.4-4.8 mm short (ll-1005337's left take)
SET_S = 0.3                  # ... and held where it lands a moment before it's let go: let go as it came down, a strap
                             # still 0.7-2.5 mm over its place dropped onto its pads and turned 0.45-0.5 deg as it
                             # landed, and its nut's snug turned it 0.4 more (ll-1005337's left take; its limit 1 deg)
RAISE_PEAK_MM_S = 380.0      # the hand's peak speed on its way to a reach's ready point, under the reach's own
ARC_UP_MM = 80.0             # ... and how far over the higher of where it starts and the ready point it arcs
LIFT_DELAY_S = 0.04          # the strap starts up this long after the carry starts: a tipped strap's middle rises slowly
                             # as it is levelled, and at the parallels' 0.16 s it was 300 ms coming off the board once
                             # loaded, at 0.08 267 ms (people's 163-265)
REACH_S = {"R": SP.REACH_S, "L": 0.52}   # the reach onto a grip, each hand in its people's time (person.reach_to_grasp
                                         # _right_s 0.32-0.67, _left_s 0.26-0.62): at the right's 0.58 the left hand's
                                         # reaches measured 0.63-0.67 s
OFF_AT_S = 0.3               # the hand moves up off a strap this long after it is set down (opened in place first, from
                             # 0.45 s, the fingers swung into the strap's heel, 4.4-6 mm of skin)
OPEN_AFTER_S = 0.2           # ... its fingers held in the grip's shape this long as it comes up, clear of the strap's
                             # top, then opened: opening as it came straight up, the right hand's index swung into the
                             # heel's end, 4.3 mm of skin
NUT_CLEAR_MM = 4.0           # the fingers kept this far off the nut
BOARD_CLEAR_MM = 4.0         # ... and off the spoilboard


def side_of(clamp: SB.Clamp) -> str:
    """The hand that works a clamp: the one on its end's side."""
    return "R" if clamp.stud[0] > LUMBAR[0] else "L"


def grip_spec(take: StepTake, clamp: SB.Clamp, state: str, plate: SB.Plate | None) -> dict:
    """The pinch on a clamp's strap in a pose: thumb on its side toward the operator's middle, index and middle on the
    far side, behind the stud; solved among the strap, the spoilboard, the heel block, the nut and the plate."""
    h = take.hand
    at, R = clamp.pose(state)
    grab = at + R @ np.array([GRAB_MM, 0.0, 0.0])
    top = grab + R @ np.array([0.0, 0.0, SB.CLAMP_T / 2])
    across = R[:, 1]
    n_near = across if across[1] < 0 else -across          # the side facing the operator
    near = top + n_near * SB.CLAMP_W / 2 - R[:, 2] * 7.0
    far = top - n_near * SB.CLAMP_W / 2 - R[:, 2] * 7.0
    q0 = h.neutral()
    q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
              ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
              thumb_mcp_flex=20.0, thumb_ip=15.0)
    cols = [obox(at + R @ c, R, hh) for _, c, hh in SB.strap_boxes()]
    # no fingertip under the strap: the far fingers curled under its edge onto the heel block, and dragged on it
    cols.append(obox(at + R @ [0.0, 0.0, -SB.CLAMP_T / 2 - 15.0], R, [SB.CLAMP_L / 2, SB.CLAMP_W / 2 + 2.0, 15.0]))
    cols.append(obox(np.r_[SB.TABLE_MID, clamp.board_z - SB.SPOILBOARD_MM[2] / 2], np.eye(3),
                     SB.SPOILBOARD_MM / 2 + [0.0, 0.0, BOARD_CLEAR_MM]))      # and the little finger kept off the board
    u3 = np.r_[clamp.u, 0.0]
    steps = [(np.r_[clamp.stud, clamp.board_z + rise / 2] + u3 * (a + b) / 2, SB._rot(clamp.yaw),
              np.array([abs(b - a) / 2, SB.BLOCK_W / 2, rise / 2])) for a, b, rise in clamp.heel_steps()]
    cols += [obox(*s) for s in steps]

    def nut(z):
        return (np.r_[clamp.stud, z + (SB.FLANGE_T + SB.NUT_HEX_H) / 2], np.eye(3),
                np.array([SB.FLANGE_R, SB.FLANGE_R, (SB.FLANGE_T + SB.NUT_HEX_H) / 2]) + NUT_CLEAR_MM)
    cols.append(obox(*nut(clamp.nut_z(state))))
    fixed = [(np.r_[clamp.stud, clamp.board_z - 15.0], np.eye(3), np.array([150.0, 150.0, 15.0 + BOARD_CLEAR_MM])),
             *steps, nut(clamp.nut_z("parked"))]
    if plate is not None:
        cols.append(obox(plate.centre, np.eye(3), plate.size / 2))
        fixed.append((np.asarray(plate.centre, float), np.eye(3), np.asarray(plate.size, float) / 2))
    # and all of it as the strap sees it carried level over its place: the grip is solved where the strap lies, tipped,
    # and levelled the fingers come down on what lies under them (nist-ftc-09's pinch 5 mm lower over the board)
    for pc, Rc in (clamp.pose_at(SB.PARK_SLIDE_MM, CLEAR_MM), clamp.pose_at(0.0, CLEAR_MM)):
        M = R @ Rc.T
        cols += [obox(at + M @ (c - pc), M @ Rb, h) for c, Rb, h in fixed]
    S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
    lo, hi = DEPTH_MM
    k = PAD_IN_MM
    return dict(obj=grab, side=side_of(clamp), q0=q0, colliders=cols, load=SB.clamp_kg(),
                targets={"thumb": plane(near, n_near, k, local_bands(top, R, x=(-8, 8), depth=(lo, hi))),
                         # (the index's band stops 1 mm in from the heel's end: to 18 mm out it reached past it, and
                         # let go, it swung into the end, 3.6 mm of skin in it)
                         "index": plane(far, -n_near, k, local_bands(top, R, x=(-13, -2), depth=(lo, hi))),
                         "middle": plane(far, -n_near, k, local_bands(top, R, x=(2, 18), depth=(lo, hi)))},
                iters=1500, starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])


def path(clamp: SB.Clamp, t0: float) -> list[tuple[float, np.ndarray, np.ndarray]]:
    """The strap's path from parked to clamped from t0: up level and clear of the plate's top and the block, forward
    along its slot over the plate's end, down. Keys (t, frame, middle mm)."""
    p0, R0 = clamp.pose("parked")
    p1, R1 = clamp.pose_at(SB.PARK_SLIDE_MM, CLEAR_MM)
    p2, _ = clamp.pose_at(0.0, CLEAR_MM)
    p3, _ = clamp.pose_at()
    t1 = t0 + LEVEL_S
    t2 = t1 + SLIDE_S
    t3 = t2 + HOLD_S
    return [(t0, R0, p0), (t1, R1, p1), (t2, R1, p2), (t3, R1, p2), (t3 + DOWN_S, R1, p3)]


def settled(keys):
    """A strap's keys, held where it lands SET_S before it's let go."""
    t, R, p = keys[-1]
    return keys + [(t + SET_S, R, p)]


def on_keys(clamp: SB.Clamp, t0: float) -> list[tuple[float, np.ndarray, np.ndarray]]:
    """The strap's planned path from parked to clamped from t0 (path), held on its place a moment."""
    return settled(path(clamp, t0))


def off_keys(clamp: SB.Clamp, t0: float) -> list[tuple[float, np.ndarray, np.ndarray]]:
    """The strap's planned path from clamped back to parked from t0: path reversed in time, held where it's parked a
    moment."""
    keys = path(clamp, 0.0)
    T = keys[-1][0]
    return settled([(t0 + T - t, R, p) for t, R, p in reversed(keys)])


def key_at(keys, t: float) -> tuple[np.ndarray, np.ndarray]:
    """The strap's (frame, middle) at t along its keys: min-jerk between them, its turn slerped."""
    if t <= keys[0][0]:
        return keys[0][1], keys[0][2]
    for (a, Ra, pa), (b, Rb, pb) in zip(keys, keys[1:]):
        if a <= t < b:
            w = float(np.clip(min_jerk((t - a) / (b - a)), 0.0, 1.0))
            R = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([Ra, Rb])))([w]).as_matrix()[0]
            return R, pa + (pb - pa) * w
    return keys[-1][1], keys[-1][2]


def reach(take: StepTake, s: str, grip: str, t0: float, size_mm: float, obj=None, R=None,
          peak: float = SP.REACH_PEAK) -> tuple[float, np.ndarray]:
    """A hand's reach to a grip from wherever it is at t0, as the parallels' (motion/set_parallels.py reach), either
    hand: up to a ready point back from and over the grip, a pause, the paced reach down onto it, the fingers opening
    widest ~75% of the way for an object size_mm across. obj: where the grip's object is now (world), if it has
    moved since the grip was solved; R: how it has turned since (world); peak: where in the reach the fingers open
    widest. Returns when the reach ends (the grip closes) and the grip's wrist (world)."""
    g = take.grips[grip]
    H, W = take.grip_pose(grip, obj, R)                          # the side's (mirrored for the left) world
    Ww = take.at(s, W)                                           # ... as a world point
    ready = Ww + np.array([0.0, -120.0, 70.0])
    # a long way to the ready point taken no faster than the reach itself: from the hand hanging at rest in 1.2 s,
    # its peak speed was the reach's, and the reach was timed from it (2 s, not people's 0.3-0.7)
    here = take.at(s, take.side[s]["wrist"])
    far = float(np.linalg.norm(ready - here))
    t_ready = t0 + max(SP.RAISE_S, 1.875 * far / RAISE_PEAK_MM_S)
    # up and over to it, in an arc: straight from the hand hanging at rest, the fingers dragged over the plate's near
    # edge and the board's, and the arm caught on the table's front, 240 mm short of a far clamp
    over = (here + ready) / 2
    over[2] = max(here[2], ready[2]) + ARC_UP_MM
    take.transit(s, t0, t_ready, ready, via=[over] if far > 150.0 else ())
    take.add(s, t_ready, t_ready + SP.SETTLE_S, lambda tt, p=take.at(s, ready): [("pos", p, 1.0)])
    t_reach = t_ready + SP.SETTLE_S
    reach_s = REACH_S[s]
    take.transit(s, t_reach, t_reach + reach_s, Ww, via=[Ww + np.array([0.0, -10.0, 40.0])], fade=(H, 1.0))
    t_c = t_reach + reach_s
    take.fingers(s, t0 + 0.2, take.q_relax)
    take.fingers(s, t_reach, take.q_relax)
    take.fingers(s, t_reach + peak * reach_s, open_for(take.hand, g["q"], size_mm))
    take.fingers(s, t_c, g["q"])
    take.look(t0, Ww)
    return t_c, Ww


def move(take: StepTake, clamp: SB.Clamp, grip: str, t0: float, keys_from) -> tuple[float, list]:
    """One clamp moved by its side's hand from wherever that hand is at t0: the reach to the pinch (as the
    parallels': up to a ready point over it, a pause, the paced reach opening widest ~75% of the way), the grip
    firming, the strap carried along keys_from(t) (on_keys or off_keys), let go, and the hand up off it. The grip is
    solved where the strap starts. Returns when the hand is clear of it, and the strap's keys."""
    s = side_of(clamp)
    g = take.grips[grip]
    t_c, Ww = reach(take, s, grip, t0, SB.CLAMP_W)
    t_on = t_c - 0.1
    take.effort(s, t_c, 0.0, grip)
    take.effort(s, t_c + 0.2, 0.6, grip)
    t_load = t_c + SP.PRELOAD_S
    keys = keys_from(t_load + LIFT_DELAY_S)
    R0 = keys[0][1]
    grab = np.array([GRAB_MM, 0.0, 0.0])
    t_down = keys[-1][0]
    t_off = t_down + OFF_AT_S
    take.follow(s, t_c, t_off, grip, lambda tt: (lambda R, p: p + R @ grab)(*key_at(keys, tt)),
                lambda tt: key_at(keys, tt)[0] @ R0.T)
    take.load(s, t_load, t_down, SB.clamp_kg())
    take.event("grip", t_on, t_down + 0.25, side=s, grip=grip, on=clamp.name)
    take.event("carry", t_load, t_down, side=s, obj=clamp.name)
    take.effort(s, t_down - 0.1, 0.6, grip)
    take.effort(s, t_down + 0.2, 0.0, None)
    take.fingers(s, t_down + 0.25, g["q"])
    take.fingers(s, t_off + OPEN_AFTER_S, g["q"])
    take.fingers(s, t_off + OPEN_AFTER_S + 0.25, open_like(take.hand, g["q"], 0.4))
    R1, p1 = key_at(keys, t_down)
    H1, W1 = take.grip_pose(grip, p1 + R1 @ grab, R1 @ R0.T)
    # straight up off it: drawn back toward the operator as it rose, the far fingers dragged the strap's heel and
    # turned it 0.35-0.45 deg on its stud
    off = W1 + np.array([0.0, 0.0, 90.0])
    take.add(s, t_off, t_off + 0.5, lambda tt, a=t_off, H1=H1, W1=W1, off=off:
             [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
    take.side[s]["wrist"] = off
    return t_off + 0.5, keys
