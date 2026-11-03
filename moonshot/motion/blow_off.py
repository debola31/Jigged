"""Blow off the vise with the air gun (every VF-2 setup's first step, "Blow out the vise...", and its last, "...blow
the chips off"), planned for both hands on one trunk: the right hand takes the gun from its holster on the front
panel, aims the nozzle down into the vise and sweeps it along the jaws with the trigger held, then hangs it back; the
left hand stays by the operator's side (plan §4; the gun and holster, moonshot/world/air_gun.py).

    python -m moonshot.motion.blow_off            # plans into the data root's takes/blow-off

The gun is held in a pistol grip: the palm on the back of its handle, the middle, ring and little fingers round it,
the index on the trigger and the thumb round the far side; solved in two stages, as the vise crank's knob.
"""
from __future__ import annotations

import sys

import numpy as np
import torch
from scipy.spatial.transform import Rotation, Slerp

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.motion.step_take import StepTake
from moonshot.world import air_gun as AG
from moonshot.world import cell
from moonshot.world.vise import VISE

TAKES = data_root() / "takes"
ORIGIN = np.array([-cell.LOAD_X_MM, 0.0, 0.0])          # the VF-2's frame in the world (moonshot/world/cell.py)
LUMBAR = np.array([-300.0, -935.0, 955.0])              # in the doorway, a little right: the vise and the gun in reach
LIFT_MM = 170.0                                          # clears the 115 mm nozzle out of the 125 mm holster
TIP_OVER_VISE = np.array([VISE["x"], VISE["fixed_face_y"] - 50.0, VISE["jaw_top_z"] + 110.0])
SWEEP_MM = 55.0                                          # along the jaws, either side of the middle
# in through the opening right of the operator's chest and well inside the open right door's edge (x 575 at 600 mm
# open): a gate at the operator's own y (-900) took the gun through the chest, and one 35 mm inside the edge of a door
# open 400 mm caught the gun's body on it
GATE_IN = ORIGIN + np.array([411.0, -690.0, 0.0])
# the doors stand fully open, as the vise take loads with them: at 300 mm the right forearm, reaching in from where
# the gun is in reach, meets the right door's edge
DOORS_OPEN_MM = 600.0
# blowing: the nozzle pointing forward and down into the vise, the handle up and back toward the operator
AIM = np.stack([[0.0, 0.6, -0.8], [-1.0, 0.0, 0.0], [0.0, 0.8, 0.6]], 1)


def on_handle(A, U, lo, hi, comp=2.0, w=1.0):
    """A pad on the handle (axis point A, direction U, mm): at its girth, facing its axis, between lo and hi along it."""
    A_t, U_t = torch.as_tensor(A, dtype=torch.float64), torch.as_tensor(U, dtype=torch.float64)

    def f(cc, n):
        rel = cc - A_t
        t = rel @ U_t
        radial = torch.linalg.norm(rel - t * U_t)
        to_axis = -(rel - t * U_t) / radial
        return w * ((radial - (AG.HANDLE_R - comp)) ** 2 + 20 * (1.0 - n @ to_axis) ** 2
                    + 0.5 * (torch.relu(lo - t) ** 2 + torch.relu(t - hi) ** 2))
    return f


def near(c, r):
    """Penalty keeping a pad centre within r (mm) of c."""
    c_t = torch.as_tensor(c, dtype=torch.float64)
    return lambda p: 2.0 * torch.relu(torch.linalg.norm(p - c_t) - r) ** 2


