"""Blow off the vise with the air gun (every VF-2 setup's first step, "Blow out the vise...", and its last, "...blow
the chips off"), planned for both hands on one trunk: the right hand takes the gun from its holster on the front
panel, aims the nozzle down into the vise and sweeps it along the jaws with the trigger held, then hangs it back; the
left hand stays by the operator's side (plan §4; the gun and holster, moonshot/world/air_gun.py).

    python -m moonshot.motion.blow_off            # plans into the data root's takes/blow-off
    python -m moonshot.motion.blow_off ct-slbeam op10 clean     # a setup's own run: takes/ct-slbeam-op10-clean-blow-off

The gun is held in a pistol grip: the palm on the back of its handle, the middle, ring and little fingers round it,
the index on the trigger and the thumb round the far side; solved in two stages, as the vise crank's knob.
"""
from __future__ import annotations

import shutil
import sys

import numpy as np
import torch
from scipy.spatial.transform import Rotation, Slerp

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import set_parallels as SP
from moonshot.motion.loads import scene_spec
from moonshot.motion.primitives import FPS, min_jerk, open_for, open_like
from moonshot.motion.step_take import StepTake
from moonshot.world import air_gun as AG
from moonshot.world import cell
from moonshot.world.vise import VISE

TAKES = data_root() / "takes"
ORIGIN = np.array([-cell.LOAD_X_MM, 0.0, 0.0])          # the VF-2's frame in the world (moonshot/world/cell.py)
# in the doorway, a little right, and back from it (moved 2026-11-04): from 200 mm nearer, the holster on the panel to
# the right was beside the operator, the arm taking the gun out to the side, wrist bent (people's likelihood 30-45 a
# frame there); from here it is ahead and to the right, and the vise still in reach with the gun
LUMBAR = np.array([-300.0, -1135.0, 955.0])
LIFT_MM = 170.0                                          # clears the 115 mm nozzle out of the 125 mm holster
# the nozzle's tip 110 mm over the jaws and 110 in front of the fixed one, pointing into the vise between them (AIM)
TIP_OVER_VISE = np.array([VISE["x"], VISE["fixed_face_y"] - 110.0, VISE["jaw_top_z"] + 110.0])
SWEEP_MM = 55.0                                          # along the jaws, either side of the middle
# in through the opening right of the operator's chest and well inside the open right door's edge (x 575 at 600 mm
# open): a gate at the operator's own y (-900) took the gun through the chest, and one 35 mm inside the edge of a door
# open 400 mm caught the gun's body on it
GATE_IN = ORIGIN + np.array([411.0, -690.0, 0.0])
# the doors stand fully open, as the vise take loads with them: at 300 mm the right forearm, reaching in from where
# the gun is in reach, meets the right door's edge
DOORS_OPEN_MM = 600.0
# blowing: the nozzle pointing forward, 30 deg to the left and 50 down, into the vise between the jaws 30 mm in front
# of the fixed one, the handle up and back toward the operator (straight ahead and 53 down from 50 mm in front of the
# fixed jaw, it blew onto that jaw's top, and the wrist was bent to hold it there); the body may turn the gun from this
# within reason (AXIS_SOFT)
AIM_PITCH_DEG, AIM_HEADING_DEG = 50.0, 30.0
AIM = Rotation.from_euler("z", AIM_HEADING_DEG, degrees=True).as_matrix() @ np.stack(
    [[0.0, np.cos(np.radians(AIM_PITCH_DEG)), -np.sin(np.radians(AIM_PITCH_DEG))], [-1.0, 0.0, 0.0],
     [0.0, np.sin(np.radians(AIM_PITCH_DEG)), np.cos(np.radians(AIM_PITCH_DEG))]], 1)
AXIS_SOFT = 1.5            # the nozzle's direction weighs this much (squared) against the solver's tsr axis weight: at
                           # 0.5-0.7 the body turned it 30-45 deg off its keyed direction, blowing over the vise; at 1.5
                           # 6-15 deg
FREE_EASE_S = 0.4          # the gun's turn freed, and fixed again, over this long out of and back over the bore
LIFT_DELAY_S = 0.16        # the gun starts up this long after the carry starts, as the parallels (set_parallels.py)
GRIP_CLEAR_MM = 2.0
GUN_READY = np.array([-20.0, -30.0, 120.0])  # the reach's ready point from the grip: over it (behind and left of it,
                                              # the hanging fingers touched the gun's valve body and turned it), and
                                              # below the pendant's foot (200 over, the fingers caught its edge)
