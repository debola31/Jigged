"""nist-ftc-10's step 69, "Deburr every edge", planned as a two-handed take at the inspection bench (plan §5.4).

The finished part lies pocket side up on the bench. The left hand comes onto its wide rim, fingers flat, and holds it
down; the right picks the swivel deburring tool off the bench, draws its blade along the outer near top edge and
then the pocket's far edge, and puts it back. Two strokes stand for every edge: the caption says the rest.

A stroke draws the blade's tip along the edge against the face below it, 0.2 mm down, the tool leaning in from the
operator's side and trailing 20 deg behind the stroke, and presses it into that face (moonshot/sim/bench.py applies the
press and keeps the tip on its path by touch). Both edges' faces face the operator: the part's near side, and the
pocket's far wall. Pressed into the corner along its bisector, or down onto datum A, the round tip slid off one face
or the other: the placeholder blade is straight, where a swivel blade's hook straddles the edge. The part's edges are
named in its STEP's frame, which is its body's.

    python -m moonshot.motion.deburr          # -> <data root>/takes/nist-ftc-10-deburr: reference.npz, take.json
"""
from __future__ import annotations

import math

import numpy as np
import torch

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import PART_AT, REST, TOP, BenchPlan, bench_box, box, settle
from moonshot.motion.primitives import open_like
from moonshot.world import bench_cell as BC

OUT = data_root() / "takes" / "nist-ftc-10-deburr"
TOOL_AT, TOOL_YAW = np.array([190.0, -230.0, TOP + BC.DEBURR["handle_r"] + 0.1]), 90.0
STROKE_N = 2.0              # into the edge: a swivel blade breaks an edge under light pressure (proposed); at 4 N
                            # the part slid away from the steadying hand: the bench holds 0.4 x (5 + 5) N
TRAIL_DEG = 20.0            # the blade trails the hand along the stroke
TILT_DEG = 30.0             # the tool leans down at this toward the edge: at 45 the near edge, close to the body, took
                            # more wrist than the plan allows
BISECTOR = np.array([0.0, -1.0, 1.0]) / math.sqrt(2)      # both edges' outward bisector, the part's frame: up, toward +Z
FACE_OUT, DOWN = np.array([0.0, 0.0, 1.0]), np.array([0.0, 1.0, 0.0]) # the part's frame: out of the face each edge's tip
                                                                        # presses on (the operator's way), and down
BELOW_MM = 0.2              # the tip rides the face this far below the edge: its collider 0.01 mm from the edge line
INTO_MM = 0.5               # and is aimed this far into it, the face stopping it, as the vise take's pushes are: aimed
                            # at the face, a millimetre of lag left it short, the press unable to move the arm; 1.5 mm
                            # into the stiff face, it bounced
STROKES = [                 # (from, to) in the part's frame (mm), datum A at Y = 0
    ((-5.0, 0.0, 37.5), (-55.0, 0.0, 37.5)),               # the outer near top edge, toward the right
    ((12.0, 0.0, -25.0), (-50.0, 0.0, -25.0)),             # the pocket's far edge, toward the right
]
TIP = BC.DEBURR["handle_len"] + BC.DEBURR["blade_len"] - BC.DEBURR["blade_r"]   # the blade tip's centre, tool frame


def loose() -> str:
    return BC.mat_body(PART_AT) + BC.part_body(PART_AT) + BC.deburr_body(TOOL_AT, TOOL_YAW)


def on_cylinder(a, u, r, lo, hi, side=None, comp=2.0, w=1.0, side_w=30.0):
    """A pad on a cylinder (axis from a along u, radius r): sunk comp into it, facing its axis, between lo and hi
    along it, and, given side (a unit vector across the axis), on that side of it."""
    A, U = torch.as_tensor(np.asarray(a, float)), torch.as_tensor(np.asarray(u, float))
    S = None if side is None else torch.as_tensor(np.asarray(side, float))

    def f(c, n):
        rel = c - A
        t = rel @ U
        radial = rel - t * U
        dist = torch.linalg.norm(radial)
        out = (dist - (r - comp)) ** 2 + 20 * (1.0 + n @ (radial / dist)) ** 2
        out = out + 0.5 * (torch.relu(lo - t) ** 2 + torch.relu(t - hi) ** 2)
        if S is not None:
            out = out + side_w * (1.0 - (radial / dist) @ S) ** 2
        return w * out
    return f


