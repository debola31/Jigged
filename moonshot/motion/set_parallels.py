"""Set the parallels (every VF-2 setup's first step, "...then set the parallels"), planned for both hands on one
trunk: the right hand takes each parallel from its rack on the table (moonshot/world/parallel_rack.py), pinched by
its top edge, thumb on the near face and index and middle on the far one, and stands it on the vise's seat where the
load take expects it (vise.Load.parallels); the far one first, so the hand never reaches over the one it has set.
The left hand stays by the operator's side.

    python -m moonshot.motion.set_parallels            # plans into the data root's takes/set-parallels
"""
from __future__ import annotations

import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import setup_take as ST
from moonshot.motion.primitives import min_jerk, open_for, open_like
from moonshot.motion.setup_take import bands, box, plane, vise_boxes
from moonshot.motion.step_take import StepTake
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V

TAKES = data_root() / "takes"
ORDER = ("para_a", "para_b")
GRIP = {"para_a": "pinch_a", "para_b": "pinch_b"}
CLEAR_MM = 80.0                    # carried this high over its spot: its foot clears the jaws' tops by 30 mm
STEEL = 7850.0                     # kg/m^3


class SetParallels(StepTake):
    def __init__(self, out=TAKES / "set-parallels", load: V.Load = V.REFERENCE, verbose=True):
        super().__init__(out, ST.LUMBAR, verbose)
        self.vload = load
        self.rack, self.dest = RACK.slots(load), load.parallels()
        self.kg = STEEL * V.PARALLEL_L * V.PARALLEL_T * load.parallel_h * 1e-9
        self.solve_grips({GRIP[n]: self.pinch_spec(n) for n in ORDER}, source=self.pinch_spec, depends=(RACK,))

    def centre(self, base) -> np.ndarray:
        return np.asarray(base, float) + np.array([0.0, 0.0, self.vload.parallel_h / 2])

    def pinch_spec(self, name: str) -> dict:
        h = self.hand
        top = self.rack[name] + np.array([0.0, 0.0, self.vload.parallel_h])
        half_t = V.PARALLEL_T / 2
        q0 = h.neutral()
        q0.update(index_mcp_flex=35.0, index_pip=40.0, middle_mcp_flex=35.0, middle_pip=40.0, ring_mcp_flex=60.0,
                  ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0, thumb_cmc_abd=20.0, thumb_cmc_flex=10.0,
                  thumb_mcp_flex=20.0, thumb_ip=15.0)
        near, far = top + np.array([0.0, -half_t, -6.0]), top + np.array([0.0, half_t, -6.0])
        others = [b for b in ORDER if b != name]
        cols = [box(self.centre(self.rack[name]), [V.PARALLEL_L / 2, half_t, self.vload.parallel_h / 2])]
        cols += [box(self.centre(self.rack[b]), [V.PARALLEL_L / 2, half_t, self.vload.parallel_h / 2]) for b in others]
        cols += [box(c, hh) for c, hh in RACK.boxes()]
        cols += vise_boxes({}, self.vload.parallel_h, self.vload.opening0)
        S = lambda *a: list(a) + [0.0, 0.0]                                                          # noqa: E731
        return dict(obj=self.centre(self.rack[name]), side="R", q0=q0, colliders=cols, load=self.kg,
                    targets={"thumb": plane(near, [0, -1, 0], 1.5, bands(top, x=(-10, 10), depth=(3, 10))),
                             "index": plane(far, [0, 1, 0], 1.5, bands(top, x=(-30, -8), depth=(3, 10))),
                             "middle": plane(far, [0, 1, 0], 1.5, bands(top, x=(8, 30), depth=(3, 10)))},
                    iters=1500,
                    starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])

    def plan(self):
        t = 0.3
        self.keys = {}
        for name in ORDER:
            grip = GRIP[name]
            g = self.grips[grip]
            H, W = self.grip_pose(grip)
            above = W + np.array([0.0, -15.0, 80.0])
            c0, c1 = self.centre(self.rack[name]), self.centre(self.dest[name])
            self.look(t, c0)
            self.transit("R", t, t + 1.2, above, fade=(H, 2.0))
            self.fingers("R", t + 0.2, self.q_relax)
            self.fingers("R", t + 0.85, open_for(self.hand, g["q"], V.PARALLEL_T))   # widest ~74% into the reach
            # a pause just over it, fingers open, while the eye brings the hand onto it; then down and close
            hover = W + np.array([0.0, -4.0, 20.0])
            t_on = t + 2.4
            self.add("R", t + 1.2, t + 1.6, lambda tt, t1=t + 1.2, H=H, a=above, b=hover:
                     [("pose", H, a + (b - a) * min_jerk((tt - t1) / 0.4), 2.0)])
            self.add("R", t + 1.6, t_on, lambda tt, t1=t + 2.05, H=H, W=W, b=hover:
                     [("pose", H, b + (W - b) * min_jerk((tt - t1) / 0.35), 2.0)])
            self.fingers("R", t_on, g["q"])
            self.effort("R", t_on, 0.0, grip)
            self.effort("R", t_on + 0.2, 0.6, grip)
            # the parallel's planned path: straight up and clear of its slot's 12 mm walls before moving across (dragged
            # sideways while still in it, it caught on the walls and swung in the hand), over its spot, down onto the seat
            t_up, t_over, t_down = t_on + 1.1, t_on + 2.9, t_on + 3.7
            up, over = c0 + np.array([0.0, 0.0, 45.0]), c1 + np.array([0.0, 0.0, CLEAR_MM])
            keys = [(t_on + 0.3, c0), (t_up, up), (t_up + 0.3, up), (t_over, over), (t_down, c1)]
            self.keys[name] = keys

            def obj_at(tt, keys=keys):
                if tt <= keys[0][0]:
                    return keys[0][1]
                for (a, pa), (b, pb) in zip(keys, keys[1:]):
                    if a <= tt < b:
                        return pa + (pb - pa) * min_jerk((tt - a) / (b - a))
                return keys[-1][1]
            self.look(t_up, c1)
            self.follow("R", t_on, t_down + 0.25, grip, obj_at)
            self.load("R", t_on + 0.3, t_down, self.kg)
            self.event("grip", t_on, t_down + 0.25, side="R", grip=grip)
            self.event("carry", t_on + 0.3, t_down, side="R", object=name)
            self.effort("R", t_down - 0.1, 0.6, grip)
            self.effort("R", t_down + 0.2, 0.0, None)
            self.fingers("R", t_down + 0.25, g["q"])
            self.fingers("R", t_down + 0.55, open_like(self.hand, g["q"], 0.4))
            W1 = self.grip_pose(grip, c1)[1]
            off = W1 + np.array([0.0, -20.0, 60.0])
            self.add("R", t_down + 0.3, t_down + 0.75, lambda tt, a=t_down + 0.3, H=H, W1=W1, off=off:
                     [("pose", H, W1 + (off - W1) * min_jerk((tt - a) / 0.45), 2.0)])
            self.side["R"]["wrist"] = off
            t = t_down + 0.75
        self.transit("R", t, t + 1.1, self.rest_of("R"))
        self.fingers("R", t + 1.1, self.q_relax)
        self.clip("set_parallels", 0.0, t + 0.6, "Set the parallels")
        self.t = t + 1.3


def build(verbose=True):
    take = SetParallels(verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    np.savez(take.out / "parallel_keys.npz", **{f"{n}_t": [k[0] for k in v] for n, v in take.keys.items()},
             **{f"{n}_p": [k[1] for k in v] for n, v in take.keys.items()})   # the planned paths, for the physics
    if verbose:
        print(f"SetParallels: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
