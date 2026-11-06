"""Running the step clamps' nuts down and snugging them with the 3/4 in ratcheting combination wrench (moonshot/world/
wrench.py), and breaking them loose and running them up (the user's decisions, 2026-11-05: the wrench does it all, no
fingertip spin; a ratcheting one, the plain box end's lift-and-reseat strokes failing on the far nuts): each end's
own hand in turn (by_hand, use_ends) picks the wrench up off the plate by its handle and, on each of that end's nuts
in turn, sets the box end down over it and turns it in short strokes, the box end staying on it: the handle swung
STROKE about the stud (clockwise from above to tighten, the other way to loosen), the ratchet driving the nut, and
swung back, the ratchet freewheeling, the nut lower (or higher) by its thread's run each stroke; a last swing snugs
it (or a first one breaks it loose). Then it lays the wrench back where it was. The wrench is welded to the hand
while it is carried (carry_wrench_R, carry_wrench_L, the declared grip assist); its ring turns the nut by its flats
on the nut's; the eye turns the wrench onto the flats as the box end comes down (moonshot/sim/plate_clamps.py), as
people find the flats with a wrench.
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
STUD_CLEAR_MM = 8.0                      # ... and the wrench's underside this far over the studs' tops while carried:
                                         # nist-ftc-09's studs stand 20 mm over a parked nut's hex, and carried 15 mm
                                         # over it, the head and handle caught the right end's studs on the way to the
                                         # far nut, the box end came down off it, swung loose and dragged the sheet
FLATS = math.pi / 3                      # the ring's flats a sixth of a turn apart: where it sits square on a nut
STROKE = math.radians(40.0)              # a stroke's swing, kept in front of the stud: the plain box end's sixth of a
                                         # turn took the arm to its full length on a far nut, and it stalled
SNUG = math.radians(12.0)                # the last swing past a nut's run onto its strap, that snugs it (or the first,
                                         # that breaks it loose): at 25, the hand stalled on the snug nut pulled the
                                         # wrist's muscles to twice their most
SNUG_MARGIN = 1.25                       # tightening, strokes enough to run a nut this many times its gap: the hand
                                         # pulls till the nut is snug, the strokes past it stalling on it, as people
                                         # feel a nut come snug. Counted to the gap, a hand's strokes on a far nut
                                         # turned it 7-13 deg a stroke short of their plan or past it (by where the
                                         # flats set the box end down, and the arm at its reach), and the nut stood
                                         # 1 mm off its strap, or seated early and slipped its thread
LIFT_S, MOVE_S, OVER_S, DOWN_S = 0.4, 1.2, 0.5, 0.8     # up off the plate (in 0.5, it came up 267 ms after the
                                                         # hand took it, past people's 265), over to a nut, held over
                                                         # it while the eye lines the box end up on it, down onto it
SWING_S, BACK_S, UP_S = 0.7, 0.35, 0.3   # a stroke swung, and back, the ratchet freewheeling; up off the nut after
                                         # (swung in 0.5 s, on a far nut at the arm's reach the hand ran 8-13 deg past
                                         # each stroke, the nut seated early and the strokes after slipped its thread)
EFFORT = 0.8                 # the hand's hold on the handle while it strokes, the arm braced with it (0.6 for a clamp)
DWELL_S = 0.15               # ... and settled on the flats before it's swung: swung as it came down, a box end not yet
                             # down past its chamfer was tipped off the nut
PINCH_W = 4.0                # the planned pinch kept on the handle's arc while the hand strokes (use), against the pose
REACH_PEAK = {"R": SP.REACH_PEAK, "L": 0.8}   # where in its reach for the handle each hand opens widest (people's
                                               # 71-77%, person.peak_aperture_reach_frac): the left's from where it
                                               # hung, at the right's 0.76, measured widest at 70%
PAD_IN_MM = 0.5              # the pinch's pads this far into the handle's edges as it is solved: at 1.0, gripped with
                             # EFFORT through the strokes, the left hand's skin stood 3.4-3.6 mm in it (the limit 3.5)


def rest(plate: SB.Plate) -> tuple[np.ndarray, float]:
    """Where the wrench lies on the plate before and after (its box end's middle mm, its yaw)."""
    return WR.resting(plate.top, (plate.centre[0] - (WR.LENGTH - 12.0) / 2,
                                  plate.centre[1] - plate.size[1] / 2 + REST_IN_MM), 0.0)


def grab_at() -> np.ndarray:
    """The pinch's middle on the handle, in the wrench's frame (mm)."""
    return np.array([GRAB_MM, 0.0, 0.0])


def grip_at(plate: SB.Plate, nuts: list[SB.Clamp], side: str, direction: str = "tighten") -> tuple[np.ndarray, float]:
    """Where the wrench stands as a hand's pinch on it is solved (its box end's middle mm, its yaw): on the hand's
    first nut (by_hand), seated, halfway through a stroke, where the hand works it. Solved where the wrench lies on
    the plate, the hand took it as a pickup there has it, and turned with it onto a nut: the right forearm pronated
    10 deg past people's range on the right end's nuts, the left wrist stood out past the stud on the left end's, and
    the trunk bent 12-15 deg to the side."""
    c = next(ns[0] for s, ns in by_hand(nuts) if s == side)
    sweep = STROKE / 2 * (-1 if direction == "tighten" else 1)
    z = c.nut_z("clamped") + (SB.PARK_NUT_GAP_MM / 2 if direction == "tighten" else 0.0)
    yaw = nut_yaw(c, plate, direction, next(ns for s, ns in by_hand(nuts) if s == side)) + sweep
    return on_nut(c, yaw, z)[1], yaw


def grip_spec(take: StepTake, plate: SB.Plate, side: str = "R", nuts: list[SB.Clamp] | None = None,
              direction: str = "tighten") -> dict:
    """A hand's pinch on the handle, where it works its first nut (grip_at; where the wrench lies if no nuts given):
    thumb on its near edge, index and middle on its far edge, across its width (the left hand's index on the right of
    its middle finger, the right's on the left), the box end on the nut; solved among the wrench, the plate, the
    spoilboard, and the nut's clamp. The take keeps where it was solved (wrench_grip_at), for use."""
    h = take.hand
    p, yaw = grip_at(plate, nuts, side, direction) if nuts else rest(plate)
    take.__dict__.setdefault("wrench_grip_at", {})[f"wrench_{side}"] = (p, yaw)
    R = turned(yaw)
    g = p + R @ grab_at()
    half_w = WR.HANDLE_W / 2
    top = g + [0.0, 0.0, WR.HANDLE_T / 2]
    near, far = g - R[:, 1] * half_w, g + R[:, 1] * half_w
    index, middle = ((-18, -2), (2, 18)) if side == "R" else ((2, 18), (-18, -2))
    q0 = h.neutral()
    q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
              ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
              thumb_mcp_flex=20.0, thumb_ip=15.0)
    cols = [obox(p + R @ c, R @ Rb, hh) for _, c, hh, Rb in WR.boxes()]
    cols.append(obox(plate.centre, np.eye(3), plate.size / 2))
    board = plate.bottom
    cols.append(obox(np.r_[SB.TABLE_MID, board - SB.SPOILBOARD_MM[2] / 2], np.eye(3), SB.SPOILBOARD_MM / 2))
    for c in nuts or ():                                     # the clamps, clamped, under the handle
        at, Rc = c.pose("clamped")
        cols += [obox(at + Rc @ b, Rc, hh) for _, b, hh in SB.strap_boxes()]
    S = lambda *a: list(a) + [0.0, 0.0]                                                         # noqa: E731
    depth = (1.0, 4.0)
    k = PAD_IN_MM
    return dict(obj=g, side=side, q0=q0, colliders=cols, load=WR.kg(),
                targets={"thumb": plane(near, -R[:, 1], k, local_bands(top, R, x=(-8, 8), depth=depth)),
                         "index": plane(far, R[:, 1], k, local_bands(top, R, x=index, depth=depth)),
                         "middle": plane(far, R[:, 1], k, local_bands(top, R, x=middle, depth=depth))},
                iters=1500, starts=[S(20, 0, r, 50, 50, -15, 65, pr, -10, 5) for pr in (0, 35, 60) for r in (0, 15)])


