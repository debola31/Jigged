"""Close the doors and start the cycle (every VF-2 setup's step 8), planned as two takes cut together: standing in
the doorway, the hands grip the fully open doors' handle bars and run them shut, the right door and then the left,
the trunk turning from one to the other; then, stepped across to the pendant, the eyes check the program and the
right index presses Cycle Start (plan §4; the record's affordances, moonshot/library/stations/vf2.json; the
vf2-controls card). And open the doors, every unload's first take: the same, the other way, out to the stops, so
everything between them works with both doors fully open (your decision 2026-11-03).

    python -m moonshot.motion.door_cycle            # plans all three into the data root's takes/door-close,
                                                    # cycle-start, door-open

Declared shortcut: the step across from the doorway to the pendant is a cut, as the body model doesn't walk.
"""
from __future__ import annotations

import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.step_take import THETA0, StepTake
from moonshot.world import cell, vf2

TAKES = data_root() / "takes"
ORIGIN = np.array([-cell.LOAD_X_MM, 0.0, 0.0])        # the VF-2's frame in the world (moonshot/world/cell.py)
OPEN_MM = 600.0                                       # how far the doors stand open: fully, the track's whole range
SLIDE_S = 2.2                                         # a door's 600 mm along its track: 0.5 m/s at most
SEAT_MM = 8.0                                         # the hand runs the door this far past the track's end, into its
SEAT_S = 0.25                                         # stop, and holds it there this long before letting go
REACH_S = 1.1                                         # the hand out to a bar,
SETTLE_S = 0.35                                       # settling in front of it,
APPROACH_S = 0.4                                      # and onto it,
APPROACH_OUT, APPROACH_BACK = 40.0, 35.0              # from this far outside the bar and in front of it (mm): the
                                                      # skin 7 mm or more off the bar all the way in, the right forearm
                                                      # kept back from the pendant
APPROACH_OPEN = 0.3                                   # the hook a little open on the way in
LEFT_AFTER_S = 0.5                                    # the left hand sets off this long after the right door starts
# the hook's wrist from the bar's grip point: out from its outer face, in front of it; its long axis tilted up. Placed
# by the skin's clearance (a search over shapes and places): the hooked fingers' backs and the thumb on the outer face,
# within 1 mm, 26 mm off the door, 110 mm off the other bar with the doors shut. Rolled palm-down 15 or 30 deg, which
# takes the thumb off the bar, the push slid off the bar's front edge and the right door stopped 90 mm closed
GRIP_OUT, GRIP_BACK, GRIP_TILT = 50.0, 110.0, 25.0
BAR_W = 31.8                                          # the handle bar's width along the door (vf2.json door_*_pull)
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


def handle(door: str, open_mm: float) -> np.ndarray:
    """The handle's grip point (the bar's outer face, its middle) with the door open_mm, in the world."""
    a = vf2.record()["affordances"][f"{door}_handle"]
    return ORIGIN + np.array(a["at_mm"], float) + np.array(a["pull"], float) * open_mm


def bands(c, **lims):
    c = np.asarray(c, float)

    def f(p):
        out = 0.0
        for k, (lo, hi) in lims.items():
            v = p["xyz".index(k)] - c["xyz".index(k)]
            out = out + (lo - v).clamp(min=0) ** 2 + (v - hi).clamp(min=0) ** 2
        return 0.5 * out
    return f


