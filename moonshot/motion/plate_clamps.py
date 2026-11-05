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

LUMBAR = np.array([-381.0, -980.0, 955.0])   # in the doorway, square to the table's middle: either hand reaches its
                                             # end's clamps (planner, 2026-11-04)
GRAB_MM = -36.0              # the pinch's middle this far along the strap from its middle (toward the heel): behind
                             # the stud, clear of the nut's flange both parked and clamped
DEPTH_MM = (3.0, 7.0)        # the pads this far down the strap's sides from its top, well above what it rests on
CLEAR_MM = 5.0               # the strap carried this high over where it lands: the pads clear the plate and the block
                             # (at 3, the physics hand ran 2-3 mm low and dragged the heel along the block)
LEVEL_S, SLIDE_S, HOLD_S, DOWN_S = 1.0, 1.2, 0.4, 0.8     # unhurried, and a pause over its place while the eye lines it
                                                          # up: in 2.0 s it landed 4.2 mm long
NUT_CLEAR_MM = 4.0           # the fingers kept this far off the nut


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
                     SB.SPOILBOARD_MM / 2 + [0.0, 0.0, 4.0]))         # and the little finger kept off the board
    u3 = np.r_[clamp.u, 0.0]
    for a, b, rise in clamp.heel_steps():
        mid = np.r_[clamp.stud, clamp.board_z + rise / 2] + u3 * (a + b) / 2
        cols.append(obox(mid, SB._rot(clamp.yaw), [abs(b - a) / 2, SB.BLOCK_W / 2, rise / 2]))
    nz = clamp.nut_z(state)
    cols.append(obox(np.r_[clamp.stud, nz + (SB.FLANGE_T + SB.NUT_HEX_H) / 2], np.eye(3),
                     np.array([SB.FLANGE_R, SB.FLANGE_R, (SB.FLANGE_T + SB.NUT_HEX_H) / 2]) + NUT_CLEAR_MM))
    if plate is not None:
        cols.append(obox(plate.centre, np.eye(3), plate.size / 2))
    S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
    lo, hi = DEPTH_MM
    return dict(obj=grab, side=side_of(clamp), q0=q0, colliders=cols, load=SB.clamp_kg(),
                targets={"thumb": plane(near, n_near, 1.5, local_bands(top, R, x=(-8, 8), depth=(lo, hi))),
                         "index": plane(far, -n_near, 1.5, local_bands(top, R, x=(-18, -2), depth=(lo, hi))),
                         "middle": plane(far, -n_near, 1.5, local_bands(top, R, x=(2, 18), depth=(lo, hi)))},
                iters=1500, starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])


def on_keys(clamp: SB.Clamp, t0: float) -> list[tuple[float, np.ndarray, np.ndarray]]:
    """The strap's planned path from parked to clamped from t0: up level and clear of the plate's top and the block,
    forward along its slot over the plate's end, down. Keys (t, frame, middle mm)."""
    p0, R0 = clamp.pose("parked")
    p1, R1 = clamp.pose_at(SB.PARK_SLIDE_MM, CLEAR_MM)
    p2, _ = clamp.pose_at(0.0, CLEAR_MM)
    p3, _ = clamp.pose_at()
    t1 = t0 + LEVEL_S
    t2 = t1 + SLIDE_S
    t3 = t2 + HOLD_S
    return [(t0, R0, p0), (t1, R1, p1), (t2, R1, p2), (t3, R1, p2), (t3 + DOWN_S, R1, p3)]


def off_keys(clamp: SB.Clamp, t0: float) -> list[tuple[float, np.ndarray, np.ndarray]]:
    """The strap's planned path from clamped back to parked from t0: on_keys reversed in time."""
    keys = on_keys(clamp, 0.0)
    T = keys[-1][0]
    return [(t0 + T - t, R, p) for t, R, p in reversed(keys)]


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


def move(take: StepTake, clamp: SB.Clamp, grip: str, t0: float, keys_from) -> tuple[float, list]:
    """One clamp moved by its side's hand from wherever that hand is at t0: the reach to the pinch (as the
    parallels': up to a ready point over it, a pause, the paced reach opening widest ~75% of the way), the grip
    firming, the strap carried along keys_from(t) (on_keys or off_keys), let go, and the hand up off it. The grip is
    solved where the strap starts. Returns when the hand is clear of it, and the strap's keys."""
    s = side_of(clamp)
    g = take.grips[grip]
    H, W = take.grip_pose(grip)                                 # the side's (mirrored for the left) world
    Ww = take.at(s, W)                                          # ... as a world point
    ready = Ww + np.array([0.0, -120.0, 70.0])
    t_ready = t0 + SP.RAISE_S
    take.transit(s, t0, t_ready, ready)
    take.add(s, t_ready, t_ready + SP.SETTLE_S, lambda tt, p=take.at(s, ready): [("pos", p, 1.0)])
    t_reach = t_ready + SP.SETTLE_S
    take.transit(s, t_reach, t_reach + SP.REACH_S, Ww, via=[Ww + np.array([0.0, -10.0, 40.0])], fade=(H, 1.0))
    t_c = t_reach + SP.REACH_S
    take.fingers(s, t0 + 0.2, take.q_relax)
    take.fingers(s, t_reach, take.q_relax)
    take.fingers(s, t_reach + SP.REACH_PEAK * SP.REACH_S, open_for(take.hand, g["q"], SB.CLAMP_W))
    take.fingers(s, t_c, g["q"])
    t_on = t_c - 0.1
    take.effort(s, t_c, 0.0, grip)
    take.effort(s, t_c + 0.2, 0.6, grip)
    t_load = t_c + SP.PRELOAD_S
    keys = keys_from(t_load + SP.LIFT_DELAY_S)
    R0 = keys[0][1]
    grab = np.array([GRAB_MM, 0.0, 0.0])
    take.follow(s, t_c, keys[-1][0] + 0.3, grip, lambda tt: (lambda R, p: p + R @ grab)(*key_at(keys, tt)),
                lambda tt: key_at(keys, tt)[0] @ R0.T)
    t_down = keys[-1][0]
    take.load(s, t_load, t_down, SB.clamp_kg())
    take.event("grip", t_on, t_down + 0.25, side=s, grip=grip, on=clamp.name)
    take.event("carry", t_load, t_down, side=s, obj=clamp.name)
    take.effort(s, t_down - 0.1, 0.6, grip)
    take.effort(s, t_down + 0.2, 0.0, None)
    take.fingers(s, t_down + 0.25, g["q"])
    take.fingers(s, t_down + 0.6, open_like(take.hand, g["q"], 0.4))
    R1, p1 = key_at(keys, t_down)
    H1, W1 = take.grip_pose(grip, p1 + R1 @ grab, R1 @ R0.T)
    off = W1 + np.array([0.0, -30.0, 90.0])
    take.add(s, t_down + 0.3, t_down + 0.8, lambda tt, a=t_down + 0.3, H1=H1, W1=W1, off=off:
             [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
    take.side[s]["wrist"] = off
    take.look(t0, Ww)
    return t_down + 0.8, keys
