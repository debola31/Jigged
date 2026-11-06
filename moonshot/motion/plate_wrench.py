"""Running the step clamps' nuts down and snugging them with the 3/4 in ratcheting combination wrench (moonshot/world/
wrench.py), and breaking them loose and running them up (the user's decisions, 2026-11-05: the wrench does it all, no
fingertip spin; a ratcheting one, the plain box end's lift-and-reseat strokes failing on the far nuts): the right
hand picks the wrench up off the plate by its handle and, on each nut in turn, sets the box end down over it and
turns it in short strokes, the box end staying on it: the handle swung STROKE about the stud (clockwise from above to
tighten, the other way to loosen), the ratchet driving the nut, and swung back, the ratchet freewheeling, the nut
lower (or higher) by its thread's run each stroke; a last swing snugs it (or a first one breaks it loose). Then it
lays the wrench back where it was. The wrench is welded to the hand while it is carried (carry_wrench, the declared
grip assist); its ring turns the nut by its flats on the nut's; the eye turns the wrench onto the flats as the box
end comes down (moonshot/sim/plate_clamps.py), as people find the flats with a wrench.
"""
from __future__ import annotations

import math

import numpy as np

from moonshot.motion import plate_clamps as PC
from moonshot.motion import set_parallels as SP
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.set_parallels import local_bands, obox, turned
from moonshot.motion.setup_take import plane
from moonshot.motion.step_take import StepTake
from moonshot.world import spoilboard as SB
from moonshot.world import wrench as WR

REST_IN_MM = 40.0                        # the wrench lies along the plate's near edge this far in, across its middle,
                                         # the handle to the right (nist-ftc-09's sheet is 343 mm long)
GRAB_MM = 135.0                          # the pinch on the handle this far from the box end's middle: choked up to 110 on a
                                         # far nut, the arm reached its full length at the stroke's end and stalled
                                         # 80-100 mm short of the handle; at 160 the hand met the near clamp's nut
OVER_MM = 15.0                           # the box end this high over the hex's top on its way to and from a nut
FLATS = math.pi / 3                      # the ring's flats a sixth of a turn apart: where it sits square on a nut
STROKE = math.radians(40.0)              # a stroke's swing, kept in front of the stud: the plain box end's sixth of a
                                         # turn took the arm to its full length on a far nut, and it stalled
SNUG = math.radians(25.0)                # the last swing, that snugs a nut run down onto its strap (or the first, that
                                         # breaks it loose)
LIFT_S, MOVE_S, OVER_S, DOWN_S = 0.5, 1.2, 0.5, 0.8     # up off the plate, over to a nut, held over it while the
                                                         # eye lines the box end up on it, and down onto it
SWING_S, BACK_S, UP_S = 0.5, 0.35, 0.3   # a stroke swung, and back, the ratchet freewheeling; up off the nut after
EFFORT = 0.8                 # the hand's hold on the handle while it strokes, the arm braced with it (0.6 for a clamp)
DWELL_S = 0.15               # ... and settled on the flats before it's swung: swung as it came down, a box end not yet
                             # down past its chamfer was tipped off the nut
PINCH_W = 4.0                # the planned pinch kept on the handle's arc while the hand strokes (use), against the pose


def rest(plate: SB.Plate) -> tuple[np.ndarray, float]:
    """Where the wrench lies on the plate before and after (its box end's middle mm, its yaw)."""
    return WR.resting(plate.top, (plate.centre[0] - (WR.LENGTH - 12.0) / 2,
                                  plate.centre[1] - plate.size[1] / 2 + REST_IN_MM), 0.0)


def grab_at() -> np.ndarray:
    """The pinch's middle on the handle, in the wrench's frame (mm)."""
    return np.array([GRAB_MM, 0.0, 0.0])


