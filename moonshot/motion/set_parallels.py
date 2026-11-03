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
import torch

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import setup_take as ST
from moonshot.motion.primitives import min_jerk, open_for, open_like
from moonshot.motion.setup_take import plane, vise_boxes
from moonshot.motion.step_take import StepTake
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V

TAKES = data_root() / "takes"
ORDER = ("para_a", "para_b")
GRIP = {"para_a": "pinch_a", "para_b": "pinch_b"}
CLEAR_MM = 80.0                    # carried this high over its spot: its foot clears the jaws' tops by 30 mm
JAWS_OVER_SEAT_MM = V.VISE["jaw_top_z"] - V.VISE["seat_z"]      # 44.1: lined up here, the fingers still clear the jaws
STEEL = 7850.0                     # kg/m^3


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


class SetParallels(StepTake):
    def __init__(self, out=TAKES / "set-parallels", load: V.Load = V.REFERENCE, verbose=True):
        super().__init__(out, ST.LUMBAR, verbose)
        self.vload = load
        self.rack, self.dest = RACK.slots(load), load.parallels()
        self.kg = STEEL * V.PARALLEL_L * V.PARALLEL_T * load.parallel_h * 1e-9
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
        cols = [obox(self.centre(self.rack[b]), Rr, half) for b in [name, *others]]
        cols += [obox(c, Rr, hh) for c, hh in RACK.boxes()]
        cols += vise_boxes({}, self.vload.parallel_h, self.vload.opening0)
        set_before = {b: self.dest[b] for b in ORDER[:ORDER.index(name)]}
        cols += self.at_landing(name, vise_boxes(set_before, self.vload.parallel_h, self.vload.opening0,
                                                 include_table=False))
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
            # the parallel's planned path: straight up, out of its slot's 8 mm walls and to the height it is carried
            # at, before moving across (dragged sideways while still in it, it caught on the walls and swung in the
            # hand; carried across while still rising, it swept the other parallel's top and the moving jaw's), over
            # its spot, down until its foot is level with the jaws' tops, a pause there while the eye lines it up, and
            # down between the jaws slowly (in one 0.8 s move it wandered 5 mm and was let go still in the air; lined
            # up only 10 mm over the seat, the fingers beside parallel a had met the fixed jaw on the way)
            t_up, t_over = t_on + 1.1, t_on + 2.9
            t_near, t_down = t_over + 0.5, t_over + 1.9
            over = c1 + np.array([0.0, 0.0, CLEAR_MM])
            up, near = np.array([c0[0], c0[1], over[2]]), c1 + np.array([0.0, 0.0, JAWS_OVER_SEAT_MM])
            keys = [(t_on + 0.3, c0), (t_up, up), (t_up + 0.3, up), (t_over, over), (t_near, near), (t_near + 0.4, near),
                    (t_down, c1)]
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
            self.follow("R", t_on, t_lift, grip, obj_at, R_at)
            # going down between the jaws, the hand keeps the grip's turn firmly: the carry lets it turn about the
            # vertical as the arm reaches across, and turned so, parallel a's far end met the fixed jaw
            self.add("R", t_near - 0.2, t_lift, lambda tt, grip=grip, obj_at=obj_at, R_at=R_at:
                     [("pose", *self.grip_pose(grip, obj_at(tt), R_at(tt)), 4.0)])
            self.load("R", t_on + 0.3, t_down, self.kg)
            self.event("grip", t_on, t_down + 0.25, side="R", grip=grip)
            self.event("carry", t_on + 0.3, t_down, side="R", object=name)
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
