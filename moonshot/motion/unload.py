"""Loosen the vise (every VF-2 setup's last step, after the doors open and the chips are blown off), planned for
both hands on one trunk: the right hand takes the crank's knob as the vise take does and cranks the vise open a turn,
then lets go; the left hand stays at the operator's side (plan §4; the kurt-vise-load-and-clamp card, in reverse).
The part is lifted out by the vise take started in the vise (setup_take.build_lift_out), one per setup's part.

    python -m moonshot.motion.unload           # plans into the data root's takes/loosen

The knob's grip is the approved vise take's (takes/setup-take/grips.json): the fist keeps its orientation and the knob
spins in it.
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.step_take import StepTake
from moonshot.world import vise as V

TAKES = data_root() / "takes"
LUMBAR = np.array([-415.0, -935.0, 955.0])               # where the vise take stands the operator
JAW_GAP_MM = 0.1                                          # the physics starts the jaw this far off the part (sim/door_cycle.py)
TURN_S = 2.3                                              # one turn back, a little slower than cranking it shut


def start_phi(load: V.Load) -> float:
    """The crank's angle with the jaw on the part, as the physics starts it."""
    return V.crank_for_opening(load.size[1] + JAW_GAP_MM, load.opening0)


class Unload(StepTake):
    def __init__(self, load: V.Load = V.REFERENCE, out=TAKES / "loosen", verbose=True):
        super().__init__(out, LUMBAR, verbose)
        self.part = load
        self.home = np.array([V.VISE["x"], V.VISE["fixed_face_y"] - load.half[1],
                              V.VISE["seat_z"] + load.parallel_h + load.half[2]])
        solved = json.loads((TAKES / "setup-take" / "grips.json").read_text(encoding="utf-8"))
        for name in ("knob",):
            k = solved[name]
            self.grips[name] = {"q": self.hand.clamp(k["q"]), "H": np.array(k["H"]), "W": np.array(k["W"]),
                                "obj": np.array(k["obj"]), "side": "R", "W_rel": np.array(k["W"]) - np.array(k["obj"]),
                                "theta": np.array(k["theta"])}

    def knob_pose(self, phi):
        g = self.grips["knob"]
        return g["H"], V.knob_center(phi) + g["W_rel"]

    def plan(self):
        phi0 = start_phi(self.part)
        g = self.grips["knob"]
        self.look(0.0, V.knob_center(phi0))
        # the crank, a turn back
        Hk, Wk = self.knob_pose(phi0)
        self.transit("R", 0.3, 1.3, Wk + Hk[:, 2] * 45 + np.array([0, -10, 15]), fade=(Hk, 1.0))
        self.fingers("R", 0.7, open_like(self.hand, g["q"], 0.9))
        self.add("R", 1.3, 1.6, lambda t: [("pose", Hk, Wk + Hk[:, 2] * 45 * (1 - min_jerk((t - 1.3) / 0.3)), 3.0)])
        self.fingers("R", 1.6, g["q"])
        t_c0, t_c1 = 1.75, 1.75 + TURN_S
        phi = lambda t: phi0 - 360.0 * (0.6 * min_jerk((t - t_c0) / TURN_S) + 0.4 * min(1.0, max(0.0, (t - t_c0) / TURN_S)))  # noqa: E731
        self.add("R", 1.6, t_c1 + 0.3, lambda t: [("pose", Hk, self.knob_pose(phi(t))[1], 3.0)])
        self.effort("R", 1.6, 0.6, "knob")
        self.effort("R", t_c1 + 0.3, 0.0, None)
        self.event("grip", 1.6, t_c1 + 0.3, side="R", grip="knob")
        self.event("crank", t_c0, t_c1, side="R", phi0=phi0, phi1=phi0 - 360.0)
        self.look(t_c0 + 0.3, self.home)
        self.fingers("R", t_c1 + 0.3, g["q"])
        self.fingers("R", t_c1 + 0.6, open_like(self.hand, g["q"], 0.9))
        Wend = self.knob_pose(phi0 - 360.0)[1]
        self.side["R"]["wrist"] = Wend
        # off the knob as the vise take leaves it (out to the right, clear of the lever), and back to the side
        sc = V.VISE["screw_axis"]
        self.transit("R", t_c1 + 0.4, t_c1 + 1.3, np.array([sc[0] + 175, -820, 990]), via=[Wend + np.array([60, -15, 45])])
        self.transit("R", t_c1 + 1.3, t_c1 + 2.3, self.rest_of("R"))
        self.fingers("R", t_c1 + 2.3, self.q_relax)
        self.clip("loosen", 0.0, t_c1 + 1.0, "Loosen the vise")
        self.t = t_c1 + 2.5

    def save(self):
        super().save()
        np.savez(self.out / "part_keys.npz", phi0=start_phi(self.part), load=json.dumps(self.part.to_json()))


def build(verbose=True):
    take = Unload(verbose=verbose)
    take.plan()
    take.solve(theta0=take.grips["knob"]["theta"])
    take.save()
    if verbose:
        print(f"Loosen: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