def grip_spec(take: StepTake, plate: SB.Plate) -> dict:
    """The right hand's pinch on the handle where the wrench lies: thumb on its near edge, index and middle on its far
    edge, across its width."""
    h = take.hand
    p, yaw = rest(plate)
    R = turned(yaw)
    g = p + R @ grab_at()
    half_w = WR.HANDLE_W / 2
    top = g + [0.0, 0.0, WR.HANDLE_T / 2]
    near, far = g - R[:, 1] * half_w, g + R[:, 1] * half_w
    q0 = h.neutral()
    q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
              ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
              thumb_mcp_flex=20.0, thumb_ip=15.0)
    cols = [obox(p + R @ c, R @ Rb, hh) for _, c, hh, Rb in WR.boxes()]
    cols.append(obox(plate.centre, np.eye(3), plate.size / 2))
    S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
    depth = (1.0, 4.0)
    return dict(obj=g, side="R", q0=q0, colliders=cols, load=WR.kg(),
                targets={"thumb": plane(near, -R[:, 1], 1.0, local_bands(top, R, x=(-8, 8), depth=depth)),
                         "index": plane(far, R[:, 1], 1.0, local_bands(top, R, x=(-18, -2), depth=depth)),
                         "middle": plane(far, R[:, 1], 1.0, local_bands(top, R, x=(2, 18), depth=depth))},
                iters=1500, starts=[S(20, 0, r, 50, 50, -15, 65, pr, -10, 5) for pr in (0, 35, 60) for r in (0, 15)])


