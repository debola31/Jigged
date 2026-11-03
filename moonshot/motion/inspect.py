"""nist-ftc-10's step 70, "Check the pocket depth", planned as a two-handed take at the inspection bench (plan §5.4).

The finished part lies pocket side up on its rubber mat. The right hand picks the 6 in calipers up by the slider as a
phone is held, palm on its back, thumb on the roller and fingertips on its other edge, and holds them out over the
pocket's near wall, turned two thirds of the way on end. The left takes the beam near its end, thumb on its near edge
and fingers round its far one, the right lets go, and the left stands them on end with the beam's width across the
wall and sets its end down on the rim: half of it on the rim, the depth rod, along the middle of its back, just past
the wall. The right takes the slider again as it is worked on end, palm on its back, thumb on the roller. From then the
left holds the calipers' angle and presses the beam's end on the face, and the right only moves the slider: as the
maker's manual has it (Mitutoyo 99MAD027A §10), the slider comes down while the beam stays on the face, so the rod runs
down the pocket's near wall to its floor; a light push seats it there and the calipers are read. The right closes them
and lets go, the left lifts them and turns them back, the right takes them as it picked them up, and lays them back on
their face where they lay.

With the right hand alone on them, holding the slider took the wrist to its cap and still left the beam 20 deg off
upright, which reads 18.1 mm for 17 (2026-11-02): the left hand on the beam is how people steady calipers for a depth.
Stood with the beam's width along the wall, only 1 mm of its end was on the rim. And no one grip of the right hand both
picks them up where the station keeps them (left of the part, across the body) and works the slider on end: the
pickup grip left them 13 to 28 deg off upright, and the slider's grip, lying on their face, needed 13 deg more
pronation than the forearm has. So the right hand changes grips while the left holds them, as people do.

    python -m moonshot.motion.inspect        # -> <data root>/takes/nist-ftc-10-inspect: reference.npz, take.json
"""
from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import (CARRY_EASE_S, LIFT_S, PART_AT, PRELOAD_S, REST, BenchPlan, bands, bench_box, box,
                                   mirror, oriented_box, settle)
from moonshot.motion.primitives import FPS, min_jerk, open_like
from moonshot.world import bench_cell as BC

OUT = data_root() / "takes" / "nist-ftc-10-inspect"
CAL_YAW = 0.0               # the station's: beam along X, jaws to the left; face down, the roller faces the operator
SEAT_N = 2.0                 # the push that seats the rod on the floor (proposed: light, as the manual asks)
LIFT_N = 4.0                 # the thumb's push closing the slider again, up its 2 N drag and its weight (proposed)
BEAM_N = 4.0                 # the left hand's push holding the beam's end on the face (proposed): firmer than the
                             # slider's 2 N drag, or the slider, its rod on the floor, holds the beam 0.06 mm off it
SHUT_MM = 1.0                # the slider is closed this far into its stop, closing it from wherever it was taken
OVERTRAVEL = 0.3             # the slider is planned this far past the floor; the rod stops it
ROD_FROM_WALL = 2.6          # the rod's near face this far past the pocket's near wall (mm): clear of the floor's
                             # 2 mm fillet, which would read short; the beam's end has 4.4 mm of the rim
ABOVE_MM = 30.0              # the beam's end is brought this far over the rim, then set down on it
PRE_MM = 50.0                # a hand comes onto a grip, and goes off it, along its forearm from this far back
PRESENT_DEG = 60.0           # the right hand holds them out turned this far toward on end: its pickup grip left them
                             # 21 to 28 deg short of it
HANDOVER_MM = 80.0           # ... this far over the rim: at 30 mm a hand changing grips knocked the part 9.6 mm
BEAM_END = BC.CAL["beam"][1][0]
SLIDER_GRIP = np.array([-60.0, 5.0, 6.0])   # the right hand's grip on the slider, in the calipers' frame (mm)
BEAM_GRIP = np.array([80.0, 9.75, 4.25])     # the left hand's pinch across the beam, in the calipers' frame (mm): 36 mm
                                             # above its end, clear of the part
