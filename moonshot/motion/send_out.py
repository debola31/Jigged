"""A part's "Send it out" step (ct-slbeam's for black oxide, ll-1007223's for zinc), planned as a take at the
outside-process rack (moonshot/world/outproc_cell.py; plan §5.4).

The part was set down on the rack's coating shelf when it was brought from the bench, beside the kraft bag the vendor's
tag hangs on. The right hand picks it up by what stands up from it, pinched from above, the thumb toward the operator
(outproc_cell.SEND_OUT), lifts it over the bag's rim, carries it over and sets it down inside on the bag's floor, lets
go and goes. The bag stands open on its own and nothing holds it: the part is set in, not dropped. The left hand
stays at the operator's side.

    python -m moonshot.motion.send_out ct-slbeam     # -> <data root>/takes/ct-slbeam-send-out: reference.npz, take.json
"""
from __future__ import annotations

import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import (CARRY_EASE_S, PRELOAD_S, TAKE_MM, TAKE_S, BenchPlan, bands, box, oriented_box,
                                   settle)
from moonshot.motion.primitives import FPS, open_like
from moonshot.motion.step_take import HANGING
from moonshot.world import outproc_cell as OC

TAKES = data_root() / "takes"
LUMBAR = np.array([-60.0, -575.0, 955.0])   # standing at the rack's front, as at the bench: 270 mm behind the shelf's
                                            # front edge, the coating shelf's work in front of the belly
OVER_RIM_MM = 25.0          # carried over the bag, the part's underside this far over its rim
IN_FROM_NEAR_MM = 38.0      # set in, the part's near side this far from the bag's near wall: the thumb is behind it
LOWER_S, SET_S = 0.8, 0.5   # down into the bag to 15 mm over its floor, then the last 15 mm onto it, slower
GRIP_EFFORT = 0.4           # the pinch's effort while it carries the part (the deburring tool's 0.3 for 50 g)


def loose(part: str) -> str:
    spec = OC.SEND_OUT[part]
    return OC.bag_body(OC.bag_at()) + OC.part_body(spec, OC.part_at(spec))


def out_dir(part: str):
    return TAKES / f"{part}-send-out"


