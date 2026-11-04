"""nist-ftc-10's step 70, "Check the pocket depth", planned as a two-handed take at the inspection bench (plan §5.4).

The finished part lies pocket side up on its rubber mat, the 6 in calipers face up at the station's rest to its left,
their jaws to the right. The left hand fetches them: it takes the beam near its end, palm on the display's face, thumb
on its near edge and fingers round its far one, lifts them, and a quarter turn about the line of sight stands them on
end with the beam's width across the pocket's near wall, its end down on the rim: half of it on the rim, the depth
rod, along the middle of its back, just past the wall. The right hand takes the slider, palm on its back, thumb on the
roller. From then the left holds the calipers' angle and presses the beam's end on the face, and the right only moves
the slider: as the maker's manual has it (Mitutoyo 99MAD027A §10), the slider comes down while the beam stays on the
face, so the rod runs down the pocket's near wall to its floor; a light push seats it there and the calipers are read.
The right closes them and lets go, and the left lifts them off, turns them back and lays them where they lay.

With the right hand alone on them, holding the slider took the wrist to its cap and still left the beam 20 deg off
upright, which reads 18.1 mm for 17 (2026-11-02): the left hand on the beam is how people steady calipers for a depth.
Stood with the beam's width along the wall, only 1 mm of its end was on the rim. The right hand fetching them from the
left of the part, across the body, took its forearm to 66-72 deg of pronation, its shoulder to 52 deg of rotation
and the trunk to -15 deg of turn, past people's (61, 31, -14), however it held them: the left hand fetches them from
its own side (your decision, 2026-11-03).

    python -m moonshot.motion.inspect        # -> <data root>/takes/nist-ftc-10-inspect: reference.npz, take.json
"""
from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import (CLOSE_S, LIFT_S, PART_AT, REACH_S, RISE_S, STILL_S, BenchPlan, bands, bench_box, box,
                                   oriented_box, settle)
from moonshot.motion.primitives import open_like
from moonshot.world import bench_cell as BC

OUT = data_root() / "takes" / "nist-ftc-10-inspect"
CAL_YAW = 180.0             # the station's: beam along X, jaws to the right, face up; the roller faces the operator
SEAT_N = 2.0                 # the push that seats the rod on the floor (proposed: light, as the manual asks)
LIFT_N = 4.0                 # the thumb's push closing the slider again, up its 2 N drag and its weight (proposed)
BEAM_N = 5.0                 # the left hand's push holding the beam's end on the face (proposed): firmer than the
                             # slider's 2 N drag, or the slider, its rod on the floor, holds the beam 0.06 mm off it;
                             # at 4 N the right hand's seat press, trimmed to 2-4 N, lifted it for a frame (0.039 mm)
                             # in one run of three
SHUT_MM = 1.0                # the slider is closed this far into its stop, closing it from wherever it was taken
OVERTRAVEL = 0.3             # the slider is planned this far past the floor; the rod stops it
ROD_FROM_WALL = 2.6          # the rod's near face this far past the pocket's near wall (mm): clear of the floor's
                             # 2 mm fillet, which would read short; the beam's end has 4.4 mm of the rim
ABOVE_MM = 50.0              # the beam's end is brought this far over the rim, held a moment, then set down on it: from
                             # 30 mm, without the moment, the left arm carrying them from where they lay still sagged
                             # 33 mm as it got there and set the end down in the pocket
CLEAR_MM = 60.0              # stood up on end beside where they lay, the beam's end this far over the part's top, then
                             # carried over the rim: turned on end on the way, the end swung down onto the part's corner
                             # and pushed it 76 mm
PRE_MM = 50.0                # a hand goes off a grip along its forearm this far back
END_FIRST_DEG = 4.0          # laid back down, the beam's end this much lower than the rest of them
BEAM_END = BC.CAL["beam"][1][0]
SLIDER_GRIP = np.array([-60.0, 5.0, 6.0])   # the right hand's grip on the slider, in the calipers' frame (mm)
BEAM_GRIP = np.array([80.0, 9.75, 4.25])     # the left hand's pinch across the beam, in the calipers' frame (mm): 36 mm
                                             # above its end, clear of the part