def on_nut(clamp: SB.Clamp, yaw: float, nut_z: float, lift: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """The wrench's frame and box end's middle seated over a clamp's nut whose flange's underside is at nut_z, turned
    yaw, raised lift."""
    return turned(yaw), np.r_[clamp.stud, nut_z + SB.FLANGE_T + WR.HEIGHT / 2 + 0.5 + lift]


def nut_yaw(clamp: SB.Clamp, plate: SB.Plate, direction: str = "tighten") -> float:
    """The handle's yaw where the box end is set down on a nut and each stroke starts: square on the flats of a nut
    at turn 0 (the eye finds where they really are), the strokes swinging the handle across in front of the stud, the
    hand pulling it toward the operator: tightening, from pointing back toward the operator and out to the right on the
    right end's (from pointing in toward the plate's middle on the left end's); loosening, from a sixth of a turn
    further round, back the other way."""
    y = 0.0 if clamp.stud[0] < plate.centre[0] else -FLATS
    return y if direction == "tighten" else y - FLATS


def strokes(direction: str, gap_mm: float = SB.PARK_NUT_GAP_MM) -> list[float]:
    """Each stroke's turn of the nut (rad, negative clockwise from above) to run it gap_mm (by default from parked)
    down onto its strap and snug it ("tighten"), or to break it loose and run it back up gap_mm ("loosen")."""
    run = SB.LEAD_MM * STROKE / (2 * math.pi)
    n = int(gap_mm // run)
    rest_turn = (gap_mm - n * run) / SB.LEAD_MM * 2 * math.pi + SNUG
    tighten = [-STROKE] * n + [-rest_turn]
    return tighten if direction == "tighten" else [-a for a in reversed(tighten)]


def keys(plate: SB.Plate, clamps: list[SB.Clamp], t0: float, direction: str = "tighten",
         gap_mm: float = SB.PARK_NUT_GAP_MM):
    """The wrench's planned path from t0, (t, frame, box end's middle) keys; each stroke's (clamp, t0, t1, rad); and
    each nut's work on it (clamp, t0, t1): up off the plate, over each nut in turn, held there a moment, and down onto
    it; each stroke swung about the stud by the nut's turn rad (the first by the ring's play on the nut too), the nut
    running down (or up) its thread with it, and swung back, the box end staying on the nut, the ratchet freewheeling;
    up off it after its last; then back down where it lay."""
    p0, y0 = rest(plate)
    R0 = turned(y0)
    k = [(t0, R0, p0), (t0 + LIFT_S, R0, p0 + [0.0, 0.0, 40.0])]
    t = t0 + LIFT_S
    done, work = [], []
    swings = strokes(direction, gap_mm)
    for c in clamps:
        start = nut_yaw(c, plate, direction)
        z = c.nut_z("clamped") + (gap_mm if direction == "tighten" else 0.0)
        Ra, pa = on_nut(c, start, z, OVER_MM + SB.NUT_HEX_H)
        Rs, ps = on_nut(c, start, z)
        k += [(t + MOVE_S, Ra, pa), (t + MOVE_S + OVER_S, Ra, pa), (t + MOVE_S + OVER_S + DOWN_S, Rs, ps),
              (t + MOVE_S + OVER_S + DOWN_S + DWELL_S, Rs, ps)]
        t += MOVE_S + OVER_S + DOWN_S + DWELL_S
        t_on = t
        for i, a in enumerate(swings):
            z1 = z + SB.LEAD_MM * a / (2 * math.pi)                  # the nut's run with the swing
            b = start + a + (math.copysign(WR.play(), a) if i == 0 else 0.0)   # the ring's play taken up once
            k.append((t + SWING_S, turned(b), on_nut(c, b, z1)[1]))
            done.append((c, t, t + SWING_S, a))
            t += SWING_S
            if i < len(swings) - 1:                                  # back, the box end on the nut
                k.append((t + BACK_S, Rs, on_nut(c, start, z1)[1]))
                t += BACK_S
            z = z1
        work.append((c, t_on, t))
        Ru, pu = on_nut(c, b, z, OVER_MM + SB.NUT_HEX_H)
        k.append((t + UP_S, Ru, pu))
        t += UP_S
    k += [(t + MOVE_S, R0, p0 + [0.0, 0.0, 40.0]), (t + MOVE_S + LIFT_S, R0, p0)]
    return k, done, work


def use(take: StepTake, plate: SB.Plate, clamps: list[SB.Clamp], t0: float, direction: str = "tighten",
        grip: str = "wrench_R", gap_mm: float = SB.PARK_NUT_GAP_MM) -> tuple[float, list]:
    """The right hand from wherever it is at t0: the reach to the wrench's handle (as a clamp's), the pinch firming,
    the wrench carried along its keys, turning each nut in turn, and laid back down, let go, and the hand up off it.
    Returns when the hand is clear of it, and the wrench's keys."""
    g = take.grips[grip]
    p_rest, y_rest = rest(plate)
    t_c, _ = PC.reach(take, "R", grip, t0, WR.HANDLE_W, obj=p_rest + turned(y_rest) @ grab_at())
    take.effort("R", t_c, 0.0, grip)
    take.effort("R", t_c + 0.2, EFFORT, grip)
    t_load = t_c + SP.PRELOAD_S
    k, swings, work = keys(plate, clamps, t_load + SP.LIFT_DELAY_S, direction, gap_mm)
    R0 = k[0][1]
    grab = grab_at()
    take.follow("R", t_c, k[-1][0] + 0.3, grip, lambda tt: (lambda R, p: p + R @ grab)(*PC.key_at(k, tt)),
                lambda tt: PC.key_at(k, tt)[0] @ R0.T)
    # while it works a nut, the pinch held on the handle's arc about the stud, the hand's turn about the vertical free
    # (the handle turns in the fist): followed by the hand's pose alone, the planned hand turned 30 deg past the
    # stroke while its wrist kept to it, its pinch 70 mm off the arc, and the box end, on the nut, swung with it
    pinch = np.asarray(g["H"], float).T @ (np.asarray(g["obj"], float) - np.asarray(g["W"], float))
    up = np.asarray(g["H"], float).T @ np.array([0.0, 0.0, 1.0])
    for c, a, b in work:
        take.add("R", a, b, lambda tt: [("tsr", pinch, (lambda R, p: p + R @ grab)(*PC.key_at(k, tt)), up,
                                          np.array([0.0, 0.0, 1.0]), PINCH_W)])
    t_down = k[-1][0]
    take.load("R", t_load, t_down, WR.kg())
    take.event("grip", t_c - 0.1, t_down + 0.25, side="R", grip=grip, on="wrench")
    take.event("carry", t_load, t_down, side="R", obj="wrench")
    looked = set()
    for c, a, b, rad in swings:
        if c.name not in looked:                                     # the eye on each nut as the wrench goes to it
            looked.add(c.name)
            take.look(a - DWELL_S - DOWN_S - OVER_S - MOVE_S / 2, np.r_[c.stud, c.nut_z("clamped")])
        take.event("turn_nut", a, b, side="R", obj=f"{c.name}_nut", rad=rad)
    for c, a, b in work:          # the box end on the nut, the ratchet set to drive it this way (its reversing lever)
        take.event("work_nut", a, b, side="R", obj=f"{c.name}_nut", direction=direction)
    take.effort("R", t_down - 0.1, EFFORT, grip)
    take.effort("R", t_down + 0.2, 0.0, None)
    take.fingers("R", t_down + 0.25, g["q"])
    take.fingers("R", t_down + 0.6, open_like(take.hand, g["q"], 0.4))
    R1, p1 = PC.key_at(k, t_down)
    H1, W1 = take.grip_pose(grip, p1 + R1 @ grab, R1 @ R0.T)
    off = W1 + np.array([0.0, -30.0, 90.0])
    take.add("R", t_down + 0.3, t_down + 0.8, lambda tt, a=t_down + 0.3: [
        ("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
    take.side["R"]["wrist"] = off
    return t_down + 0.8, k