GUN_RAISE_VIA = np.array([-60.0, -200.0, 150.0])   # ... come up to on the operator's side of the gun
GUN_OVER = np.array([0.0, -5.0, 50.0])        # ... and down onto the handle the last 50 mm
GUN_RAISE_S = 2.2           # slower than the reach: raised in 1.6 s the hand peaked at 920 mm/s, the reach at 770


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
    # people's range and posture weigh more than the body solver's defaults (as the pendant's keys weigh range more):
    # the take holds a carried gun's pose for most of its 15 s, and at the defaults the planned arm left people's range
    # wherever the gun's pose pulled it
    SOLVER_W = {"range": 3.0, "prior": 2.0}
    TIP_OVER, SWEEP, SWEEP_S = TIP_OVER_VISE, SWEEP_MM, 0.7      # where the nozzle blows, how far either side, how long
                                                                # one pass takes (a plate's table sweeps wider)

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
        # the handle as the skin meets it, GRIP_CLEAR_MM fatter: the hand's colliders sit inside its skin, and wrapped
        # round the handle itself the skin went 3.5 mm into it (5 in the run)
        handle = lambda p: G.sdf_cyl(p, self.gun_point([0, 0, -AG.HANDLE_HALF]), self.gun_point([0, 0, AG.HANDLE_HALF]),  # noqa: E731
                                     AG.HANDLE_R + GRIP_CLEAR_MM)
        holster = lambda p: G.sdf_box(p, ORIGIN + AG.HOLSTER_TOP - np.array([0, 0, AG.HOLSTER_DEPTH / 2]), AG.HOLSTER_R,  # noqa: E731
                                      np.array([AG.HOLSTER_IN / 2 + AG.WALL, AG.HOLSTER_IN / 2 + AG.WALL, AG.HOLSTER_DEPTH / 2]))
        S = lambda *a: list(a) + [0.0, 0.0]                                                           # noqa: E731
        return dict(obj=self.p0, side="R", q0=q0, colliders=[handle, body, trigger, holster],
                    # the pads GRIP_CLEAR_MM off the handle's girth and the index 1 mm off the trigger's face, the weld
                    # holding the gun in the hand (moonshot/sim/blow_off.py): pressed 2 mm in, as when the fingers held
                    # it by friction, the skin went 3.4-5.2 mm into the handle in the plan, at the girth 3.5. The index
                    # is pressed onto the trigger by the squeeze while it fires
                    targets={"middle": on_handle(A, U, 2, 18, comp=-GRIP_CLEAR_MM),
                             "ring": on_handle(A, U, -16, 0, comp=-GRIP_CLEAR_MM),
                             "little": on_handle(A, U, -34, -18, comp=-GRIP_CLEAR_MM),
                             "thumb": on_handle(A, U, 0, 35, comp=-GRIP_CLEAR_MM, w=0.2)},
                    refine={"middle": on_handle(A, U, 2, 18, comp=-GRIP_CLEAR_MM),
                            "ring": on_handle(A, U, -16, 0, comp=-GRIP_CLEAR_MM),
                            "little": on_handle(A, U, -34, -18, comp=-GRIP_CLEAR_MM),
                            "thumb": on_handle(A, U, 0, 35, comp=-GRIP_CLEAR_MM, w=0.5),
                            "index": G.plane_target(trig, trig_n, -1.0, near(trig, 6.0))},
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

    def gun_from_hand(self, H, W) -> tuple[np.ndarray, np.ndarray]:
        """The gun's (R, p) carried in a hand at (H, W), held as the plan holds it when the carry closes (the physics'
        weld holds it so, moonshot/sim/blow_off.py planned_relpose)."""
        return H @ self._Hc.T @ self.R0, W + H @ (self._Hc.T @ (self.p0 - self._Wc))

    def free_w(self, t: float) -> float:
        """How free the gun's turn is at t: 0 while its nozzle goes into or out of the bore (its pose kept exactly), 1
        carried and aimed, easing between over FREE_EASE_S."""
        a, b = self.free
        return min_jerk((t - a) / FREE_EASE_S) * (1 - min_jerk((t - (b - FREE_EASE_S)) / FREE_EASE_S))

    def reach_gun(self, t0: float) -> float:
        """The reach to the holstered gun, as the parallels' (motion/set_parallels.py reach): up beside the body and
        over to a ready point above and behind the grip, a pause, then the paced reach down onto the handle, the hand
        opening widest ~75% of the way. The grip has the wrist between the handle and the panel, the fingers hanging
        round the handle toward the operator, so the hand comes onto it from above: from the parallels' ready point,
        in front, the palm swept the handle and turned the hung gun 12 deg. The raise is slower than the reach, so
        the reach is the fastest move before the grasp (how grasp timing finds its start). Returns when it ends."""
        g = self.grips["gun"]
        H, W = self.grip_pose("gun")
        ready = W + GUN_READY
        t_ready = t0 + GUN_RAISE_S
        # up on the operator's side of the gun and over it, turned as the grip has it by then, so the fingers hang
        # clear of it: raised over it from the left, 1030-1100 high, the relaxed hanging fingers touched its top
        self.transit("R", t0, t_ready, ready, via=[W + GUN_RAISE_VIA], fade=(H, 1.0))
        self.add("R", t_ready, t_ready + SP.SETTLE_S, lambda tt, p=ready: [("pose", H, p, 1.0)])
        t_reach = t_ready + SP.SETTLE_S
        self.transit("R", t_reach, t_reach + SP.REACH_S, W, via=[W + GUN_OVER], fade=(H, 1.0))
        t_c = t_reach + SP.REACH_S
        self.fingers("R", t0 + 0.2, self.q_relax)
        self.fingers("R", t_reach, self.q_relax)
        self.fingers("R", t_reach + SP.REACH_PEAK * SP.REACH_S, open_for(self.hand, g["q"], 2 * AG.HANDLE_R))
        self.fingers("R", t_c, g["q"])
        return t_c

    def plan(self):
        g = self.grips["gun"]
        H, W = self.grip_pose("gun")
        lifted = self.p0 + np.array([0.0, 0.0, LIFT_MM])
        tip = AG.NOZZLE_TO
        aim_p = lambda dx: self.TIP_OVER + np.array([dx, 0.0, 0.0]) - AIM @ tip                          # noqa: E731
        self.look(0.0, self.p0)
        t_c = self.reach_gun(0.3)
        t_on = t_c - 0.1                                 # the grip's start: its carry closes 0.1 s after it
        t_load = t_c + SP.PRELOAD_S
        t_lift = t_load + LIFT_DELAY_S
        # out past the right door's edge and in through the opening, in front of the chest: a straight line from the
        # holster crosses the open right door's panel
        inside = GATE_IN + np.array([0.0, 0.0, lifted[2] - GATE_IN[2]])
        mid = Rotation.from_matrix(np.stack([self.R0, AIM])).mean().as_matrix()
        # unhurried: a 460 mm move across the body in 0.8 s left the arm 350 mm behind
        # back in: over the bore with the nozzle's tip at its mouth, a pause while the hand settles (the bore is 24 mm
        # and the nozzle 8, so 10 mm off catches the rim), then slowly down, and held there a moment before letting go
        mouth = self.p0 + np.array([0.0, 0.0, 120.0])        # the 115 mm nozzle's tip 5 mm over the rim
        sw = self.SWEEP_S
        dt = np.cumsum([0.0, 1.0, 1.2, 1.1, sw, sw, sw * 5 / 7, 1.1, 1.2, 0.8, 0.5, 1.2, 0.3])
        poses = [(self.R0, self.p0), (self.R0, lifted), (mid, inside), (AIM, aim_p(-self.SWEEP)), (AIM, aim_p(self.SWEEP)),
                 (AIM, aim_p(-self.SWEEP)), (AIM, aim_p(0.0)), (mid, inside), (self.R0, lifted), (self.R0, mouth),
                 (self.R0, mouth), (self.R0, self.p0), (self.R0, self.p0)]
        keys = [(t_lift + d, R, p) for d, (R, p) in zip(dt, poses)]
        self.keys = keys
        self.free = (keys[1][0], keys[8][0])         # out of the bore to back over it
        t_down = keys[-1][0]
        self.effort("R", t_c, 0.0, "gun")
        self.effort("R", t_c + 0.2, 0.5, "gun")
        self.event("grip", t_on, t_down + 0.2, side="R", grip="gun", on="air_gun")
        self.load("R", t_load, t_down, AG.GUN_KG)
        # carried and aimed, the gun's turn is the body's to choose within reason: its nozzle's tip kept on its path
        # and the nozzle pointing about along it (free to roll about itself, and softly held to its pitch and heading,
        # AXIS_SOFT), so the wrist isn't bent to a turn fixed in advance (on the new body the right arm was inside
        # people's range on 9% of frames with it fixed). Going into and out of the bore its pose is kept exactly
        Hg, Wg = g["H"], g["W"]
        tip_h = Hg.T @ (self.p0 + self.R0 @ tip - Wg)
        ax_h = Hg.T @ (self.R0 @ np.array([1.0, 0.0, 0.0]))

        def carried(t):
            R, p = self.pose_at(t, keys)
            Hh, Wh = self.grip_pose("gun", p, R @ self.R0.T)
            w = self.free_w(t)
            out = [("pose", Hh, Wh, 1.0 - w)]
            if w > 0:
                out.append(("tsr", tip_h, p + R @ tip, ax_h * AXIS_SOFT, R @ np.array([AXIS_SOFT, 0.0, 0.0]), w))
            return out
        self.add("R", t_c, t_lift, lambda t: [("pose", H, W, 1.0)])
        self.add("R", t_lift, t_down + 0.25, carried)
        self.side["R"]["wrist"] = W
        self.event("carry", t_load, t_down, side="R", obj="air_gun")
        self.event("blow", keys[3][0], keys[6][0], side="R")
        self.effort("R", keys[3][0] - 0.1, 0.5, "gun")
        self.effort("R", keys[3][0], 1.0, "gun_fire")              # the index squeezes the trigger while aiming: at
        self.effort("R", keys[6][0], 1.0, "gun_fire")              # 0.6, 1 mm off its face, it pressed 2.5 N
        self.effort("R", keys[6][0] + 0.1, 0.5, "gun")
        self.look(keys[1][0], self.TIP_OVER)
        self.look(keys[6][0] + 0.4, ORIGIN + AG.HOLSTER_TOP)
        self.effort("R", t_down, 0.5, "gun")
        self.effort("R", t_down + 0.2, 0.0, None)
        self.fingers("R", t_down + 0.2, g["q"])
        self.fingers("R", t_down + 0.5, open_like(self.hand, g["q"], 0.8))
        # off it straight up, the opened fingers leaving the handle's underside, and back down beside the body: toward
        # the operator, the fingers round the handle's near side would be drawn through it
        above = W + np.array([0.0, 10.0, 90.0])
        self.add("R", t_down + 0.25, t_down + 0.6,
                 lambda t: [("pose", H, W + (above - W) * min_jerk((t - t_down - 0.25) / 0.35), 2.0)])
        self.side["R"]["wrist"] = above
        self.transit("R", t_down + 0.6, t_down + 1.6, self.rest_of("R"),
                     via=[self.rest_of("R") + np.array([60.0, -20.0, 180.0])])
        self.fingers("R", t_down + 1.6, self.q_relax)
        self.look(t_down + 0.6, self.TIP_OVER)
        self.clip("blow_off", 0.0, t_down + 1.0, "Blow out the vise")
        self.t = t_down + 1.8

    def gun_path(self) -> list[tuple[float, np.ndarray, np.ndarray]]:
        """The gun's planned path for the physics (gun_keys.npz), a key a frame: exactly as keyed going into and out of
        the bore, and where the solved hand carries it while its turn is free, eased between."""
        i_c = int(round(self.carry_closes() * FPS))
        f_c = self.frames_at(i_c)["R"]
        self._Hc, self._Wc = f_c["H"], f_c["W"]
        out = []
        for k in range(self.n):
            t = k / FPS
            R, p = self.pose_at(t, self.keys)
            w = self.free_w(t)
            if w > 0:
                f = self.frames_at(k)["R"]
                Rs, ps = self.gun_from_hand(f["H"], f["W"])
                R = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([R, Rs])))([w]).as_matrix()[0]
                p = p + (ps - p) * w
            out.append((t, R, p))
        return out

    def carry_closes(self) -> float:
        """When the carry closes: the grip's start + 0.1 s (moonshot/sim/runner.py enclose)."""
        return next(e["t0"] for e in self.events if e["kind"] == "grip") + 0.1