HOLD_GRIP = np.array([50.0, 9.75, 4.25])     # ... and as it holds them on end: 66 mm above the rim, the hand clear of
                                             # the part's ear; at 36 mm it lay on it
EDGE = (-1.5, 1.5)                           # ... each pad's centre this near its edge's middle, across the beam's
                                             # 3.5 mm (world z lying, world x on end)
GRIP_AT = {"slider": SLIDER_GRIP, "beam": BEAM_GRIP, "hold": HOLD_GRIP}
SLIDER_AFTER_S = 0.8         # the right hand's grip on the slider closed this long after the beam's end touches down,
                             # the calipers settled: at 0.4 s, as they still turned, its fingers pushed the slider 8 mm
                             # open
CAL_EASE_S = 0.15            # the carry's correction of the hand eases in this fast as it lifts the calipers
TAKE_MM, TAKE_S = 8.0, 0.45  # ... and it first rises this far over this long, taking their weight as the arm gives
                             # under their 1.7 N, lifted by the beam's end, so they tilt before their middle leaves the
                             # bench: taking 5 mm, the load took 0.47 s to lift them
PRELOAD_S = 0.15             # ... from this long after the grip has closed, and the carry with it (people's preload
                             # 0.14-0.32 s)
LAY_W = 1.5                  # laying them back, the hand holds their turn this loosely (the carry's 3): they settle on
                             # the bench. Held as firmly, the left forearm turned past people's (62-63 deg, their 61)
                             # for the hand on end to lay them flat; at 0.5 they were put back 15 mm off
PRESS_MM = 2.0               # taken, they are held this far into the bench until they are lifted: the carry closing on
                             # them, the hand's give lifted 0.1-0.2 N of them at once, past people's load onset (5%),
                             # held 0.5 mm in as well
CARD = "caliper-measure-bore"                # the usage card the take plays (moonshot/cards), whose footage it is held to


def loose() -> str:
    return BC.mat_body(PART_AT) + BC.part_body(PART_AT) + BC.caliper_body(BC.rest_mm("cal6"), CAL_YAW)


