"""Set the stop (the first step of a setup whose part stands on the vise's floor, "...then set the stop"; nist-ftc-10
op50, the one such setup), planned for both hands on one trunk: the right hand takes the stop block from where it
stands on the table, beyond the parallels' rack, pinched by its top, thumb on the near face and index and middle on
the far one, and stands it on the vise's floor at the part's -x end, where the load take sets the part against it
(vise.Load.stop). The left hand stays by the operator's side. As moonshot/motion/set_parallels.py, for one block.

    python -m moonshot.motion.set_stop            # plans into the data root's takes/set-stop
"""
from __future__ import annotations

import sys

import numpy as np
import torch

from moonshot.config import data_root
from moonshot.motion import loads
from moonshot.motion import set_parallels as SP
from moonshot.motion import setup_take as ST
from moonshot.motion.primitives import min_jerk, open_for, open_like
from moonshot.motion.setup_take import plane, vise_boxes
from moonshot.motion.step_take import StepTake
from moonshot.planning.validate import load_plan
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V

TAKES = data_root() / "takes"
PART, SETUP = "nist-ftc-10", "op50"
GRIP = "pinch_stop"
YAW = RACK.YAW                     # it waits on the table (vise.STOP_HOME) turned as the parallels' rack is, square
                                   # to the right forearm reaching there
CLEAR_MM = 30.0                    # carried with its foot this high over the jaws' tops
JAWS_OVER_SEAT_MM = SP.JAWS_OVER_SEAT_MM


def op50() -> V.Load:
    return loads.vise_load(load_plan(PART), SETUP)

# standing 90 mm left of and 140 mm nearer the table than the vise take's operator (setup_take.LUMBAR): the stop waits
# ahead and to the left, and from the vise take's place the trunk turned past people's range to reach it (in range
# 66% and 82% of frames there, standing back or only left; 95-100% from here, the hands within 1.5 mm of their targets)
LUMBAR = ST.LUMBAR + np.array([-90.0, 140.0, 0.0])