class SendOutPlan(BenchPlan):
    lumbar = LUMBAR
    # the grip weighs people's posture at 3, and its pads x3 to keep contact, as the deburring tool's grip does
    grip_weights = (3.0, 3.0)
    solver_w = {"range": 3.5}

    def __init__(self, part: str, out=None, verbose=True):
        self.spec = OC.SEND_OUT[part]
        super().__init__(out or out_dir(part), verbose)
        rest = self.rests = settle(loose(part), cell=OC)
        self.part, self.bag0 = rest["part"], rest["bag"]
        self.paths["part"] = [(0.0, self.part[1], self.part[0])]
        self.solve_grips(self.grip_specs(), rest)

    # --- the scene, as the plan sees it -------------------------------------------------------------------------
    def obstacles(self):
        lo, hi = (np.array(v, float) for v in OC.record()["rack"]["shelves_mm"]["coating"])
        return [((lo + hi) / 2, (hi - lo) / 2)]

    def part_colliders(self, grow=0.0):
        p, R = self.part
        return [oriented_box(p + R @ ((np.array(lo) + hi) / 2), R, (np.array(hi) - lo) / 2 + grow)
                for lo, hi in self.spec.boxes.values()]

    def bag_box(self, grow=0.0):
        """The bag's outside as one box, for a grip near it to keep off."""
        p, R = self.bag0
        b = OC.record()["bag"]
        (ix, iy), h, w = b["inside_mm"], b["height_mm"], b["wall_mm"]
        half = np.array([ix / 2 + w, iy / 2 + w, h / 2]) + grow
        return oriented_box(p + R @ [0.0, 0.0, h / 2], R, half)

    def in_bag(self) -> np.ndarray:
        """Where the part's STEP origin is set down in the bag: across it in the middle, its near side
        IN_FROM_NEAR_MM from the near wall, 0.3 mm over the floor."""
        p, R = self.bag0
        lo_in, hi_in = OC.bag_inside()
        lo, hi = self.spec.world_extent()
        x = (lo_in[0] + hi_in[0]) / 2 - (lo[0] + hi[0]) / 2
        y = lo_in[1] + IN_FROM_NEAR_MM - lo[1]
        z = lo_in[2] - lo[2] + 0.3
        return p + R @ np.array([x, y, z])

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        P = self.spec
        lo, hi = (np.array(v, float) for v in OC.record()["rack"]["shelves_mm"]["coating"])
        thumb, fing = self.to_world(P.thumb_at), self.to_world(P.finger_at)
        n = self.to_world(P.thumb_n, vec=True)           # out of the thumb's face, toward the operator
        a, b = P.spread
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=50, middle_mcp_flex=50, middle_pip=55, ring_mcp_flex=60, ring_pip=70,
                  little_mcp_flex=65, little_pip=75, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=15, thumb_ip=10)
        # each pad on its face, not pressed into it (carried, the part leaves the skin); along the face as the fingers
        # lie, the index and middle either side of the middle of theirs, each level with the thumb
        on = lambda c, nn, x: G.plane_target(c, nn, 0.5, bands(c, x=x, z=(-3, 3)))   # noqa: E731
        return {"part": dict(of="part", obj=thumb, q0=q0, iters=1000, load=P.kg,
                             colliders=self.part_colliders() + [box((lo + hi) / 2, (hi - lo) / 2), self.bag_box(5.0)],
                             targets={"thumb": on(thumb, n, (-4, 4)), "index": on(fing, -n, (-b, -a)),
                                      "middle": on(fing, -n, (a, b))},
                             starts=[S(20, 0, r, 45, 45, sr, 75, p, 0, 0) for p in (30, 60) for sr in (-35, -10)
                                     for r in (0, 15)])}

    # --- the verbs ------------------------------------------------------------------------------------------------
    def pick_up(self):
        """Up from the thigh, onto the part from above, closing on it, then lifting it off the shelf: first taking its
        weight, then up over the bag's rim."""
        t0 = self.t
        _, Wg = self.grip_pose("part", t0)
        p0, R0 = self.part[0], self.part[1]
        lo, hi = self.spec.world_extent()
        self.look(t0, p0 + R0 @ np.zeros(3) + (lo + hi) / 2)
        # ready in front of the shelf's edge, high enough that the hanging fingers clear it, and onto the part from
        # above as the deburring tool is taken off the bench
        tg = self.reach("R", "part", t0, ready=Wg + [0, -170, 140], approach=Wg + [0, -30, 45], opened=0.8, lead=0.09,
                        above=5.0)
        self.effort("R", tg, 0.0, "part")
        self.effort("R", tg + 0.25, GRIP_EFFORT, "part")
        self.t_grab = tg
        self.t_lift = tg + PRELOAD_S
        rim = self.bag0[0][2] + OC.record()["bag"]["height_mm"]
        up = rim + OVER_RIM_MM - (p0[2] + lo[2])
        self.move("part", self.t_lift, self.t_lift + TAKE_S, R0, p0 + [0, 0, TAKE_MM])
        self.move("part", self.t_lift + TAKE_S, self.t_lift + TAKE_S + 0.8, R0, p0 + [0, 0, up])
        self.fingers("R", tg + 0.5, self.grips["part"]["q"])
        self.t = self.t_lift + TAKE_S + 0.8
        self.clip("pick up", t0, self.t, "PICK UP  the part off the shelf")

    def into_bag(self):
        """Over the bag, down into it and onto its floor; let go, up out of it and back to the side."""
        t0 = self.t
        g = self.grips["part"]
        R0, p_up = self.part[1], self.paths["part"][-1][2]
        p_in = self.in_bag()
        over = np.array([p_in[0], p_in[1], p_up[2]])
        self.look(t0, p_in)
        self.move("part", t0, t0 + 0.9, R0, over)
        t1 = t0 + 0.9 + 0.1
        self.move("part", t1, t1 + LOWER_S, R0, p_in + [0, 0, 15.0])
        t_down = t1 + LOWER_S + SET_S
        self.move("part", t1 + LOWER_S, t_down, R0, p_in)
        self.carry("part", self.t_grab, t_down + 0.05)
        self.effort("R", t_down - 0.1, GRIP_EFFORT, "part")
        self.effort("R", t_down + 0.05, 0.0, "part")
        self.event("grip", self.t_grab, t_down + 0.15, side="R", grip="part", on="part")
        self.event("carry", self.t_lift, t_down + 0.05, obj="part", grip="part", ease_in=CARRY_EASE_S)
        self.fingers("R", t_down + 0.05, g["q"])
        self.fingers("R", t_down + 0.4, open_like(self.hand, g["q"], 0.5))
        _, W = self.grip_pose("part", t_down)
        self.wrist["R"] = W
        # straight up out of the bag first, clear of its rim, then back past the shelf's edge and down to the side
        self.transit("R", t_down + 0.1, t_down + 0.7, W + [0, -15, 95], via=[W + [0, 0, 25]])
        self.fingers("R", t_down + 1.4, self.q_relax)
        self.transit("R", t_down + 0.7, t_down + 1.8, self.rest, via=[W + [0, -230, 80]])
        self.t = t_down + 1.8
        self.t_down = t_down
        self.clip("bag", t0, self.t, "BAG  the part, set into its tagged bag on the coating shelf")

    def compose(self):
        self.t = 0.5
        self.pick_up()
        self.into_bag()

    def theta0(self, n) -> np.ndarray:
        """The body solve's start: the right arm as its grip holds it while it has a task, hanging relaxed before and
        after; the left arm hanging throughout, as it has no task."""
        r = self.grips["part"]["theta"]
        th = np.tile(np.r_[r[:12], HANGING], (n, 1))
        first = min(x[0] for x in self.cons["R"])
        last = max(x[1] for x in self.cons["R"])
        for k in range(n):
            if not first <= k / FPS < last:
                th[k, 3:12] = HANGING
        return th


def build(part: str, solve=True, verbose=True, out=None) -> SendOutPlan:
    plan = SendOutPlan(part, out=out, verbose=verbose)
    plan.compose()
    if solve:
        plan.solve()
        plan.save({"part": part, "part_at": plan.part[0].tolist(), "bag_at": plan.bag0[0].tolist(),
                   "in_bag": plan.in_bag().tolist(), "t_down": plan.t_down, "loose": loose(part)})
    return plan


if __name__ == "__main__":
    build(sys.argv[1], out=sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None)