class InspectPlan(BenchPlan):
    # people's range weighed as a step take may (BodySolver.W["range"], 0.5): at 2 the right arm rising from the thigh
    # and the trunk as the left stood the calipers on the rim were past people's for 46 frames of 650, at 2.5 38-45 and
    # the left arm's 50 of 639; at 5 the hands missed enough to slide the part and read 0.44 mm short
    solver_w = {"range": 3.5}

    def __init__(self, out=OUT, verbose=True):
        super().__init__(out, verbose)
        rest = settle(loose(), skip=("cal6",))
        self.part, self.cal0 = rest["part"], rest["insp_cal6"]
        for body in ("insp_cal6_slider", "insp_cal6"):
            self.paths[body] = [(0.0, self.cal0[1], self.cal0[0])]
        self.solve_grips(self.grip_specs(), rest | {"insp_cal6_slider": self.cal0})

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
        C = BC.CAL
        ro = C["roller"]
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
        # the left hand pinching the beam near its end across its width: the thumb on the beam's edge toward the
        # operator, the index and middle on its far edge, the index nearer the jaws, each pad on its edge's 3.5 mm
        # (EDGE): held only to the edges' planes, the pads sat on them in the air, 13-28 mm over the beam lying and
        # 70 mm off its face on end, and the body's fingers never touched it. Twice: as it takes them, lying
        # face up at the station's rest (along the beam is world x), and as it holds them on end on the rim (`hold`,
        # weighing people's posture as the deburring tool's grip does). One grip can't do both: the hand's turn is the
        # grip's only where the body can put it, and the calipers follow the hand. The grip solved lying put the body
        # 6.8 deg off it on end, the beam stood 2 deg off on the rim's edge and read 0.12 mm short, and the trunk leant
        # 9 deg to the left; solved on end, it was 15 deg off lying
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=50, middle_mcp_flex=50, middle_pip=55, ring_mcp_flex=60, ring_pip=70,
                  little_mcp_flex=65, little_pip=75, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=15, thumb_ip=10)
        lay = self.cal0
        R0 = lay[1]
        near = self.cal_point([BEAM_GRIP[0], C["beam"][1][1], BEAM_GRIP[2]])
        far = self.cal_point([BEAM_GRIP[0], C["beam"][0][1], BEAM_GRIP[2]])
        beam = dict(side="L", of="insp_cal6", obj=lay[0], q0=q0, iters=1000,
                    colliders=self.cal_colliders(lay) + [box(bc, bh)],
                    targets={"thumb": G.plane_target(near, R0[:, 1], 2.0, bands(near, x=(-6, 6), z=EDGE)),
                             "index": G.plane_target(far, -R0[:, 1], 2.0, bands(far, x=(0, 12), z=EDGE)),
                             "middle": G.plane_target(far, -R0[:, 1], 2.0, bands(far, x=(-14, -2), z=EDGE))},
                    starts=[S(20, 0, r, 60, 45, -10, 80, p, 0, 0) for p in (30, 60) for r in (0, -10)])
        near = self.cal_point([HOLD_GRIP[0], C["beam"][1][1], HOLD_GRIP[2]], stand)
        far = self.cal_point([HOLD_GRIP[0], C["beam"][0][1], HOLD_GRIP[2]], stand)
        hold = dict(side="L", of="insp_cal6", at=stand, obj=stand[0], q0=q0, iters=1000, weights=(3.0, 3.0),
                    colliders=cols,
                    targets={"thumb": G.plane_target(near, Rs[:, 1], 2.0, along(near, -6, 6, x=EDGE)),
                             "index": G.plane_target(far, -Rs[:, 1], 2.0, along(far, 0, 12, x=EDGE)),
                             "middle": G.plane_target(far, -Rs[:, 1], 2.0, along(far, -14, -2, x=EDGE))},
                    starts=[S(20, 0, r, 55, 40, -30, 80, p, 0, 0) for p in (0, 30) for r in (0, -10)])
        return {"slider": slider, "beam": beam, "hold": hold}

    # --- the calipers on end beside the pocket ---------------------------------------------------------------------
    def standing(self):
        """The calipers' pose (closed) standing on the near rim: the beam's end down on datum A with its width across
        the wall, the rod's near face ROD_FROM_WALL past it, halfway along it; the roller toward the operator and the
        display to the left. From where they lie face up, a quarter turn about the line of sight. Square to datum A as the part
        rests, 0.4 deg off level on its mat: upright to the world, the beam's end stood on a corner and read 0.04 mm
        long. (origin, rotation)"""
        w, x, y, z = BC.POCKET_UP
        tilt = self.part[1] @ Rotation.from_quat([x, y, z, w]).as_matrix().T      # the part's rest off its nominal
        R = tilt @ np.stack([[0.0, 0.0, -1.0], [0.0, -1.0, 0.0], [-1.0, 0.0, 0.0]], 1)  # asset x down, y to the eyes
        wall = self.to_world([np.mean(BC.POCKET["x"]), 0.0, BC.POCKET["z"][1]])  # datum A at the near wall's top
        rod = BC.CAL["rod"]
        near = np.array([BEAM_END, rod[1][1], np.mean([rod[0][2], rod[1][2]])])  # the rod's end, its face to the wall
        return wall - R @ near + np.array([0.0, ROD_FROM_WALL, 0.0]), R

    def beside(self):
        """The calipers on end, as they stand on the rim, over where they lay, the beam's end CLEAR_MM over the part's
        top. (origin, rotation)"""
        p, R = self.standing()
        lay = self.cal0[0]
        return np.array([lay[0], lay[1], p[2] + CLEAR_MM]), R

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
        back = W - (self.mirror(c) if g["side"] == "L" else c)
        return back / np.linalg.norm(back), W

    def let_go(self, grip, t_on, t_off, lifted=None, relax=1.2, wait=0.0, away=(0.0, 0.0, 0.0), **carry):
        """A hand holding a grip from t_on lets go at t_off and goes back along its forearm (and `away`), `wait` after
        it lets go, relaxing only as it goes (relaxed relax after it lets go, or kept open for another grip): relaxed
        first, the arm sagged with the tool still in it, opening the calipers 1 mm, and let go, sank 5.8 mm into their
        slider. Its carry and events: the carry from 0.1 s into the grip, or, for a tool taken off the bench, from
        `lifted`, easing in (CAL_EASE_S)."""
        g = self.grips[grip]
        side = g["side"]
        self.carry(grip, t_on, t_off, **carry)
        back, W = self.back_from(grip, t_off)
        self.effort(side, t_off + 0.1, 0.3, grip)
        self.effort(side, t_off + 0.3, 0.0, grip)
        self.event("grip", t_on, t_off, side=side, grip=grip, on=g["of"])   # its squeeze ends with its hold: on after,
        self.event("carry", lifted or t_on + 0.1, t_off, obj=g["of"], grip=grip, side=side,   # it sank the fingers 6 mm in
                   **({"ease_in": CAL_EASE_S} if lifted else {}))
        self.fingers(side, t_off, g["q"])
        self.fingers(side, t_off + 0.3, open_like(self.hand, g["q"], 0.5))
        self.transit(side, t_off + 0.02 + wait, t_off + 0.5 + wait, W + back * PRE_MM + np.asarray(away, float))
        if relax is not None:
            self.fingers(side, t_off + relax, self.q_relax)
        return W

    def retake(self, grip, t0, move_s=0.6):
        """A hand just off the tool takes it again with another grip: from where it is, onto it along the new grip's
        forearm, open, then closing on it. Returns when the grip has closed."""
        g = self.grips[grip]
        side = g["side"]
        tc = t0 + move_s
        H, W = self.grip_pose(grip, tc)
        back, _ = self.back_from(grip, tc)
        self.transit(side, t0, tc, W, via=[W + back * PRE_MM], fade=(H, 1.0))
        self.hold(side, tc, tc + CLOSE_S, H, W)
        self.fingers(side, tc - 0.15, open_like(self.hand, g["q"], 0.5))
        self.fingers(side, tc, open_like(self.hand, g["q"], 0.15))
        self.fingers(side, tc + CLOSE_S, g["q"])
        self.effort(side, tc + CLOSE_S, 0.0, grip)
        self.effort(side, tc + CLOSE_S + 0.25, 0.3, grip)
        return tc + CLOSE_S

    def press_beam(self, t0, t1):
        """The left hand's push holding the beam's end on the rim: sight, then touch, keep its end where the rod clears
        the wall (the left hand put it 4-7 mm out, and the rod stood on the rim), and its turn upright."""
        self.event("press", t0, t1, side="L", normal=[0.0, 0.0, 1.0], force=BEAM_N, contact="part", at="cal6_beam",
                   upright="insp_cal6", obj="insp_cal6", point=[BEAM_END, 9.75, 4.25], square_to="part",
                   square_R=self.part[1].tolist(), square_p=self.part[0].tolist(), seat=True)

    # --- the verbs ------------------------------------------------------------------------------------------------
    def fetch(self):
        """The left hand reaches for the calipers where they lie, takes the beam by its end as it holds them on end, and
        lifts them."""
        t0 = self.t
        _, Wg = self.grip_pose("beam", t0)                 # the mirrored world
        self.look(t0, self.cal_point(BEAM_GRIP))
        # ready in front of the body, over the bench's edge toward them (toward the middle is -x, mirrored)
        # its reach 0.4 s, widest as it comes to rest, opening over its last 0.2 s: it measures from a little before it
        # leaves the still, 0.08 s, to when it has closed, and the carry with it (the body's fingers close 13-28 mm over
        # the beam's edges, where the grip's skin closes on them), and the body's fingers close a frame ahead of the
        # plan's: planned widest 0.035 s before it came to rest, it was widest 71% of the way (people's 71-77). Opened,
        # its fingers reach 2-5 mm below the bench under it (closed, 4.8 mm over it): it comes to rest 6 mm over the grip
        tg = self.reach("L", "beam", t0, ready=Wg + [-130, -120, 110], approach=Wg + [0, -10, 55], opened=0.5,
                        lead=0.0, reach_s=0.4, above=6.0, open_s=0.2)
        self.effort("L", tg, 0.0, "beam")
        self.effort("L", tg + 0.25, 0.3, "beam")
        p0, R0 = self.cal0
        # held PRESS_MM into the bench as the carry closes on them, and lifted PRELOAD_S after the grip has closed, the
        # hand releasing its press into them as the carry eases in (CAL_EASE_S)
        self.t_lift = tg + PRELOAD_S
        self.move_cal(tg, tg + 0.1, R0, p0 - [0, 0, PRESS_MM])
        self.move_cal(self.t_lift, self.t_lift + TAKE_S, R0, p0 + [0, 0, TAKE_MM])
        self.move_cal(self.t_lift + TAKE_S, self.t_lift + LIFT_S, R0, p0 + [0, 0, 30])
        self.t_beam, self.t = tg, self.t_lift + LIFT_S
        self.clip("fetch", t0, self.t, "FETCH  the calipers in the left hand, by the beam")

    def stand(self):
        """The left stands them on end and sets the beam's end down on the rim; the right takes the slider, and the
        left lets go of them and takes them again as it holds them on end (`hold`)."""
        p, R = self.standing()
        t0 = self.t
        self.look(t0, p + R @ [BEAM_END, 9.75, 4.0])
        Pb, Rb = self.beside()
        self.move_cal(t0, t0 + 1.2, Rb, Pb)                             # stood on end where they were lifted
        self.move_cal(t0 + 1.2, t0 + 2.5, R, p + [0, 0, ABOVE_MM])      # over the rim, a moment there
        self.move_cal(t0 + 2.8, t0 + 3.6, R, p)
        self.t_touch = t0 + 3.6
        # the right hand up from the thigh, still a moment, then onto the slider, as the pickups reach (BenchPlan.reach):
        # run on from the thigh in one, its moves were three of a second each, against the card's footage's 0.32-0.67 s
        _, Ws = self.grip_pose("slider", self.t_touch)
        tS = self.reach("R", "slider", self.t_touch + SLIDER_AFTER_S - (RISE_S + STILL_S + REACH_S + CLOSE_S),
                        ready=Ws + [60, -150, 60], approach=Ws + [0, -10, 45], opened=0.6)
        self.effort("R", tS, 0.0, "slider")
        self.effort("R", tS + 0.2, 0.3, "slider")
        self.t_slider = tS
        self.clip("stand", t0, tS + 0.3, "STAND  the calipers on end on the rim, the right hand on the slider")
        # the right holding them by the slider, the beam's end on the rim, the left lets go and takes them again
        t_rel = tS + 0.3
        self.press_beam(self.t_touch, t_rel)
        # opening first, and up as it goes back: straight back along its forearm, its fingers still round the beam's
        # edge, it caught the part's ear, was 68 mm off its plan and threw the calipers 8 mm up
        self.let_go("beam", self.t_beam, t_rel, lifted=self.t_beam, relax=None, wait=0.15, away=(0.0, 0.0, 30.0))
        self.look(t_rel, p + R @ HOLD_GRIP)
        self.t_hold = self.retake("hold", t_rel + 0.65)
        self.t = self.t_hold + 0.3
        self.clip("hold", t_rel, self.t, "HOLD  the left hand takes the calipers again, to hold them upright")

    def measure(self, depth):
        """The slider down until the rod meets the floor, a light push to seat it, the reading, the slider back up; the
        right hand lets go and goes."""
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
        self.press_beam(self.t_hold, t_shut)
        self.event("press", t_seat - 0.3, t_lift, side="R", normal=[0.0, 0.0, 1.0], force=SEAT_N, contact="part",
                   at="cal6_rod")
        # read while the hand holds still: the body's plan starts the slider back up a little before t_lift, and 0.13
        # s before it the reading moved 0.026 mm
        self.read = [t_read, t_lift - 0.4]
        self.move("insp_cal6_slider", t_lift, t_shut, R, p - down * SHUT_MM)  # the slider back up: closed
        # by a push of the thumb: the arm placed alone, it lagged under the drag and closed them 1.3 mm of 17
        self.event("press", t_lift, t_shut, side="R", normal=list(down), force=LIFT_N, contact="insp_cal6",
                   at="cal6_slider")
        t_off = t_shut + 0.2
        # held firmly, as a thumb on a roller holds it: held loosely, the hand turned about its pinch as it rose and
        # left the slider, 2 N of drag on it, where it was
        # relaxing all the way down to the thigh: relaxed by the bench's edge, it went down still, and the right hand's
        # five moves were widest a median 0.77 of the way through them (the card's footage's 0.5)
        W = self.let_go("slider", self.t_slider, t_off, relax=2.0)
        # back past the bench's edge, a moment, then down to the thigh: in one, a second's move
        self.transit("R", t_off + 0.6, t_off + 1.2, W + [0, -230, 60])
        self.transit("R", t_off + 1.2, t_off + 1.4, W + [0, -230, 60])
        self.transit("R", t_off + 1.4, t_off + 2.0, self.rest)
        self.t = t_off
        self.clip("measure", t0, self.t, "MEASURE  the rod down to the pocket's floor, read, closed again")

    def lay_back(self):
        """The left lifts them off the rim, turns them back and lays them where they lay, lets go and goes."""
        p, R = self.standing()
        p0, R0 = self.cal0
        t0 = self.t
        self.look(t0 + 0.4, p0)
        Pb, Rb = self.beside()
        self.move_cal(t0 + 0.4, t0 + 1.0, R, p + [0, 0, ABOVE_MM])              # off the rim
        self.move_cal(t0 + 1.0, t0 + 2.2, Rb, Pb)                               # back over where they lay, on end
        # set down end first, tilted END_FIRST_DEG that way, and let go there to settle onto the slider's block: held
        # by the beam's end, the slider's side hangs 2-3 deg low, and coming down on the block first, the beam rocking
        # onto its end, the bench dragged the slider 0.7-1 mm open
        Re = Rotation.from_rotvec([0.0, -np.radians(END_FIRST_DEG), 0.0]).as_matrix() @ R0
        # turned back and set down briskly: the hand on end lays them flat with the forearm at the end of people's turn,
        # under their weight 4-6 deg past it, for 1.3 s at 1.2 s and 0.6 s
        self.move_cal(t0 + 2.2, t0 + 3.2, Re, p0 + [0, 0, 30])                  # turned back
        t_down = t0 + 3.6
        self.move_cal(t0 + 3.2, t_down, Re, p0 + [0, 0, 8.0])
        t_off = t_down + 0.1
        W = self.let_go("hold", self.t_hold, t_off, w=lambda t: LAY_W if t >= t0 + 2.2 else 3.0)   # from turning back
        # up off them, then past the bench's edge: drawn straight back toward the body, the shoulder turned 43 deg
        # (people's 31)
        self.transit("L", t_off + 0.7, t_off + 1.85, self.rest, via=[W + [0, 0, 80], W + [0, -230, 60]])
        self.t = t_off + 1.85
        self.clip("lay back", t0, self.t, "LAY BACK  the calipers, closed, where they lay")

    def compose(self, depth: float):
        self.t = 0.5
        self.fetch()
        self.stand()
        self.measure(depth)
        self.lay_back()


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