def build(verbose=True, part: str | None = None, setup: str | None = None, step: str = "clean"):
    """Plans into the data root's takes/blow-off, or with a part and setup, that setup's own run for its clean or its
    unload (step) into takes/<part>-<setup>-<step>-blow-off (moonshot/planning/takes.py per_setup), take.json naming
    what the physics finds on the table (loads.scene_spec): for the clean, the vise open, its parallels in their rack
    and the part as it enters the setup waiting on the table; for the unload, the part as it leaves the setup clamped
    in the vise. The gun's path is the shared take's: it blows between the jaws, over whatever stands there."""
    out = TAKES / (f"{part}-{setup}-{step}-blow-off" if part else "blow-off")
    shared = TAKES / "blow-off" / "grips.json"     # the same grip on the same gun from the same stance, as the plates'
    if part and not (out / "grips.json").exists() and shared.exists():      # (plate_blow_off.py): its cache key
        out.mkdir(parents=True, exist_ok=True)                                # still decides whether it holds
        shutil.copy(shared, out / "grips.json")
    take = BlowOff(out=out, verbose=verbose)
    if part:
        take.extra = scene_spec(part, setup, stock="in" if step == "clean" else "out",
                                vise="open" if step == "clean" else "clamped")
    take.plan()
    take.solve()
    take.save()
    path = take.gun_path()
    np.savez(take.out / "gun_keys.npz", t=[k[0] for k in path], R=[k[1] for k in path],
             p=[k[2] for k in path])                      # the gun's planned path, for the physics and its checks
    if verbose:
        print(f"BlowOff: {take.T:.1f} s, {take.n} frames -> {take.out}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    build("--quiet" not in sys.argv, *args[:3])
