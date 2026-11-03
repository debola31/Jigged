"""nist-ftc-10's step 70, "Check the pocket depth", planned as a two-handed take at the inspection bench (plan §5.4).

The finished part lies pocket side up on the bench and the left hand holds it down on its wide rim. The right picks the
6 in calipers up by the slider as a phone is held, palm on its back, thumb on the roller and fingertips on its other
edge, stands them on end beside the pocket, the display toward the eyes, and sets the beam's end on the near rim
with the depth rod over the pocket. Then, as the maker's manual has it (Mitutoyo 99MAD027A §10), the slider comes down while the beam
stays on the face, so the rod runs down the pocket's near wall to its floor; a light push seats it there and the
calipers are read. Lifting the slider again lets the beam slide back down onto its jaws, closed, under its own weight
(the slider's friction, bench_cell.CAL, is less than the beam's), and the calipers go back where they lay.

The calipers lie on their face where the station keeps them, so the grip that picks them up off the bench is the one
that holds them on end with the display in view: lying face up, the hand can only take them by the face it then has
to read, and held that way on end the arm is raised past the shoulder, elbow up (the first plan, 2026-11-02).

    python -m moonshot.motion.inspect        # -> <data root>/takes/nist-ftc-10-inspect: reference.npz, take.json
"""
from __future__ import annotations

import numpy as np

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import PART_AT, REST, BenchPlan, bands, bench_box, box, oriented_box, settle
from moonshot.motion.primitives import open_like
from moonshot.world import bench_cell as BC

OUT = data_root() / "takes" / "nist-ftc-10-inspect"
CAL_YAW = 0.0               # the station's: beam along X, jaws to the left; face down, the roller faces the operator
SEAT_N = 2.0                 # the push that seats the rod on the floor (proposed: light, as the manual asks)
OVERTRAVEL = 0.3             # the slider is planned this far past the floor; the rod stops it
ROD_FROM_WALL = 2.6          # the rod's near face this far past the pocket's near wall (mm): clear of the floor's
                             # 2 mm fillet, which would read short
STAND_YAW_DEG = 30.0         # on end, the display turned this far from facing the operator, toward their right: facing
                             # them, the hand on the back took the wrist to its cap and still left the beam 20 deg off
                             # upright (the plan of 2026-11-02)
BEAM_END = BC.CAL["beam"][1][0]


def loose() -> str:
    return BC.mat_body(PART_AT) + BC.part_body(PART_AT) + BC.caliper_body(BC.rest_mm("cal6"), CAL_YAW, face_down=True)