GRIP_AT = {"cal": SLIDER_GRIP, "slider": SLIDER_GRIP, "beam": BEAM_GRIP}
CARD = "caliper-measure-bore"                # the usage card the take plays (moonshot/cards), whose footage it is held to


def loose() -> str:
    return BC.mat_body(PART_AT) + BC.part_body(PART_AT) + BC.caliper_body(BC.rest_mm("cal6"), CAL_YAW, face_down=True)


class InspectPlan(BenchPlan):
    def __init__(self, out=OUT, verbose=True):
        super().__init__(out, verbose)
        rest = settle(loose(), skip=("cal6",))
        self.part, self.cal0 = rest["part"], rest["insp_cal6"]
        for body in ("insp_cal6_slider", "insp_cal6"):
            self.paths[body] = [(0.0, self.cal0[1], self.cal0[0])]
        self.solve_grips(self.grip_specs(), rest | {"insp_cal6_slider": self.cal0})

    def theta0(self, n) -> np.ndarray:
        """Started with the right forearm turned palm in as far as the calipers are turned toward on end: started all
        from the pickup's pronation, the solve stuck 46 deg short of upright."""
        th = super().theta0(n)
        R0 = self.cal0[1]
        for k in range(n):
            R, _ = self.obj_at("insp_cal6", k / FPS)
            th[k, 7] -= 90.0 * min(1.0, Rotation.from_matrix(R @ R0.T).magnitude() / (np.pi / 2))   # pronation
        return th

    def cal_point(self, p_asset, pose=None):
        p, R = pose or self.cal0
        return p + R @ np.asarray(p_asset, float)

    def cal_colliders(self, pose):
        """The calipers' solids at pose (closed), for a grip on them."""
        p, R = pose
        C = BC.CAL
        cols = [oriented_box(self.cal_point((np.array(lo) + hi) / 2, pose), R, (np.array(hi) - lo) / 2)
                for lo, hi in (C[k] for k in ("beam", "jaw_out", "jaw_in", "slider", "slider_bulge", "mjaw_out", "rod"))]
        ro = C["roller"]
        ra = self.cal_point(ro["at"], pose)
        cols.append(lambda q: G.sdf_cyl(q, ra - R[:, 1] * ro["half"], ra + R[:, 1] * ro["half"], ro["r"]))
        return cols

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        bc, bh = bench_box()
        p0, R0 = self.cal0
        C = BC.CAL
        ro = C["roller"]
        # a phone's grip to pick them up: the palm on the back (up, lying face down), the thumb on the roller's end, the
        # index and middle fingertips side by side on the slider's other edge, at the buttons' bulge: the fingers reach
        # across it away from the operator, so the index is the left of the two
        thumb_at = self.cal_point([ro["at"][0], ro["at"][1] + ro["half"], ro["at"][2]])
        bulge = self.cal_point([np.mean([C["slider_bulge"][0][0], C["slider_bulge"][1][0]]), C["slider_bulge"][0][1], 6.0])
        edge = -R0[:, 1]                                   # the slider's far edge faces this way
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=55, middle_mcp_flex=45, middle_pip=55, ring_mcp_flex=55, ring_pip=65,
                  little_mcp_flex=60, little_pip=70, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=20, thumb_ip=15)
        cal = dict(of="insp_cal6_slider", obj=p0, q0=q0, iters=1000, colliders=self.cal_colliders(self.cal0) + [box(bc, bh)],
                   targets={"thumb": G.plane_target(thumb_at, R0[:, 1], 2.0, bands(thumb_at, x=(-3, 3), z=(-3, 3))),
                            "index": G.plane_target(bulge, edge, 2.0, bands(bulge, x=(-8, -2), z=(-4, 4))),
                            "middle": G.plane_target(bulge, edge, 2.0, bands(bulge, x=(2, 8), z=(-4, 4)))},
                   starts=[S(20, 0, r, pl, 45, 0, 70, p, 0, 0) for p in (70, 90) for r in (-15, 0) for pl in (75, 95)])
        stand = self.standing()
        Rs = stand[1]
        cols = self.cal_colliders(stand) + self.part_colliders() + [box(bc, bh)]
        along = lambda c, lo, hi, **kw: bands(c, z=(lo, hi), **kw)   # noqa: E731  (on end, along the beam is world z)
        # the same grip as the right hand works the slider on end: the index the higher
        thumb_at = self.cal_point([ro["at"][0], ro["at"][1] + ro["half"], ro["at"][2]], stand)
        bulge = self.cal_point([np.mean([C["slider_bulge"][0][0], C["slider_bulge"][1][0]]), C["slider_bulge"][0][1],
                                6.0], stand)
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=55, middle_mcp_flex=45, middle_pip=55, ring_mcp_flex=55, ring_pip=65,
                  little_mcp_flex=60, little_pip=70, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=20, thumb_ip=15)
        slider = dict(of="insp_cal6_slider", at=stand, obj=stand[0], q0=q0, iters=1000, colliders=cols,
                      targets={"thumb": G.plane_target(thumb_at, Rs[:, 1], 2.0, along(thumb_at, -3, 3, x=(-3, 3))),
                               "index": G.plane_target(bulge, -Rs[:, 1], 2.0, along(bulge, 2, 8, x=(-4, 4))),
                               "middle": G.plane_target(bulge, -Rs[:, 1], 2.0, along(bulge, -8, -2, x=(-4, 4)))},
                      starts=[S(20, 0, r, 70, 50, 0, 80, pr, 0, 0) for pr in (0, 30, 60) for r in (-10, 5)])
        # the left hand on the beam on end, from the left, its palm on the display's face: the thumb on the beam's edge
        # toward the operator, the index and middle round its far edge, the index the higher
        near = self.cal_point([BEAM_GRIP[0], C["beam"][1][1], BEAM_GRIP[2]], stand)
        far = self.cal_point([BEAM_GRIP[0], C["beam"][0][1], BEAM_GRIP[2]], stand)
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=50, middle_mcp_flex=50, middle_pip=55, ring_mcp_flex=60, ring_pip=70,
                  little_mcp_flex=65, little_pip=75, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=15, thumb_ip=10)
        beam = dict(side="L", of="insp_cal6", at=stand, obj=stand[0], q0=q0, iters=1000, colliders=cols,
                    targets={"thumb": G.plane_target(near, Rs[:, 1], 2.0, along(near, -6, 6)),
                             "index": G.plane_target(far, -Rs[:, 1], 2.0, along(far, 0, 12)),
                             "middle": G.plane_target(far, -Rs[:, 1], 2.0, along(far, -14, -2))},
                    starts=[S(20, 0, r, 60, 45, -10, 80, p, 0, 0) for p in (20, 50) for r in (0, -10)])
        return {"cal": cal, "slider": slider, "beam": beam}

    # --- the calipers on end beside the pocket ---------------------------------------------------------------------
    def standing(self):
        """The calipers' pose (closed) standing on the near rim: the beam's end down on datum A with its width across
        the wall, the rod's near face ROD_FROM_WALL past it, halfway along it; the roller toward the operator and the
        display to the left. From where they lie, a quarter turn about the line of sight. Square to datum A as the part
        rests, 0.4 deg off level on its mat: upright to the world, the beam's end stood on a corner and read 0.04 mm
        long. (origin, rotation)"""
        w, x, y, z = BC.POCKET_UP
        tilt = self.part[1] @ Rotation.from_quat([x, y, z, w]).as_matrix().T      # the part's rest off its nominal
        R = tilt @ np.stack([[0.0, 0.0, -1.0], [0.0, -1.0, 0.0], [-1.0, 0.0, 0.0]], 1)  # asset x down, y to the eyes
        wall = self.to_world([np.mean(BC.POCKET["x"]), 0.0, BC.POCKET["z"][1]])  # datum A at the near wall's top
        rod = BC.CAL["rod"]
        near = np.array([BEAM_END, rod[1][1], np.mean([rod[0][2], rod[1][2]])])  # the rod's end, its face to the wall
        return wall - R @ near + np.array([0.0, ROD_FROM_WALL, 0.0]), R

    def presented(self):
        """Where the right hand holds them out for the left: on end HANDOVER_MM over the rim, turned back PRESENT_DEG
        of the way toward lying about the left hand's pinch. (origin, rotation)"""
        p, R = self.standing()
        p = p + np.array([0.0, 0.0, HANDOVER_MM])
        c = p + R @ BEAM_GRIP
        D = Rotation.from_rotvec([0.0, -np.radians(90.0 - PRESENT_DEG), 0.0]).as_matrix()
        return c + D @ (p - c), D @ R

    def move_cal(self, t0, t1, R, p):
        """Plan the calipers, closed, over [t0, t1]: the beam and the slider together."""
        for body in ("insp_cal6_slider", "insp_cal6"):
            self.move(body, t0, t1, R, p)

    # --- a hand onto a grip and off it -------------------------------------------------------------------------------
    def back_from(self, grip, t):
        """The way back along the forearm from a grip at t (unit; a left hand's in the mirrored frame), and the wrist."""
        g = self.grips[grip]
        _, W = self.grip_pose(grip, t)
        R, p = self.obj_at(g["of"], t)
        c = p + R @ GRIP_AT[grip]
        back = W - (mirror(c) if g["side"] == "L" else c)
        return back / np.linalg.norm(back), W

    def take(self, grip, t_from, t_on, via=()):
        """A hand onto a grip by t_on: to PRE_MM back along its forearm from it, its turn faded in, then on over the
        last 0.7 s, its fingers opening on the way and closing as it arrives. Reaching for a tool as it came, the left
        forearm swept the calipers' jaws and knocked them 60 mm."""
        g = self.grips[grip]
        side = g["side"]
        H, W = self.grip_pose(grip, t_on)
        back, _ = self.back_from(grip, t_on)
        pre, t_pre = W + back * PRE_MM, t_on - 0.7
        self.transit(side, t_from, t_pre, pre, via=via, fade=(H, 1.0))
        self.add(side, t_pre, t_on, lambda t: [("pose", H, pre + (W - pre) * min_jerk((t - t_pre) / 0.6), 3.0)])
        self.wrist[side] = W
        self.fingers(side, t_from + 0.3, open_like(self.hand, g["q"], 0.4))
        self.fingers(side, t_on, g["q"])
        self.effort(side, t_on, 0.0, grip)
        self.effort(side, t_on + 0.2, 0.3, grip)

    def let_go(self, grip, t_on, t_off, lifted=None, **carry):
        """A hand holding a grip from t_on lets go at t_off and goes back along its forearm, relaxing only as it goes:
        relaxed first, the arm sagged with the tool still in it, opening the calipers 1 mm, and let go, sank 5.8 mm
        into their slider. Its carry and events: the carry from 0.1 s into the grip, or from when the hand lifted
        the tool off the bench (lifted)."""
        g = self.grips[grip]
        side = g["side"]
        self.carry(grip, t_on, t_off, **carry)
        back, W = self.back_from(grip, t_off)
        self.effort(side, t_off + 0.1, 0.3, grip)
        self.effort(side, t_off + 0.3, 0.0, grip)
        self.event("grip", t_on, t_off, side=side, grip=grip, on=g["of"])   # its squeeze ends with its hold: on after,
        self.event("carry", lifted or t_on + 0.1, t_off, obj=g["of"], grip=grip, side=side,   # it sank the fingers 6 mm in
                   **({"ease_in": CARRY_EASE_S} if lifted else {}))
        self.fingers(side, t_off, g["q"])
        self.fingers(side, t_off + 0.3, open_like(self.hand, g["q"], 0.5))
        self.transit(side, t_off + 0.02, t_off + 0.5, W + back * PRE_MM)
        self.fingers(side, t_off + 1.2, self.q_relax)
        return W

    # --- the verbs ------------------------------------------------------------------------------------------------
    def pick_up(self):
        t0 = self.t
        _, Wg = self.grip_pose("cal", t0)
        self.look(t0, self.cal_point([-60.0, 10.0, 0.0]))
        # ready in front of the body, over the bench's edge toward them
        tg = self.reach("R", "cal", t0, ready=Wg + [130, -120, 110], approach=Wg + [15, -10, 55], opened=0.7)
        self.effort("R", tg, 0.0, "cal")
        self.effort("R", tg + 0.25, 0.3, "cal")
        p0, R0 = self.cal0
        self.t_lift = tg + PRELOAD_S
        self.move_cal(self.t_lift, self.t_lift + LIFT_S, R0, p0 + [0, 0, 30])
        self.t_grab, self.t = tg, self.t_lift + LIFT_S
        self.clip("pick up", t0, self.t, "PICK UP  the calipers by the slider, as a phone is held")

    def present(self):
        """Held out turned toward on end over the rim; the left hand takes the beam and the right lets go."""
        Pp, Rp = self.presented()
        t0 = self.t
        t_at = t0 + 1.6
        self.look(t0, Pp + Rp @ BEAM_GRIP)
        self.move_cal(t0, t_at, Rp, Pp)
        tL = t_at + 1.0
        self.take("beam", t0 + 0.6, tL, via=[REST + [0, 60, 160]])
        self.t_beam = tL
        t_off = tL + 0.1                     # as the left's hold starts: both holding, the right's slips slid the slider 3 mm
        self.let_go("cal", self.t_grab, t_off, lifted=self.t_lift, free=[(self.t_lift + LIFT_S, t_off)],
                    point=SLIDER_GRIP)
        self.t = t_off + 0.25
        self.clip("present", t0, self.t, "HAND OVER  the calipers to the left hand, on the beam")

    def stand(self):
        """The left stands them on end and sets the beam's end down on the rim; the right takes the slider."""
        p, R = self.standing()
        t0 = self.t
        self.look(t0, p + R @ [BEAM_END, 9.75, 4.0])
        self.move_cal(t0, t0 + 0.9, R, p + [0, 0, ABOVE_MM])
        self.move_cal(t0 + 0.9, t0 + 1.5, R, p)
        self.t_touch = t0 + 1.5
        tS = t0 + 2.3
        self.take("slider", t0 + 0.6, tS)
        self.t_slider = tS
        self.t = tS + 0.3
        self.clip("stand", t0, self.t, "STAND  the calipers on end on the rim, the right hand on the slider")

    def measure(self, depth):
        """The slider down until the rod meets the floor, a light push to seat it, the reading, the slider back up."""
        p, R = self.standing()
        down = np.array([0.0, 0.0, -1.0])
        t0 = self.t
        s_end = depth + OVERTRAVEL
        t_seat = t0 + 0.4 + s_end / 12.0                   # the slider down at 12 mm/s
        self.move("insp_cal6_slider", t0, t_seat, R, p + down * s_end)
        wall = self.to_world([np.mean(BC.POCKET["x"]), 0.0, BC.POCKET["z"][1]])
        self.look(t0, wall + np.array([0.0, 0.0, -depth / 2]))
        t_read = t_seat + 0.8                              # the hand lags its descent: at 0.3 s the rod was 0.5 mm up
        self.look(t_seat, self.cal_point([-80.0, 10.0, 12.5], (p, R)))      # the display
        t_lift = t_read + 1.6
        t_shut = t_lift + 0.4 + s_end / 25.0
        # from the beam's touching down: sight, then touch, keep its end where the rod clears the wall (the left hand
        # put it 4-7 mm out, and the rod stood on the rim), and its turn upright
        self.event("press", self.t_touch, t_shut, side="L", normal=[0.0, 0.0, 1.0], force=BEAM_N, contact="part",
                   at="cal6_beam", upright="insp_cal6", obj="insp_cal6", point=[BEAM_END, 9.75, 4.25],
                   square_to="part", square_R=self.part[1].tolist(), square_p=self.part[0].tolist(), seat=True)
        self.event("press", t_seat - 0.3, t_lift, side="R", normal=[0.0, 0.0, 1.0], force=SEAT_N, contact="part",
                   at="cal6_rod")
        self.read = [t_read, t_lift - 0.1]
        self.move("insp_cal6_slider", t_lift, t_shut, R, p - down * SHUT_MM)  # the slider back up: closed
        # by a push of the thumb: the arm placed alone, it lagged under the drag and closed them 1.3 mm of 17
        self.event("press", t_lift, t_shut, side="R", normal=list(down), force=LIFT_N, contact="insp_cal6",
                   at="cal6_slider")
        t_off = t_shut + 0.2
        # held firmly, as a thumb on a roller holds it: held loosely, the hand turned about its pinch as it rose and
        # left the slider, 2 N of drag on it, where it was
        self.let_go("slider", self.t_slider, t_off)
        self.t = t_off
        self.clip("measure", t0, self.t, "MEASURE  the rod down to the pocket's floor, read, closed again")

    def hand_back(self):
        """The left lifts them off the rim and turns them back as they were held out; the right takes them as it picked
        them up, and the left lets go and goes."""
        p, R = self.standing()
        Pp, Rp = self.presented()
        t0 = self.t
        self.move_cal(t0 + 0.4, t0 + 0.9, R, p + [0, 0, ABOVE_MM])
        self.move_cal(t0 + 0.9, t0 + 1.7, Rp, Pp)
        tC = t0 + 2.5
        self.take("cal", t0 + 0.8, tC)
        self.t_grab = tC
        t_off = tC + 0.1                     # as the right's hold starts
        W = self.let_go("beam", self.t_beam, t_off)
        self.transit("L", t_off + 0.7, t_off + 1.85, REST, via=[W + [0, -230, 60]])   # past the bench's edge first
        self.t = t_off
        self.clip("hand back", t0, self.t, "HAND BACK  the calipers to the right hand")

    def put_back(self):
        """The right lays them back on their face where they lay, as it picked them up."""
        p0, R0 = self.cal0
        t0 = self.t
        t1 = t0 + 0.2
        self.look(t1, p0)
        self.move_cal(t1, t1 + 1.6, R0, p0 + [0, 0, 30])
        t_down = t1 + 2.1
        self.move_cal(t1 + 1.6, t_down, R0, p0 + [0, 0, 0.3])
        t_off = t_down + 0.1
        W = self.let_go("cal", self.t_grab, t_off, free=[(self.t_grab + 0.3, t1 + 1.3)], point=SLIDER_GRIP)
        self.transit("R", t_off + 0.7, t_off + 1.85, REST, via=[W + [0, -230, 60]])   # back past the bench's edge first
        self.t = t_off + 1.85
        self.clip("put back", t0, self.t, "PUT BACK  the calipers, closed, where they lay")

    def compose(self, depth: float):
        self.t = 0.5
        self.pick_up()
        self.present()
        self.stand()
        self.measure(depth)
        self.hand_back()
        self.put_back()


def pocket_depth_mm() -> float:
    """The pocket's depth as the part is modelled: its floor below datum A (bench_cell.POCKET, from the STEP)."""
    return BC.POCKET["depth"]


def build(solve=True, verbose=True) -> InspectPlan:
    plan = InspectPlan(verbose=verbose)
    plan.compose(pocket_depth_mm())
    if solve:
        plan.solve()
        plan.save({"read": plan.read, "part_at": PART_AT.tolist(), "cal_yaw": CAL_YAW, "loose": loose(), "card": CARD})
    return plan


if __name__ == "__main__":
    build()