def on_nut(clamp: SB.Clamp, yaw: float, nut_z: float, lift: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """The wrench's frame and box end's middle seated over a clamp's nut whose flange's underside is at nut_z, turned
    yaw, raised lift."""
    return turned(yaw), np.r_[clamp.stud, nut_z + SB.FLANGE_T + WR.HEIGHT / 2 + 0.5 + lift]


def sweeps_clear(clamp: SB.Clamp, others: list[SB.Clamp], yaw0: float, sweep: float) -> bool:
    """Does the handle, swung about the clamp's stud from yaw0 by sweep (rad), keep clear of the other clamps' nuts
    (their flanges, PC.NUT_CLEAR_MM off)? It is carried at their height on its own nut, under their studs' tops."""
    _, c, hh, _ = next(b for b in WR.boxes() if b[0] == "handle")
    x0, x1 = c[0] - hh[0], c[0] + hh[0]
    for a in np.linspace(yaw0, yaw0 + sweep, 13):
        R = turned(a)[:2, :2]
        for o in others:
            if o is clamp:
                continue
            u, v = R.T @ (np.asarray(o.stud, float) - np.asarray(clamp.stud, float))   # in the wrench's frame
            if math.hypot(max(x0 - u, 0.0, u - x1), max(abs(v) - hh[1], 0.0)) < SB.FLANGE_R + PC.NUT_CLEAR_MM:
                return False
    return True


def nut_yaw(clamp: SB.Clamp, plate: SB.Plate, direction: str = "tighten", others: list[SB.Clamp] = ()) -> float:
    """The handle's yaw where the box end is set down on a nut and each stroke starts: square on the flats of a nut
    at turn 0 (the eye finds where they really are), the strokes swinging the handle across in front of the stud, the
    end's own hand (by_hand) pulling it toward the operator. Tightening, clockwise from above: on the right end's from
    pointing back toward the operator and out to the right, on the left end's from pointing in toward the plate's
    middle. Loosening, the other way, on either end from pointing back toward the operator and to the left. Where the
    handle so swung would meet another clamp's nut (others; sweeps_clear), from a sixth of a turn round: on
    nist-ftc-09's ends, three clamps 125 mm apart, the right end's strokes from pointing back toward the operator ran
    the handle into the next nut nearer the operator, and stopped there, the nut turned half as far. (From pointing
    back and in on the right end's, the far nut beyond the arm's reach, the strokes didn't turn it; loosening the left
    end's a sixth of a turn round from its tightening, the strokes pushed the handle away.)"""
    if direction == "tighten":
        firsts = [-FLATS, 0.0] if clamp.stud[0] > plate.centre[0] else [0.0, -FLATS]
    else:
        firsts = [-2 * FLATS, -3 * FLATS]
    sweep = (STROKE + SNUG + WR.play()) * (-1 if direction == "tighten" else 1)
    return next((y for y in firsts if sweeps_clear(clamp, list(others), y, sweep)), firsts[0])


def by_hand(clamps: list[SB.Clamp]) -> list[tuple[str, list[SB.Clamp]]]:
    """Each end's nuts and the hand that runs them, in turn: the right end's by the right hand, far then near, then the
    left end's by the left, near then far. Each end's own hand, as the clamps' (moonshot/motion/plate_clamps.py): the
    right hand on the left end's nuts reached across the body, and the trunk turned and bent 15-19 deg left, past
    people's range (nist-ftc-09 from the doorway's middle, ll-1005337 from in front of its left end)."""
    right = sorted([c for c in clamps if PC.side_of(c) == "R"], key=lambda c: -c.stud[1])
    left = sorted([c for c in clamps if PC.side_of(c) == "L"], key=lambda c: c.stud[1])
    return [(s, nuts) for s, nuts in (("R", right), ("L", left)) if nuts]


def strokes(direction: str, gap_mm: float = SB.PARK_NUT_GAP_MM) -> list[float]:
    """Each stroke's turn of the nut (rad, negative clockwise from above) to run it gap_mm (by default from parked)
    down onto its strap and snug it ("tighten": strokes enough for SNUG_MARGIN times the gap, the hand pulling till
    the nut is snug, the strokes past it stalling on it), or to break it loose and run it back up gap_mm ("loosen")."""
    run = SB.LEAD_MM * STROKE / (2 * math.pi)
    reach = gap_mm * (SNUG_MARGIN if direction == "tighten" else 1.0)
    n = int(reach // run)
    rest_turn = (reach - n * run) / SB.LEAD_MM * 2 * math.pi + SNUG
    tighten = [-STROKE] * n + [-rest_turn]
    return tighten if direction == "tighten" else [-a for a in reversed(tighten)]


def keys(plate: SB.Plate, clamps: list[SB.Clamp], t0: float, direction: str = "tighten",
         gap_mm: float = SB.PARK_NUT_GAP_MM):
    """The wrench's planned path from t0, (t, frame, box end's middle) keys; each stroke's (clamp, t0, t1, rad); and
    each nut's work on it (clamp, t0, t1): up off the plate, over each nut in turn, held there a moment, and down onto
    it; each stroke swung about the stud by the nut's turn rad (the first by the ring's play on the nut too), the nut
    running down (or up) its thread with it, and swung back, the box end staying on the nut, the ratchet freewheeling;
    up off it after its last; then back down where it lay. Carried, the wrench is clear of the studs' tops
    (STUD_CLEAR_MM)."""
    p0, y0 = rest(plate)
    R0 = turned(y0)
    high = max(c.stud_z()[1] for c in clamps) + STUD_CLEAR_MM + WR.HEIGHT / 2     # its middle, carried
    up = lambda p: np.r_[p[:2], max(p[2], high)]                                # noqa: E731
    k = [(t0, R0, p0), (t0 + LIFT_S, R0, up(p0 + [0.0, 0.0, 40.0]))]
    t = t0 + LIFT_S
    done, work = [], []
    swings = strokes(direction, gap_mm)
    for c in clamps:
        start = nut_yaw(c, plate, direction, clamps)
        z = c.nut_z("clamped") + (gap_mm if direction == "tighten" else 0.0)
        Ra, pa = on_nut(c, start, z, OVER_MM + SB.NUT_HEX_H)
        pa = up(pa)
        Rs, ps = on_nut(c, start, z)
        k += [(t + MOVE_S, Ra, pa), (t + MOVE_S + OVER_S, Ra, pa), (t + MOVE_S + OVER_S + DOWN_S, Rs, ps),
              (t + MOVE_S + OVER_S + DOWN_S + DWELL_S, Rs, ps)]
        t += MOVE_S + OVER_S + DOWN_S + DWELL_S
        t_on = t
        seated = c.nut_z("clamped") - SB.LEAD_MM * SNUG / (2 * math.pi)     # snug on its strap, its bite taken
        for i, a in enumerate(swings):
            z1 = z + SB.LEAD_MM * a / (2 * math.pi)                  # the nut's run with the swing, to its strap
            if direction == "tighten":
                z1 = max(z1, seated)
            b = start + a + math.copysign(WR.play(), a)   # the ring's play on the nut taken up each stroke: swung
                                                          # back, the ratchet's drag turns the ring back through it
            k.append((t + SWING_S, turned(b), on_nut(c, b, z1)[1]))
            done.append((c, t, t + SWING_S, a))
            t += SWING_S
            # back, the box end on the nut, the ratchet freewheeling; after the last, eased off the snug nut too before
            # it's lifted (lifted at the snug's end, the hand held there sprang up off it)
            k.append((t + BACK_S, Rs, on_nut(c, start, z1)[1]))
            t += BACK_S
            z = z1
        work.append((c, t_on, t))
        Ru, pu = on_nut(c, start, z, OVER_MM + SB.NUT_HEX_H)
        k.append((t + UP_S, Ru, up(pu)))
        t += UP_S
    k += [(t + MOVE_S, R0, up(p0 + [0.0, 0.0, 40.0])), (t + MOVE_S + LIFT_S, R0, p0)]
    return k, done, work


def use(take: StepTake, plate: SB.Plate, clamps: list[SB.Clamp], t0: float, direction: str = "tighten",
        grip: str | None = None, gap_mm: float = SB.PARK_NUT_GAP_MM, side: str = "R") -> tuple[float, list]:
    """A hand (the right, or the left on a long plate's left end's nuts, in that end's own take: moonshot/motion/
    plate_seat.py) from wherever it is at t0: the reach to the wrench's handle (as a clamp's), the pinch firming, the
    wrench carried along its keys, turning each nut in turn, and laid back down, let go, and the hand up off it.
    Returns when the hand is clear of it, and the wrench's keys."""
    grip = grip or f"wrench_{side}"
    g = take.grips[grip]
    p_rest, y_rest = rest(plate)
    # the grip's frame as it was solved (grip_spec: on the hand's first nut, or where the wrench lies)
    R0 = turned(take.__dict__.get("wrench_grip_at", {}).get(grip, rest(plate))[1])
    t_c, _ = PC.reach(take, side, grip, t0, WR.HANDLE_W, obj=p_rest + turned(y_rest) @ grab_at(),
                      R=turned(y_rest) @ R0.T, peak=REACH_PEAK[side])
    take.effort(side, t_c, 0.0, grip)
    take.effort(side, t_c + 0.2, EFFORT, grip)
    t_load = t_c + SP.PRELOAD_S
    k, swings, work = keys(plate, clamps, t_load + SP.LIFT_DELAY_S, direction, gap_mm)
    grab = grab_at()
    take.follow(side, t_c, k[-1][0] + 0.3, grip, lambda tt: (lambda R, p: p + R @ grab)(*PC.key_at(k, tt)),
                lambda tt: PC.key_at(k, tt)[0] @ R0.T)
    # while it works a nut, the pinch held on the handle's arc about the stud, the hand's turn about the vertical free
    # (the handle turns in the fist): followed by the hand's pose alone, the planned hand turned 30 deg past the
    # stroke while its wrist kept to it, its pinch 70 mm off the arc, and the box end, on the nut, swung with it
    # (the grip's frame, and the arc's points, in the side's world: the left hand's mirrored)
    pinch = np.asarray(g["H"], float).T @ (np.asarray(g["obj"], float) - np.asarray(g["W"], float))
    up = np.asarray(g["H"], float).T @ np.array([0.0, 0.0, 1.0])
    for c, a, b in work:
        take.add(side, a, b, lambda tt: [("tsr", pinch, take.at(side, (lambda R, p: p + R @ grab)(*PC.key_at(k, tt))),
                                          up, np.array([0.0, 0.0, 1.0]), PINCH_W)])
    t_down = k[-1][0]
    take.load(side, t_load, t_down, WR.kg())
    take.event("grip", t_c - 0.1, t_down + 0.25, side=side, grip=grip, on="wrench")
    take.event("carry", t_load, t_down, side=side, obj="wrench")
    looked = set()
    for c, a, b, rad in swings:
        if c.name not in looked:                                     # the eye on each nut as the wrench goes to it
            looked.add(c.name)
            take.look(a - DWELL_S - DOWN_S - OVER_S - MOVE_S / 2, np.r_[c.stud, c.nut_z("clamped")])
        take.event("turn_nut", a, b, side=side, obj=f"{c.name}_nut", rad=rad)
    for c, a, b in work:          # the box end on the nut, the ratchet set to drive it this way (its reversing lever)
        take.event("work_nut", a, b, side=side, obj=f"{c.name}_nut", direction=direction)
    take.effort(side, t_down - 0.1, EFFORT, grip)
    take.effort(side, t_down + 0.2, 0.0, None)
    take.fingers(side, t_down + 0.25, g["q"])
    take.fingers(side, t_down + 0.6, open_like(take.hand, g["q"], 0.4))
    R1, p1 = PC.key_at(k, t_down)
    H1, W1 = take.grip_pose(grip, p1 + R1 @ grab, R1 @ R0.T)
    off = W1 + np.array([0.0, -30.0, 90.0])
    take.add(side, t_down + 0.3, t_down + 0.8, lambda tt, a=t_down + 0.3: [
        ("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.5), 2.0)])
    take.side[side]["wrist"] = off
    return t_down + 0.8, k


def use_ends(take: StepTake, plate: SB.Plate, clamps: list[SB.Clamp], t0: float, direction: str = "tighten",
             gap_mm: float = SB.PARK_NUT_GAP_MM, free: dict[str, float] | None = None) -> tuple[dict[str, float], list]:
    """Each end's own hand (by_hand) in turn runs that end's nuts with the wrench (use), each picking it up where the
    other laid it: from t0, or later if the hand is busy until then (free, each side's). Returns when each hand is
    clear of it, and the wrench's keys, its carries one after the other."""
    t = dict(free or {})
    keys: list = []
    for side, nuts in by_hand(clamps):
        t[side], k = use(take, plate, nuts, max(t0, t.get(side, t0)), direction, gap_mm=gap_mm, side=side)
        keys += k
        t0 = k[-1][0] + 0.3                     # laid down, the hand off it, before the other's reaches for it
    return t, keys