class InspectPlan(BenchPlan):
    def __init__(self, out=OUT, verbose=True):
        super().__init__(out, verbose)
        rest = settle(loose(), skip=("cal6",))
        self.part, self.cal0 = rest["part"], rest["insp_cal6"]
        self.paths["insp_cal6_slider"] = [(0.0, self.cal0[1], self.cal0[0])]
        self.solve_grips(self.grip_specs(), rest | {"insp_cal6_slider": self.cal0})

    def cal_point(self, p_asset, pose=None):
        p, R = pose or self.cal0
        return p + R @ np.asarray(p_asset, float)

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        bc, bh = bench_box()
        p0, R0 = self.cal0
        C = BC.CAL
        cols = [oriented_box(self.cal_point((np.array(lo) + hi) / 2), R0, (np.array(hi) - lo) / 2)
                for lo, hi in (C[k] for k in ("beam", "jaw_out", "jaw_in", "slider", "slider_bulge", "mjaw_out"))]
        ro = C["roller"]
        ra = self.cal_point(ro["at"])
        cols.append(lambda p: G.sdf_cyl(p, ra - R0[:, 1] * ro["half"], ra + R0[:, 1] * ro["half"], ro["r"]))
        cols.append(box(bc, bh))
        # a phone's grip: the palm on the back (up, lying face down), the thumb on the roller's end, the index and
        # middle fingertips side by side on the slider's other edge, at the buttons' bulge: the fingers reach across
        # it away from the operator, so the index is the left of the two
        thumb_at = self.cal_point([ro["at"][0], ro["at"][1] + ro["half"], ro["at"][2]])
        bulge = self.cal_point([np.mean([C["slider_bulge"][0][0], C["slider_bulge"][1][0]]), C["slider_bulge"][0][1], 6.0])
        edge = -R0[:, 1]                                   # the slider's far edge faces this way
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=55, middle_mcp_flex=45, middle_pip=55, ring_mcp_flex=55, ring_pip=65,
                  little_mcp_flex=60, little_pip=70, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=20, thumb_ip=15)
        return {"cal": dict(of="insp_cal6_slider", obj=p0, q0=q0, iters=1000, colliders=cols, targets={
                    "thumb": G.plane_target(thumb_at, R0[:, 1], 2.0, bands(thumb_at, x=(-3, 3), z=(-3, 3))),
                    "index": G.plane_target(bulge, edge, 2.0, bands(bulge, x=(-8, -2), z=(-4, 4))),
                    "middle": G.plane_target(bulge, edge, 2.0, bands(bulge, x=(2, 8), z=(-4, 4)))},
                    starts=[S(20, 0, r, pl, 45, 0, 70, p, 0, 0) for p in (70, 90) for r in (-15, 0) for pl in (75, 95)]),
                "steady": self.steady_spec()}

    # --- the calipers on end beside the pocket ---------------------------------------------------------------------
    def standing(self):
        """The beam's pose standing on the near rim: its end down on datum A, the display toward the operator turned
        STAND_YAW_DEG about the rod, the rod's near face ROD_FROM_WALL past the pocket's near wall, halfway along it."""
        R = np.stack([[0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0]], 1)   # asset x down, y right, z toward the eyes
        wall = self.to_world([np.mean(BC.POCKET["x"]), 0.0, BC.POCKET["z"][1]])  # datum A at the near wall's top
        rod_z_face = BC.CAL["rod"][1][2]                                         # the rod's face nearest the wall
        rod_y_mid = np.mean([BC.CAL["rod"][0][1], BC.CAL["rod"][1][1]])
        rod_mid = np.mean(BC.CAL["rod"], axis=0)
        p = wall - R @ np.array([BEAM_END, rod_y_mid, rod_z_face])              # rod centred on the wall's middle, at A
        p = p + np.array([0.0, ROD_FROM_WALL, 0.0])                             # its face that far into the pocket
        a = np.radians(STAND_YAW_DEG)
        Rz = np.array([[np.cos(a), -np.sin(a), 0.0], [np.sin(a), np.cos(a), 0.0], [0.0, 0.0, 1.0]])
        pivot = p + R @ np.array([BEAM_END, rod_mid[1], rod_mid[2]])             # the rod's end: it stays put
        return Rz @ R, pivot + Rz @ (p - pivot)

    # --- the verbs ------------------------------------------------------------------------------------------------
    def pick_up(self):
        t0 = self.t
        g = self.grips["cal"]
        Hg, Wg = self.grip_pose("cal", t0)
        tc = t0 + 1.3
        self.look(t0, self.cal_point([-60.0, 10.0, 0.0]))
        self.transit("R", t0, tc, Wg, via=[self.wrist["R"] + [-60, 80, 150], Wg + [15, -10, 55]], fade=(Hg, 1.0))
        self.fingers("R", t0 + 0.3, self.q_relax)
        self.fingers("R", t0 + 0.95, open_like(self.hand, g["q"], 0.7))
        self.fingers("R", tc, g["q"])
        self.effort("R", tc, 0.0, "cal")
        self.effort("R", tc + 0.25, 0.3, "cal")
        p0, R0 = self.cal0
        self.move("insp_cal6_slider", tc + 0.3, tc + 0.7, R0, p0 + [0, 0, 30])
        self.t_grab, self.t = tc, tc + 0.7
        self.clip("pick up", t0, self.t, "PICK UP  the calipers by the slider, as a phone is held")

    def measure(self, depth):
        """Stand the calipers on the rim, run the rod down to the floor, read, and lift the slider back."""
        R, p = self.standing()
        down = np.array([0.0, 0.0, -1.0])
        t0 = self.t
        wall = self.to_world([np.mean(BC.POCKET["x"]), 0.0, BC.POCKET["z"][1]])
        self.look(t0, wall)
        self.move("insp_cal6_slider", t0, t0 + 1.6, R, p - down * 40)              # on end, over the spot
        self.move("insp_cal6_slider", t0 + 1.6, t0 + 2.2, R, p)                     # the beam's end onto datum A
        t_on = t0 + 2.3
        s_end = depth + OVERTRAVEL
        t_seat = t_on + 0.15 + 0.4 + s_end / 12.0                                   # the slider down at 12 mm/s
        self.move("insp_cal6_slider", t_on + 0.15, t_seat, R, p + down * s_end)
        self.look(t_on, wall + np.array([0.0, 0.0, -depth / 2]))
        t_read = t_seat + 0.3
        self.look(t_seat, self.cal_point([-80.0, 10.0, 12.5], (p, R)))              # the display
        t_lift = t_read + 1.6
        self.event("press", t_seat - 0.3, t_lift, side="R", normal=[0.0, 0.0, 1.0], force=SEAT_N, contact="part",
                   at="cal6_rod")
        self.read = [t_read, t_lift - 0.1]
        self.move("insp_cal6_slider", t_lift, t_lift + 0.4 + s_end / 25.0, R, p)    # the slider back up: closing
        t_up = t_lift + 0.4 + s_end / 25.0
        self.move("insp_cal6_slider", t_up + 0.1, t_up + 0.7, R, p - down * 40)     # and the calipers off the part
        self.t = t_up + 0.7
        self.clip("measure", t0, self.t, "MEASURE  the beam's end on the face, the rod down to the pocket's floor, read")

    def put_back(self):
        t0 = self.t
        p0, R0 = self.cal0
        g = self.grips["cal"]
        self.look(t0, p0)
        self.move("insp_cal6_slider", t0, t0 + 1.4, R0, p0 + [0, 0, 30])
        t_down = t0 + 1.9
        self.move("insp_cal6_slider", t0 + 1.4, t_down, R0, p0 + [0, 0, 0.3])
        self.carry("cal", self.t_grab, t_down + 0.05)
        _, W = self.grip_pose("cal", t_down)
        self.effort("R", t_down - 0.1, 0.3, "cal")
        self.effort("R", t_down + 0.05, 0.0, "cal")
        self.event("grip", self.t_grab, t_down + 0.15, side="R", grip="cal", on="insp_cal6_slider")
        self.event("carry", self.t_grab + 0.15, t_down + 0.05, obj="insp_cal6_slider", grip="cal")
        self.fingers("R", t_down + 0.05, g["q"])
        self.fingers("R", t_down + 0.4, open_like(self.hand, g["q"], 0.5))
        self.wrist["R"] = W
        self.transit("R", t_down + 0.1, t_down + 0.6, W + [20, -25, 55], via=[W + [0, 0, 20]])
        self.fingers("R", t_down + 1.3, self.q_relax)
        self.transit("R", t_down + 0.6, t_down + 1.8, REST, via=[W + [0, -230, 60]])   # back past the bench's edge first
        self.t = t_down + 1.8
        self.clip("put back", t0, self.t, "PUT BACK  the calipers, closed, where they lay")
        return t_down

    def compose(self, depth: float):
        self.t = 0.5
        self.pick_up()
        self.measure(depth)
        t_down = self.put_back()
        self.steady(0.3, t_down + 0.2)
        self.t = max(self.t, t_down + 1.8)


def pocket_depth_mm() -> float:
    """The pocket's depth as the part is modelled: its floor below datum A (bench_cell.POCKET, from the STEP)."""
    return BC.POCKET["depth"]


def build(solve=True, verbose=True) -> InspectPlan:
    plan = InspectPlan(verbose=verbose)
    plan.compose(pocket_depth_mm())
    if solve:
        plan.solve()
        plan.save({"read": plan.read, "part_at": PART_AT.tolist(), "cal_yaw": CAL_YAW, "loose": loose()})
    return plan


if __name__ == "__main__":
    build()