class BlowOff(StepTake):
    def __init__(self, out=TAKES / "blow-off", verbose=True):
        super().__init__(out, LUMBAR, verbose)
        self.R0, self.p0 = AG.holstered_pose(ORIGIN)            # the gun as it stands in its holster
        self.solve_grips({"gun": self.pistol_spec()}, source=self.pistol_spec, depends=(AG,))

    def gun_point(self, v, R=None, p=None):
        """A point of the gun (its own frame, mm) in the world, with the gun at (R, p); default holstered."""
        return (self.p0 if p is None else p) + (self.R0 if R is None else R) @ np.asarray(v, float)

    def pistol_spec(self) -> dict:
        h = self.hand
        A, U = self.p0, self.R0 @ np.array([0.0, 0.0, 1.0])
        trig = self.gun_point(AG.TRIGGER_C + np.array([AG.TRIGGER_HALF[0], 0.0, 0.0]))
        trig_n = self.R0 @ np.array([1.0, 0.0, 0.0])
        q0 = h.neutral()
        for n in ("middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 55.0, 70.0
        q0.update(index_mcp_flex=35.0, index_pip=45.0, thumb_cmc_abd=15.0, thumb_cmc_flex=10.0, thumb_mcp_flex=30.0,
                  thumb_ip=25.0)
        body = lambda p: G.sdf_box(p, self.gun_point(AG.BODY_C), self.R0, AG.BODY_HALF)                # noqa: E731
        trigger = lambda p: G.sdf_box(p, self.gun_point(AG.TRIGGER_C), self.R0, AG.TRIGGER_HALF)      # noqa: E731
        handle = lambda p: G.sdf_cyl(p, self.gun_point([0, 0, -AG.HANDLE_HALF]), self.gun_point([0, 0, AG.HANDLE_HALF]),  # noqa: E731
                                     AG.HANDLE_R)
        holster = lambda p: G.sdf_box(p, ORIGIN + AG.HOLSTER_TOP - np.array([0, 0, AG.HOLSTER_DEPTH / 2]), np.eye(3),  # noqa: E731
                                      np.array([AG.HOLSTER_IN / 2 + AG.WALL, AG.HOLSTER_IN / 2 + AG.WALL, AG.HOLSTER_DEPTH / 2]))
        S = lambda *a: list(a) + [0.0, 0.0]                                                           # noqa: E731
        return dict(obj=self.p0, side="R", q0=q0, colliders=[handle, body, trigger, holster],
                    targets={"middle": on_handle(A, U, 2, 18), "ring": on_handle(A, U, -16, 0),
                             "little": on_handle(A, U, -34, -18), "thumb": on_handle(A, U, 0, 35, w=0.2)},
                    refine={"middle": on_handle(A, U, 2, 18), "ring": on_handle(A, U, -16, 0),
                            "little": on_handle(A, U, -34, -18), "thumb": on_handle(A, U, 0, 35, w=0.5),
                            "index": G.plane_target(trig, trig_n, 2.0, near(trig, 6.0))},
                    iters=1500,
                    starts=[S(10, 0, 0, pl, el, 0, elb, p, 0, 0) for pl in (30, 60) for el in (50, 75)
                            for elb in (60, 90) for p in (70, 100)])

    def pose_at(self, t, keys):
        """The gun's (R, p) at t along keys [(t, R, p), ...]: min-jerk in position, slerp in rotation, held between."""
        if t <= keys[0][0]:
            return keys[0][1], keys[0][2]
        for (t0, R0, p0), (t1, R1, p1) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                w = float(np.clip(min_jerk((t - t0) / (t1 - t0)), 0.0, 1.0))
                R = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([R0, R1])))([w]).as_matrix()[0]
                return R, p0 + (p1 - p0) * w
        return keys[-1][1], keys[-1][2]

    def plan(self):
        g = self.grips["gun"]
        H, W = self.grip_pose("gun")
        lifted = self.p0 + np.array([0.0, 0.0, LIFT_MM])
        tip = AG.NOZZLE_TO
        aim_p = lambda dx: TIP_OVER_VISE + np.array([dx, 0.0, 0.0]) - AIM @ tip                          # noqa: E731
        t_on, t_lift = 1.75, 2.2                                 # closes on the handle, settles, then lifts
        # out past the right door's edge and in through the opening, in front of the chest: a straight line from the
        # holster crosses the open right door's panel
        inside = GATE_IN + np.array([0.0, 0.0, lifted[2] - GATE_IN[2]])
        mid = Rotation.from_matrix(np.stack([self.R0, AIM])).mean().as_matrix()
        # unhurried: a 460 mm move across the body in 0.8 s left the arm 350 mm behind
        # back in: over the bore with the nozzle's tip at its mouth, a pause while the hand settles (the bore is 24 mm
        # and the nozzle 8, so 10 mm off catches the rim), then slowly down, and held there a moment before letting go
        mouth = self.p0 + np.array([0.0, 0.0, 120.0])        # the 115 mm nozzle's tip 5 mm over the rim
        dt = np.cumsum([0.0, 1.0, 1.2, 1.1, 0.7, 0.7, 0.5, 1.1, 1.2, 0.8, 0.5, 1.2, 0.3])
        poses = [(self.R0, self.p0), (self.R0, lifted), (mid, inside), (AIM, aim_p(-SWEEP_MM)), (AIM, aim_p(SWEEP_MM)),
                 (AIM, aim_p(-SWEEP_MM)), (AIM, aim_p(0.0)), (mid, inside), (self.R0, lifted), (self.R0, mouth),
                 (self.R0, mouth), (self.R0, self.p0), (self.R0, self.p0)]
        keys = [(t_lift + d, R, p) for d, (R, p) in zip(dt, poses)]
        self.keys = keys
        t_down = keys[-1][0]
        self.look(0.0, self.p0)
        above = W + np.array([0.0, -20.0, 70.0])
        self.transit("R", 0.3, 1.3, above, fade=(H, 2.0))
        self.fingers("R", 0.6, open_like(self.hand, g["q"], 0.9))
        self.add("R", 1.3, t_lift, lambda t: [("pose", H, above + (W - above) * min_jerk((t - 1.3) / 0.4), 2.0)])
        self.fingers("R", t_on, g["q"])
        self.effort("R", t_on, 0.0, "gun")
        self.effort("R", t_lift, 0.5, "gun")
        self.event("grip", t_on, t_down + 0.2, side="R", grip="gun")
        self.load("R", t_lift, t_down, AG.GUN_KG)
        rel = lambda t: self.pose_at(t, keys)[0] @ self.R0.T                                           # noqa: E731
        self.follow("R", t_lift, t_down + 0.25, "gun", lambda t: self.pose_at(t, keys)[1], rel)
        self.event("carry", t_lift, t_down, side="R", object="air_gun")
        self.event("blow", keys[3][0], keys[6][0], side="R")
        self.effort("R", keys[3][0] - 0.1, 0.5, "gun")
        self.effort("R", keys[3][0], 0.6, "gun_fire")              # the index squeezes the trigger while aiming
        self.effort("R", keys[6][0], 0.6, "gun_fire")
        self.effort("R", keys[6][0] + 0.1, 0.5, "gun")
        self.look(keys[1][0], TIP_OVER_VISE)
        self.look(keys[6][0] + 0.4, ORIGIN + AG.HOLSTER_TOP)
        self.effort("R", t_down, 0.5, "gun")
        self.effort("R", t_down + 0.2, 0.0, None)
        self.fingers("R", t_down + 0.2, g["q"])
        self.fingers("R", t_down + 0.5, open_like(self.hand, g["q"], 0.8))
        self.add("R", t_down + 0.25, t_down + 0.6, lambda t: [("pose", H, W + (above - W) * min_jerk((t - t_down - 0.25) / 0.35), 2.0)])
        self.side["R"]["wrist"] = above
        self.transit("R", t_down + 0.6, t_down + 1.6, self.rest_of("R"))
        self.fingers("R", t_down + 1.6, self.q_relax)
        self.look(t_down + 0.6, TIP_OVER_VISE)
        self.clip("blow_off", 0.0, t_down + 1.0, "Blow out the vise")
        self.t = t_down + 1.8


def build(verbose=True):
    take = BlowOff(verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    np.savez(take.out / "gun_keys.npz", t=[k[0] for k in take.keys], R=[k[1] for k in take.keys],
             p=[k[2] for k in take.keys])                 # the gun's planned path, for the physics' checks
    if verbose:
        print(f"BlowOff: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    build("--quiet" not in sys.argv)