class SetStop(StepTake):
    def __init__(self, out=TAKES / "set-stop", load: V.Load | None = None, verbose=True):
        super().__init__(out, LUMBAR, verbose)
        self.vload = load or op50()
        self.home, self.dest = V.STOP_HOME, self.vload.stop()
        self.kg = V.STOP_KG
        self.solve_grips({GRIP: self.pinch_spec()}, source=SetStop.pinch_spec, depends=(V, RACK, loads))

    def centre(self, base) -> np.ndarray:
        return np.asarray(base, float) + np.array([0.0, 0.0, V.STOP_MM[2] / 2])

    def pinch_spec(self) -> dict:
        h = self.hand
        top = self.home + np.array([0.0, 0.0, V.STOP_MM[2]])
        half = np.array(V.STOP_MM) / 2
        q0 = h.neutral()
        q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
                  ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
                  thumb_mcp_flex=20.0, thumb_ip=15.0)
        Rh = SP.turned(YAW)                              # it stands turned
        near, far = top + Rh @ [0.0, -half[1], -5.0], top + Rh @ [0.0, half[1], -5.0]
        cols = [SP.obox(self.centre(self.home), Rh, half)]
        cols += [SP.obox(c, RACK.R, hh) for c, hh in RACK.boxes()]
        cols += vise_boxes({}, 0.0, self.vload.opening0)
        # the vise round its spot, moved to where it stands on the table, so the grip that sets it clears the jaws
        c0, c1 = self.centre(self.home), self.centre(self.dest)
        cols += [lambda p, f=f: f(torch.as_tensor(c1, dtype=p.dtype) + (p - torch.as_tensor(c0, dtype=p.dtype)) @
                                  torch.as_tensor(Rh, dtype=p.dtype))
                 for f in vise_boxes({}, 0.0, self.vload.opening0, include_table=False)]
        S = lambda *a: list(a) + [0.0, 0.0]                                                          # noqa: E731
        return dict(obj=self.centre(self.home), side="R", q0=q0, colliders=cols, load=self.kg,
                    targets={"thumb": plane(near, Rh @ [0, -1, 0], 1.5, SP.local_bands(top, Rh, x=(-8, 8), depth=(3, 8))),
                             "index": plane(far, Rh @ [0, 1, 0], 1.5, SP.local_bands(top, Rh, x=(-16, -5), depth=(3, 8))),
                             "middle": plane(far, Rh @ [0, 1, 0], 1.5, SP.local_bands(top, Rh, x=(5, 16), depth=(3, 8)))},
                    iters=1500,
                    starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])

    def plan(self):
        t = 0.3
        g = self.grips[GRIP]
        H, W = self.grip_pose(GRIP)
        above = W + np.array([0.0, -15.0, 80.0])
        c0, c1 = self.centre(self.home), self.centre(self.dest)
        self.look(t, c0)
        self.transit("R", t, t + 1.2, above, fade=(H, 2.0))
        self.fingers("R", t + 0.2, self.q_relax)
        self.fingers("R", t + 0.85, open_for(self.hand, g["q"], V.STOP_MM[1]))
        hover = W + np.array([0.0, -4.0, 20.0])
        t_on = t + 2.4
        self.add("R", t + 1.2, t + 1.6, lambda tt, t1=t + 1.2, a=above, b=hover:
                 [("pose", H, a + (b - a) * min_jerk((tt - t1) / 0.4), 2.0)])
        self.add("R", t + 1.6, t_on, lambda tt, t1=t + 2.05, b=hover:
                 [("pose", H, b + (W - b) * min_jerk((tt - t1) / 0.35), 2.0)])
        self.fingers("R", t_on, g["q"])
        self.effort("R", t_on, 0.0, GRIP)
        self.effort("R", t_on + 0.2, 0.6, GRIP)
        # its planned path, as a parallel's: straight up to the height it is carried at, across, turned square to the
        # jaws on the way, over its spot, down until its foot is level with the jaws' tops, a pause while the eye lines
        # it up, and slowly down onto the floor
        t_up, t_over = t_on + 1.1, t_on + 2.9
        t_near, t_down = t_over + 0.5, t_over + 1.9
        over = c1 + np.array([0.0, 0.0, JAWS_OVER_SEAT_MM + CLEAR_MM])
        up, near = np.array([c0[0], c0[1], over[2]]), c1 + np.array([0.0, 0.0, JAWS_OVER_SEAT_MM])
        self.keys = [(t_on + 0.3, c0), (t_up, up), (t_up + 0.3, up), (t_over, over), (t_near, near),
                     (t_near + 0.4, near), (t_down, c1)]

        def obj_at(tt, keys=self.keys):
            if tt <= keys[0][0]:
                return keys[0][1]
            for (a, pa), (b, pb) in zip(keys, keys[1:]):
                if a <= tt < b:
                    return pa + (pb - pa) * min_jerk((tt - a) / (b - a))
            return keys[-1][1]

        def R_at(tt, a=t_up + 0.3, b=t_over):
            return SP.turned(-YAW * min_jerk((tt - a) / (b - a)))
        self.look(t_up, c1)
        # the hand stays put on the floor until the fingers are just off it, and opens the rest of the way once up
        t_lift = t_down + 0.6
        self.follow("R", t_on, t_lift, GRIP, obj_at, R_at)
        self.add("R", t_near - 0.2, t_lift, lambda tt: [("pose", *self.grip_pose(GRIP, obj_at(tt), R_at(tt)), 4.0)])
        self.load("R", t_on + 0.3, t_down, self.kg)
        self.event("grip", t_on, t_down + 0.25, side="R", grip=GRIP, on="stop")
        self.event("carry", t_on + 0.3, t_down, side="R", obj="stop")
        self.effort("R", t_down - 0.1, 0.6, GRIP)
        self.effort("R", t_down + 0.2, 0.0, None)
        self.fingers("R", t_down + 0.25, g["q"])
        self.fingers("R", t_down + 0.55, open_like(self.hand, g["q"], 0.06))
        self.fingers("R", t_down + 0.8, open_like(self.hand, g["q"], 0.06))
        self.fingers("R", t_down + 1.05, open_like(self.hand, g["q"], 0.4))
        H1, W1 = self.grip_pose(GRIP, c1, R_at(t_down))
        off = W1 + np.array([0.0, -20.0, 110.0])
        self.add("R", t_lift, t_lift + 0.45, lambda tt, a=t_lift:
                 [("pose", H1, W1 + (off - W1) * min_jerk((tt - a) / 0.45), 2.0)])
        self.side["R"]["wrist"] = off
        t = t_lift + 0.45
        self.transit("R", t, t + 1.1, self.rest_of("R"))
        self.fingers("R", t + 1.1, self.q_relax)
        self.clip("set_stop", 0.0, t + 0.6, "Set the stop")
        self.t = t + 1.3


def build(verbose=True):
    take = SetStop(verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    np.savez(take.out / "stop_keys.npz", t=[k[0] for k in take.keys], p=[k[1] for k in take.keys])  # the planned
    # path, for the physics
    if verbose:
        print(f"SetStop: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
