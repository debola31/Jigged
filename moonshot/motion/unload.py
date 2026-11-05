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
from pathlib import Path

import numpy as np

from moonshot.config import data_root
from moonshot.motion import setup_take as ST                  # the vise take's reach onto the knob and its release
from moonshot.motion.primitives import min_jerk, open_for, open_like
from moonshot.motion.setup_take import LUMBAR                 # where the vise take stands the operator
from moonshot.motion.step_take import StepTake
from moonshot.world import vise as V

TAKES = data_root() / "takes"
JAW_GAP_MM = 0.1                                          # the physics starts the jaw this far off the part (sim/door_cycle.py)
TURN_S = 2.3                                              # one turn back, a little slower than cranking it shut
START_S = 0.5                                             # the reach starts once the body has settled, still
# the hand widest this far into the knob's reach, as the hand-opening check measures it (0.71-0.77): at the vise
# take's 0.62 it measured 0.71, from the thigh; at 0.665, 0.713-0.733
KNOB_PEAK = 0.69
# standing 90 mm left of the vise take's operator, people's range weighed as the pendant's keys weigh it: where the
# vise take stands, cranking the knob round the bottom of its circle bent the trunk 13 deg to the side, inside the
# right arm's people and outside the left's (the trunk as the left arm sees it, mirrored) for 32 frames of 178 (82%
# inside against 93%); standing right of it, 41
STANCE = np.array([-90.0, 0.0, 0.0])
RANGE_W = 10.0


def start_phi(load: V.Load) -> float:
    """The crank's angle with the jaw on the part, as the physics starts it."""
    return V.crank_for_opening(load.size[1] + JAW_GAP_MM, load.opening0)


class Unload(StepTake):
    SOLVER_W = {"range": RANGE_W}

    def __init__(self, load: V.Load = V.REFERENCE, out=TAKES / "loosen", verbose=True,
                 grips=TAKES / "setup-take" / "grips.json"):
        """grips: the vise take's grips.json the knob's grip is read from (the reference load's, by default)."""
        super().__init__(out, LUMBAR + STANCE, verbose)
        self.part = load
        self.home = np.array([V.VISE["x"], V.VISE["fixed_face_y"] - load.half[1],
                              V.VISE["seat_z"] + load.parallel_h + load.half[2]])
        solved = json.loads(Path(grips).read_text(encoding="utf-8"))
        for name in ("knob",):
            k = solved[name]
            self.grips[name] = {"q": self.hand.clamp(k["q"]), "H": np.array(k["H"]), "W": np.array(k["W"]),
                                "obj": np.array(k["obj"]), "side": "R", "W_rel": np.array(k["W"]) - np.array(k["obj"]),
                                "theta": np.array(k["theta"])}

    def knob_pose(self, phi):
        g = self.grips["knob"]
        return g["H"], V.knob_center(phi) + g["W_rel"]

    def plan(self):
        """As the vise take cranks (setup_take.Take.rotate): the reach onto the knob in as long as people's, paced, the
        hand widest ~74% into it; the knob's axis held in the fist and the fist's orientation only softly as it turns;
        let go, the fist eases open and slides off the knob's end along its axis, and the hand goes back to the side.
        Reached for in 1.3 s from the thigh and held round the turn as one pose (3), the reach measured 1.3 s against
        people's 0.67 and a pad sank 3.8 mm into the knob mid-turn."""
        phi0 = start_phi(self.part)
        g = self.grips["knob"]
        self.look(0.0, V.knob_center(phi0))
        Hk, Wk = self.knob_pose(phi0)
        pt = Hk.T @ (g["obj"] - g["W"])                       # the knob's middle in the hand
        # the reach, from the hand hanging still by the thigh: 0.33 m in people's time, onto the knob from the back of
        # the hand's side as the vise take's first crank comes onto it
        t_reach = START_S
        self.transit("R", t_reach, t_reach + ST.KNOB_REACH_S, Wk, via=[Wk + Hk[:, 2] * 45 + np.array([0, -10, 15])],
                     fade=(Hk, 1.0), paced=True)
        self.fingers("R", t_reach, self.q_relax)
        self.fingers("R", t_reach + KNOB_PEAK * ST.KNOB_REACH_S,
                     open_for(self.hand, g["q"], 2 * V.VISE["knob_r"], lag_mm=10.0))
        tg = t_reach + ST.KNOB_REACH_S
        self.fingers("R", tg, g["q"])
        # the crank, a turn back
        t_c0 = tg + 0.25
        t_c1 = t_c0 + TURN_S
        phi = lambda t: phi0 - 360.0 * (0.6 * min_jerk((t - t_c0) / TURN_S) + 0.4 * min(1.0, max(0.0, (t - t_c0) / TURN_S)))  # noqa: E731
        tl = t_c1 + 0.3                                      # let go
        ax = Hk.T @ ST.KNOB_AXIS

        def on_knob(t):
            c = V.knob_center(phi(t))
            w = 1.0
            if t > tl:                                       # slid off the knob's end, turning back to the grip
                u = min_jerk((t - tl) / ST.SLIDE_OFF_S)
                c = c + ST.KNOB_AXIS * ST.SLIDE_OFF_MM * u
                w = 1.0 + (ST.SLIDE_POSE_W - 1.0) * u
            return [("pose", Hk, c - Hk @ pt, w), ("tsr", pt, c, ax, ST.KNOB_AXIS, 6.0)]
        self.add("R", tg, tl + ST.SLIDE_OFF_S, on_knob)
        self.effort("R", tg, 0.6, "knob")
        self.effort("R", t_c1, 0.6, "knob")
        self.effort("R", tl, 0.0, None)
        self.event("grip", tg, tl, side="R", grip="knob")
        self.event("crank", t_c0, t_c1, side="R", phi0=phi0, phi1=phi0 - 360.0)
        self.look(t_c0 + 0.3, self.home)
        self.fingers("R", tl, g["q"])
        self.fingers("R", tl + 0.12, open_like(self.hand, g["q"], ST.LETGO_OPEN))
        self.fingers("R", tl + 0.35, open_like(self.hand, g["q"], 0.9))
        # off the knob's end, and back down to the side
        t_off = tl + ST.SLIDE_OFF_S
        self.side["R"]["wrist"] = V.knob_center(phi0 - 360.0) - Hk @ pt + ST.KNOB_AXIS * ST.SLIDE_OFF_MM
        self.transit("R", t_off, t_off + 1.0, self.rest_of("R"))
        self.fingers("R", t_off + 1.0, self.q_relax)
        self.clip("loosen", 0.0, tl + 0.5, "Loosen the vise")
        self.t = t_off + 1.2

    def save(self):
        super().save()
        np.savez(self.out / "part_keys.npz", phi0=start_phi(self.part), load=json.dumps(self.part.to_json()))


def build(verbose=True, **kw):
    take = Unload(verbose=verbose, **kw)
    take.plan()
    take.solve(theta0=take.grips["knob"]["theta"])
    take.save()
    if verbose:
        print(f"Loosen: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