class _Doors(StepTake):
    """What opening and closing the doors share: one door at a time, each hand reaching out to its own bar, settling
    in front of it, closing round it and running the door along its track to the stop; the other hand sets off while
    the first door slides, and the trunk turns from one door to the other."""

    def __init__(self, out, verbose=True):
        super().__init__(out, CLOSE_LUMBAR, verbose)
        # the pendant hangs in front of the right door's bar near full open: the right arm reaches in under it
        c = vf2.record()["colliders"]["pendant_face"]
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        self.boxes = [(ORIGIN + (lo + hi) / 2, (hi - lo) / 2)]

    def bar_grip(self, door: str, side: str, open_mm: float) -> dict:
        """A hook on the handle bar from outside it, placed rather than solved: the hand points into the machine,
        tilted up GRIP_TILT, thumb up and laid along the index, the fingers hooked at their middle joints with their
        backs on the bar's outer face. Placed so that the hand's skin (moonshot/body/hand.py) clears the bar, its door
        and the other door's bar; the fingers can't go round the bar's back, which stands only 36 mm off the door, so
        closing, the hooked fingers push the door along, and opening the physics holds the closed hand to the bar by a
        soft constraint, as the vise take does the crank's knob (moonshot/sim/runner.py, enclose). Given in the side's
        world."""
        face = self.at(side, handle(door, open_mm))
        out = np.sign(face[0] - self.lumbar[0])                          # the outer face's normal along x
        dorsal, long = np.array([out, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])
        c, s = np.cos(np.radians(GRIP_TILT)), np.sin(np.radians(GRIP_TILT))
        H = np.array([[1.0, 0, 0], [0, c, -s], [0, s, c]]) @ np.stack([long, np.cross(dorsal, long), dorsal], 1)
        W = face + np.array([out * GRIP_OUT, -GRIP_BACK, 0.0])
        q = self.hand.neutral()
        for n in ("index", "middle", "ring", "little"):
            q[f"{n}_mcp_flex"], q[f"{n}_pip"], q[f"{n}_dip"] = 0.0, 95.0, 30.0
        q.update(thumb_cmc_abd=0.0, thumb_cmc_flex=0.0, thumb_mcp_flex=10.0, thumb_ip=10.0)
        q = self.hand.clamp(q)
        return {"q": q, "H": H, "W": W, "obj": face, "side": side, "W_rel": W - face, "theta": np.array(THETA0)}

    def slide(self, side: str, door: str, grip: str, from_mm: float, to_mm: float, t0: float) -> float:
        """The side's hand reaches out at t0 to its door's bar, settles in front of it (an arm at its reach comes to
        rest before the fingers go round a bar), closes round it and runs the door from from_mm to to_mm, past the
        track's end by SEAT_MM, so the door is pressed into its stop as a hand runs a sliding door home, held there
        SEAT_S; then lets go and comes back to rest. Returns when the door starts to move."""
        g = self.grips[grip]
        H, W = self.grip_pose(grip)                                         # in the side's world
        out = np.sign(handle(door, from_mm)[0] - ORIGIN[0])
        reach = self.at(side, W) + np.array([out * APPROACH_OUT, -APPROACH_BACK, 0.0])   # out and in front, world
        A = self.at(side, reach)
        # letting go, the hand comes straight back off the bar before it swings in, so the hook clears the bar
        back = self.at(side, self.grip_pose(grip, handle(door, to_mm))[1]) + np.array([out * 15.0, -90.0, 0.0])
        t_on = t0 + REACH_S
        t_in = t_on + SETTLE_S                                              # the hand starts onto the bar
        t_grip = t_in + APPROACH_S
        t_pull = t_grip + 0.2
        t_end = t_pull + SLIDE_S + SEAT_S
        self.transit(side, t0, t_on, reach, fade=(H, 2.0))
        opened = open_like(self.hand, g["q"], APPROACH_OPEN)
        self.fingers(side, t0 + 0.25, opened)
        self.fingers(side, t_in, opened)
        self.add(side, t_on, t_pull, lambda t, H=H, W=W, A=A, t_in=t_in: [
            ("pose", H, A + (W - A) * min_jerk((t - t_in) / APPROACH_S), 2.0)])
        self.fingers(side, t_grip, g["q"])
        self.effort(side, t_grip, 0.0, grip)
        self.effort(side, t_pull, 0.5, grip)
        self.event("grip", t_grip, t_end + 0.1, side=side, grip=grip)
        self.follow(side, t_pull, t_end, grip, lambda t, door=door, t_pull=t_pull: handle(
            door, from_mm + (to_mm - from_mm) * min_jerk((t - t_pull) / SLIDE_S)))
        self.event("pull_door", t_pull, t_end, side=side, door=door, from_mm=from_mm, to_mm=to_mm, move_s=SLIDE_S)
        self.effort(side, t_end, 0.5, grip)
        self.effort(side, t_end + 0.15, 0.0, None)
        self.fingers(side, t_end + 0.1, g["q"])
        self.fingers(side, t_end + 0.4, open_like(self.hand, g["q"], 0.5))
        self.transit(side, t_end + 0.2, t_end + 1.3, self.rest_of(side), via=[back])
        self.fingers(side, t_end + 1.3, self.q_relax)
        self.t = max(self.t, t_end + 1.5)
        return t_pull


class DoorClose(_Doors):
    """Close the doors from fully open: the right one, then the left, each hand's hooked fingers pushing its door's
    bar home along the track; the left hand reaches out while the right door slides."""

    def __init__(self, out=TAKES / "door-close", verbose=True):
        super().__init__(out, verbose)
        self.grips = {"door_right": self.bar_grip("door_right", "R", OPEN_MM),
                      "door_left": self.bar_grip("door_left", "L", OPEN_MM)}

    def plan(self):
        self.look(0.0, handle("door_right", OPEN_MM))
        t_pull = self.slide("R", "door_right", "door_right", OPEN_MM, -SEAT_MM, 0.2)
        self.look(t_pull + 0.3, handle("door_left", OPEN_MM))
        t_pull = self.slide("L", "door_left", "door_left", OPEN_MM, -SEAT_MM, t_pull + LEFT_AFTER_S)
        self.look(t_pull + 0.7 * SLIDE_S, ORIGIN + np.array([0.0, -400.0, 950.0]))
        self.clip("close_doors", 0.0, self.t - 1.0, "Close the door")


class DoorOpen(_Doors):
    """Open the doors fully, to their stops (every setup's unload starts so): the right one, then the left, each hand
    gripping its bar from outside and drawing the door out along its track."""

    def __init__(self, out=TAKES / "door-open", verbose=True):
        super().__init__(out, verbose)
        self.grips = {"open_right": self.bar_grip("door_right", "R", 0.0),
                      "open_left": self.bar_grip("door_left", "L", 0.0)}

    def plan(self):
        self.look(0.0, ORIGIN + np.array([0.0, -840.0, 1000.0]))
        t_pull = self.slide("R", "door_right", "open_right", 0.0, OPEN_MM + SEAT_MM, 0.25)
        self.look(t_pull + 0.5 * SLIDE_S, handle("door_left", 0.0))
        t_pull = self.slide("L", "door_left", "open_left", 0.0, OPEN_MM + SEAT_MM, t_pull + LEFT_AFTER_S)
        self.look(t_pull + 0.7 * SLIDE_S, ORIGIN + np.array([0.0, -400.0, 950.0]))
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
