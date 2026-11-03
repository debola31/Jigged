"""Close the doors and start the cycle (every VF-2 setup's step 8), planned as two takes cut together: standing in
the doorway, both hands hook the doors' handle bars and pull them shut; then, stepped across to the pendant, the eyes
check the program and the right index presses Cycle Start (plan §4; the record's affordances, moonshot/library/
stations/vf2.json; the vf2-controls card).

    python -m moonshot.motion.door_cycle            # plans both into the data root's takes/door-close, cycle-start

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
OPEN_MM = 300.0                                       # how far each door stands open: 600 mm clear, the vise reachable
CLOSE_S = 1.8                                         # slow enough that the door's friction alone stops it
BAR_W = 31.8                                          # the handle bar's width along the door (vf2.json door_*_pull)
PALM_MM = 16.0                                        # the wrist's centre stands this far off the palm's skin
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


class DoorClose(StepTake):
    def __init__(self, out=TAKES / "door-close", verbose=True):
        super().__init__(out, CLOSE_LUMBAR, verbose)
        self.grips = {"door_right": self.bar_grip("door_right", "R", OPEN_MM),
                      "door_left": self.bar_grip("door_left", "L", OPEN_MM)}

    def bar_grip(self, door: str, side: str, open_mm: float) -> dict:
        """A power grip round the handle bar from outside it, placed rather than solved: thumb up, the palm on the
        bar's outer face, the fingers curled round its back (the bar stands 36 mm off the door). It pulls the door
        either way, and the two hands stay outside their bars, apart, even with the doors shut. The capsule fingers
        can't conform to the bar, so the physics holds the gripped hand to it by a declared soft constraint, as the
        vise take does the crank's knob (moonshot/sim/runner.py, enclose). Given in the side's world."""
        face = self.at(side, handle(door, open_mm))
        out = np.sign(face[0] - self.lumbar[0])                          # the outer face's normal along x
        dorsal, long = np.array([out, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])
        H = np.stack([long, np.cross(dorsal, long), dorsal], 1)
        W = face + dorsal * PALM_MM + np.array([0.0, -112.0, 0.0])
        q = self.hand.neutral()
        for n in ("index", "middle", "ring", "little"):
            q[f"{n}_mcp_flex"], q[f"{n}_pip"], q[f"{n}_dip"] = 65.0, 75.0, 35.0
        q.update(thumb_cmc_abd=30.0, thumb_cmc_flex=5.0, thumb_mcp_flex=20.0, thumb_ip=15.0)
        q = self.hand.clamp(q)
        return {"q": q, "H": H, "W": W, "obj": face, "side": side, "W_rel": W - face, "theta": np.array(THETA0)}

    def door_at(self, door: str, t: float, t0: float) -> np.ndarray:
        return handle(door, OPEN_MM * (1 - min_jerk((t - t0) / CLOSE_S)))

    def plan(self):
        self.look(0.0, ORIGIN + np.array([0.0, -840.0, 1000.0]))
        t_on, t_pull = 1.2, 1.6
        t_end = t_pull + CLOSE_S
        for side, door in (("R", "door_right"), ("L", "door_left")):
            g = self.grips[door]
            H, W = self.grip_pose(door)                                       # in the side's world
            out = np.sign(handle(door, OPEN_MM)[0] - ORIGIN[0])
            reach = self.at(side, W) + np.array([out * 20.0, -70.0, 10.0])    # out and in front of the bar, world
            A = self.at(side, reach)
            self.transit(side, 0.25, t_on, reach, fade=(H, 2.0))
            self.fingers(side, 0.5, open_like(self.hand, g["q"], 0.9))
            self.add(side, t_on, t_pull, lambda t, H=H, W=W, A=A: [("pose", H, A + (W - A) * min_jerk((t - t_on) / 0.3), 2.0)])
            self.fingers(side, t_on + 0.3, g["q"])
            self.effort(side, t_on + 0.3, 0.0, door)
            self.effort(side, t_pull, 0.5, door)
            self.event("grip", t_on + 0.3, t_end + 0.1, side=side, grip=door)
            self.follow(side, t_pull, t_end, door, lambda t, door=door: self.door_at(door, t, t_pull))
            self.event("pull_door", t_pull, t_end, side=side, door=door)
            self.effort(side, t_end, 0.5, door)
            self.effort(side, t_end + 0.15, 0.0, None)
            self.fingers(side, t_end + 0.1, g["q"])
            self.fingers(side, t_end + 0.4, open_like(self.hand, g["q"], 0.5))
            self.transit(side, t_end + 0.2, t_end + 1.2, self.rest_of(side))
            self.fingers(side, t_end + 1.2, self.q_relax)
        self.look(t_end + 0.3, ORIGIN + np.array([0.0, -400.0, 950.0]))
        self.clip("close_doors", 0.0, t_end + 0.4, "Close the door")
        self.t = t_end + 1.4


class DoorOpen(DoorClose):
    """Open the doors (every setup's unload starts so): one door at a time, each hand gripping its bar from outside."""

    def __init__(self, out=TAKES / "door-open", verbose=True):
        StepTake.__init__(self, out, CLOSE_LUMBAR, verbose)
        self.grips = {"open_right": self.bar_grip("door_right", "R", 0.0),
                      "open_left": self.bar_grip("door_left", "L", 0.0)}

    def plan(self):
        self.look(0.0, ORIGIN + np.array([0.0, -840.0, 1000.0]))
        t0 = 0.25
        for side, door, grip in (("R", "door_right", "open_right"), ("L", "door_left", "open_left")):
            g = self.grips[grip]
            H, W = self.grip_pose(grip)
            out = np.sign(handle(door, 0.0)[0] - ORIGIN[0])
            reach = self.at(side, W) + np.array([out * 25.0, -70.0, 10.0])    # out and in front of the bar, world
            A = self.at(side, reach)
            t_on, t_pull = t0 + 0.9, t0 + 1.25
            t_end = t_pull + CLOSE_S
            self.transit(side, t0, t_on, reach, fade=(H, 2.0))
            self.fingers(side, t0 + 0.25, open_like(self.hand, g["q"], 0.9))
            self.add(side, t_on, t_pull, lambda t, H=H, W=W, A=A, t_on=t_on: [
                ("pose", H, A + (W - A) * min_jerk((t - t_on) / 0.3), 2.0)])
            self.fingers(side, t_on + 0.3, g["q"])
            self.effort(side, t_on + 0.3, 0.0, grip)
            self.effort(side, t_pull, 0.5, grip)
            self.event("grip", t_on + 0.3, t_end + 0.1, side=side, grip=grip)
            self.follow(side, t_pull, t_end, grip, lambda t, door=door, t_pull=t_pull:
                        handle(door, OPEN_MM * min_jerk((t - t_pull) / CLOSE_S)))
            self.event("pull_door", t_pull, t_end, side=side, door=door)
            self.effort(side, t_end, 0.5, grip)
            self.effort(side, t_end + 0.15, 0.0, None)
            self.fingers(side, t_end + 0.1, g["q"])
            self.fingers(side, t_end + 0.4, open_like(self.hand, g["q"], 0.5))
            self.transit(side, t_end + 0.2, t_end + 1.2, self.rest_of(side))
            self.fingers(side, t_end + 1.2, self.q_relax)
            t0 = t_pull + 0.3                         # the left hand sets off while the right door slides
        self.look(t_end - 0.5, ORIGIN + np.array([0.0, -400.0, 950.0]))
        self.clip("open_doors", 0.0, t_end + 0.4, "Open the door")
        self.t = t_end + 1.4


class CycleStart(StepTake):
    def __init__(self, out=TAKES / "cycle-start", verbose=True):
        super().__init__(out, START_LUMBAR, verbose)
        self.button = ORIGIN + np.array(vf2.record()["affordances"]["cycle_start"]["at_mm"], float)
        self.solve_grips({"cycle_start": self.press_spec()})

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