class DeburrPlan(BenchPlan):
    def __init__(self, out=OUT, verbose=True):
        super().__init__(out, verbose)
        rest = settle(loose())
        self.part, self.tool0 = rest["part"], rest["deburr_tool"]
        self.paths["deburr_tool"] = [(0.0, self.tool0[1], self.tool0[0])]
        self.solve_grips(self.grip_specs(), rest)

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        h = self.hand
        bc, bh = bench_box()
        specs = {}
        # the tool off the bench: a pen grip near its front, thumb and middle on its sides, index on top
        p0, R0 = self.tool0
        ax = R0[:, 0]
        D = BC.DEBURR
        hand_cyl = lambda p: G.sdf_cyl(p, p0, p0 + ax * D["handle_len"], D["handle_r"])      # noqa: E731
        blade = lambda p: G.sdf_cyl(p, p0 + ax * D["handle_len"], p0 + ax * (D["handle_len"] + D["blade_len"]),  # noqa: E731
                                    D["blade_r"] + 2.0)
        q0 = h.neutral()
        q0.update(index_mcp_flex=35, index_pip=30, middle_mcp_flex=45, middle_pip=45, ring_mcp_flex=45, ring_pip=55,
                  little_mcp_flex=45, little_pip=55, thumb_cmc_abd=25, thumb_cmc_flex=5, thumb_mcp_flex=20, thumb_ip=15)
        # across the handle: up, and its upper flanks on the hand's left and right; lying on the bench, the handle's
        # sides are 7.6 mm off it, less than a thumb is thick, so the pads pinch it from 45 deg above. The bands along
        # it are wide: the fingers lie along the tool, so the middle reaches past the index
        left, up = R0[:, 1], R0[:, 2]
        upper_left, upper_right = (up + left) / math.sqrt(2), (up - left) / math.sqrt(2)
        on = lambda lo, hi, side: on_cylinder(p0, ax, D["handle_r"], lo, hi, side=side, side_w=10.0)  # noqa: E731
        specs["tool"] = dict(of="deburr_tool", obj=p0, q0=q0, iters=1000, colliders=[hand_cyl, blade, box(bc, bh)],
                             targets={"thumb": on(70, 115, upper_left), "index": on(85, 125, up),
                                      "middle": on(80, 125, upper_right)},
                             starts=[S(20, 0, r, 45, 45, -10, 75, p, 0, 0) for p in (55, 75, 90) for r in (0, 15)])
        specs["steady"] = self.steady_spec()
        return specs

    # --- the verbs ------------------------------------------------------------------------------------------------
    def stroke_pose(self, e, s):
        """The tool's pose (R, origin) with its blade tip on edge point e (world), the stroke going along s."""
        n = self.to_world(BISECTOR, vec=True)
        out = np.array([n[0], n[1], 0.0]) / np.linalg.norm(n[:2])          # the edge's outward side, level
        tilt, b = math.radians(TILT_DEG), math.radians(TRAIL_DEG)
        a = (-out * math.cos(tilt) - np.array([0.0, 0.0, 1.0]) * math.sin(tilt)) * math.cos(b) - s * math.sin(b)
        a /= np.linalg.norm(a)
        z = np.array([0.0, 0.0, 1.0]) - a * a[2]
        z /= np.linalg.norm(z)
        R = np.stack([a, np.cross(z, a), z], 1)
        tip = (e + self.to_world(FACE_OUT, vec=True) * (BC.DEBURR["blade_r"] - INTO_MM)
               + self.to_world(DOWN, vec=True) * BELOW_MM)
        return R, tip - a * TIP

    def pick_up(self):
        t0 = self.t
        g = self.grips["tool"]
        Hg, Wg = self.grip_pose("tool", t0)
        tc = t0 + 1.3
        self.look(t0, self.tool0[0] + self.tool0[1] @ [110, 0, 0])
        self.transit("R", t0, tc, Wg, via=[self.wrist["R"] + [40, 60, 130], Wg + [0, -10, 55]], fade=(Hg, 1.0))
        self.fingers("R", t0 + 0.3, self.q_relax)
        self.fingers("R", t0 + 0.95, open_like(self.hand, g["q"], 0.8))
        self.fingers("R", tc, g["q"])
        self.effort("R", tc, 0.0, "tool")
        self.effort("R", tc + 0.25, 0.3, "tool")
        self.t_grab = tc
        R0, p0 = self.tool0[1], self.tool0[0]
        self.move("deburr_tool", tc + 0.3, tc + 0.7, R0, p0 + [0, 0, 35])
        # off the bench, the free ring and little fingers curl into the palm, out of the part's way (left out, the
        # little finger brushed the part's ear and pushed it 5 mm)
        self.fingers("R", tc + 0.5, g["q"])
        self.fingers("R", tc + 1.0, curled(g["q"]))
        self.t = tc + 0.7
        self.clip("pick up", t0, self.t, "PICK UP  the deburring tool, held like a pen")

    def stroke(self, i, frm, to, approach=1.2):
        """Carry the tool over the edge, set the blade on it, draw it along, lift it off."""
        a, b = self.to_world(frm), self.to_world(to)
        s = (b - a) / np.linalg.norm(b - a)
        n = self.to_world(BISECTOR, vec=True)
        R, p_a = self.stroke_pose(a, s)
        _, p_b = self.stroke_pose(b, s)
        t0 = self.t
        out = self.to_world(FACE_OUT, vec=True)
        self.look(t0, a)
        self.move("deburr_tool", t0, t0 + approach, R, p_a + n * 25)
        # off the landing spot, a moment to see the blade onto it, then in slowly
        self.move("deburr_tool", t0 + approach, t0 + approach + 0.35, R, p_a + out * 6)
        tc = t0 + approach + 0.35 + 0.4 + 0.35
        self.move("deburr_tool", tc - 0.35, tc, R, p_a)
        dur = np.linalg.norm(b - a) / 40.0                     # 40 mm/s along the edge
        self.move("deburr_tool", tc + 0.1, tc + 0.1 + dur, R, p_b)
        t1 = tc + 0.1 + dur
        self.look(tc, (a + b) / 2)
        self.event("press", tc - 0.05, t1 + 0.05, side="R", normal=out.tolist(), force=STROKE_N,
                   contact="part", at="deburr_blade", obj="deburr_tool", point=[TIP, 0.0, 0.0])
        self.move("deburr_tool", t1 + 0.05, t1 + 0.4, R, p_b + n * 25)
        self.strokes.append({"edge_mm": [list(frm), list(to)], "t0": tc, "t1": t1, "force_N": STROKE_N})
        self.t = t1 + 0.4
        self.clip(f"stroke {i + 1}", t0, self.t, "DEBURR  the blade drawn along the edge, light and even")

    def put_back(self):
        t0 = self.t
        R0, p0 = self.tool0[1], self.tool0[0]
        g = self.grips["tool"]
        self.look(t0, p0)
        self.move("deburr_tool", t0, t0 + 1.1, R0, p0 + [0, 0, 30])
        t_down = t0 + 1.6
        self.move("deburr_tool", t0 + 1.1, t_down, R0, p0 + [0, 0, 0.3])
        self.fingers("R", t0 + 0.6, curled(g["q"]))
        self.fingers("R", t_down - 0.3, g["q"])                # uncurled again to set it down
        self.carry("tool", self.t_grab, t_down + 0.05, free=(self.t_grab + 0.7, t_down - 0.6), point=(TIP, 0.0, 0.0))
        _, W = self.grip_pose("tool", t_down)
        self.effort("R", t_down - 0.1, 0.3, "tool")
        self.effort("R", t_down + 0.05, 0.0, "tool")
        self.event("grip", self.t_grab, t_down + 0.15, side="R", grip="tool", on="deburr_tool")
        self.event("carry", self.t_grab + 0.15, t_down + 0.05, obj="deburr_tool", grip="tool")
        self.fingers("R", t_down + 0.05, g["q"])
        self.fingers("R", t_down + 0.4, open_like(self.hand, g["q"], 0.5))
        self.wrist["R"] = W
        self.transit("R", t_down + 0.1, t_down + 0.6, W + [0, -25, 55], via=[W + [0, 0, 20]])
        self.fingers("R", t_down + 1.3, self.q_relax)
        self.transit("R", t_down + 0.6, t_down + 1.7, REST, via=[W + [0, -230, 60]])   # back past the bench's edge first
        self.t = t_down + 1.7
        self.clip("put back", t0, self.t, "PUT BACK  the tool where it was")
        return t_down

    def compose(self):
        self.strokes = []
        self.t = 0.5
        self.pick_up()
        for i, (frm, to) in enumerate(STROKES):
            self.stroke(i, frm, to)
        t_down = self.put_back()
        self.steady(0.3, t_down + 0.2)
        self.t = max(self.t, t_down + 1.8)


def curled(q: dict) -> dict:
    """A grip with its free fingers, ring and little, curled into the palm."""
    return q | {"ring_mcp_flex": 75.0, "ring_pip": 90.0, "little_mcp_flex": 75.0, "little_pip": 90.0}


def build(solve=True, verbose=True) -> DeburrPlan:
    plan = DeburrPlan(verbose=verbose)
    plan.compose()
    if solve:
        plan.solve()
        plan.save({"strokes": plan.strokes, "part_at": PART_AT.tolist(), "tool_at": TOOL_AT.tolist(),
                   "tool_yaw": TOOL_YAW, "loose": loose()})
    return plan


if __name__ == "__main__":
    build()
