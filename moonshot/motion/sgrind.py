"""Takes at the surface grinder (plan §5.4), from its cards (moonshot/cards/sgrind-*.json), planned on the two-handed
bench planner by way of the band saw's (moonshot/motion/bandsaw.py SawPlan) in the grinder's cell
(moonshot/world/grind_cell.py), whose physics runs in moonshot/sim/sgrind.py. Each take is a setup's own
(moonshot/planning/takes.py GRINDER_TAKES, grind_takes): takes/<part>-<setup>-<take>, each starting from the grinder
and what is on its chuck as the take before left them (state.json, the station's frame).

Where the work sits (ct-tpg322's plan, op10 workholding.place): the insert near the chuck's right end, its first
flank against the back keeper flush with the chuck's back edge, the keepers in a pinwheel round it. Blocking it in and
switching the chuck on happen with the table run right (TABLE_LOAD_MM), where the CHUCK stance reaches the chuck's
right half and its lever; the grind happens with the insert's groove brought under the wheel.

- magnet-on: the chuck's lever taken by its ball and pushed up and over, let go past its middle, where the magnet's
  pull and the lever's weight carry it to its far stop (sgrind.json joints.chuck_lever: its detent, 8 N m at 45 deg).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bandsaw import SawPlan
from moonshot.motion.bench import bands, oriented_box
from moonshot.motion.primitives import min_jerk, open_like
from moonshot.world import grind_cell as GC
from moonshot.world import sgrind as SG

TAKES = data_root() / "takes"
TABLE_LOAD_MM = 355.0      # the table run right to load, near its stop: the insert before the CHUCK stance and the lever's
                           # pivot 627 mm right, so its push over the top ends 55 mm left of the body's middle (at 300
                           # it crossed the body, the trunk bent sideways past people's range; proposed)
INSERT_FROM_RIGHT_MM = 155.0   # the insert's middle this far in from the chuck's right end (proposed: in the right half,
                               # its pinwheel's keepers on the face)
HEAD_LOAD_MM = -183.0      # the head lowered from joint zero to load: the 6 in wheel's bottom 30.9 mm over the chuck,
                           # clear of the work by 27 mm, the insert 455 mm from it along the table
LEVER_PUSH_DEG = 108.0     # the lever pushed this far over, then let go: past its middle the magnet's detent and its
                           # weight carry it on (sgrind.json joints.chuck_lever)
LEVER_PUSH_S = 1.1         # ... over this long (proposed: at 0.9 s and 16 N the lever trailed its plan, 62 deg where the
                           # hand let go, and the detent took it back off)
LEVER_N = 20.0             # the push on the ball along its way round: the detent's 16 N at the ball, its friction's 3 and
                           # the lever's own weight from level, 5 (proposed)
IC, THICK, NOSE, CLEAR = 9.525, 3.175, 0.79375, 11.0     # ct-tpg322: 3/8 IC, 1/8 thick, 1/32 nose, 11 deg (P)


def station_mm(name: str) -> np.ndarray:
    """A record site or affordance at joint zero (the station's mm)."""
    r = SG.record()
    return np.array({**r["sites"], **r["affordances"]}[name]["at_mm"], float)


def chuck_shift(state: dict) -> np.ndarray:
    """How far the table and saddle have carried the chuck from joint zero (the station's mm)."""
    return np.array([state["q"]["table"] * 1000, state["q"]["saddle"] * 1000, 0.0])


def initial_state(part: str = "ct-tpg322") -> dict:
    """The grinder as the operator finds it before the setup: the table run right to load, the head lowered to just
    clear the work, everything idle and the chuck off; and, for a take that starts later in the chain before the ones
    before it exist, the insert blocked in by its keepers where the plan sets it."""
    r = SG.record()
    J = r["joints"]
    q = {j: 0.0 for j in SG.JOINT_OF.values()}
    q["table"] = TABLE_LOAD_MM / 1000
    q["table_handwheel"] = TABLE_LOAD_MM / (J["table_handwheel"]["travel_mm_per_turn"] / (2 * math.pi))
    q["wheelhead"] = HEAD_LOAD_MM / 1000
    q["downfeed_handwheel"] = -HEAD_LOAD_MM / (J["downfeed_handwheel"]["lead_mm"] / (2 * math.pi))
    return {"q": q, "control": {"state": "idle", "stop_in": False, "coolant_on": False}, "spindle_rad_s": 0.0,
            "held": blocked_in_poses(q)}


def insert_centre(q: dict) -> np.ndarray:
    """Where the insert's middle lies on the chuck (the station's mm, its underside on the face), the table and saddle
    at q: its first flank 12.7 mm in from the chuck's back edge (against the back keeper, flush with the edge)."""
    face = SG.record()["colliders"]["chuck_face"]
    x = face["box_max_mm"][0] - INSERT_FROM_RIGHT_MM
    y = face["box_max_mm"][1] - GC.KEEPER["size_mm"][1] - IC / 2
    return np.array([x + q["table"] * 1000, y + q["saddle"] * 1000, GC.chuck_top_mm()])


def blocked_in_poses(q: dict) -> dict:
    """The insert and its keepers as blocking in leaves them (grind_cell.grinder_state's held poses)."""
    c = insert_centre(q)
    out = {f"{GC.PREFIX}part": {"centre": c.tolist(), "R": Rotation.from_euler("z", 90.0, degrees=True).as_matrix()
                                .tolist()}}
    for i, (k, yaw) in enumerate(GC.pinwheel(c, 90.0, IC, gap_mm=0.0), 1):
        k = np.asarray(k, float) + [0.0, 0.0, GC.KEEPER["size_mm"][2] / 2]
        out[f"{GC.PREFIX}keeper_{i}"] = {"centre": k.tolist(),
                                         "R": Rotation.from_euler("z", yaw, degrees=True).as_matrix().tolist()}
    return out


def loose_of(state: dict, place) -> tuple[str, str]:
    """(mesh assets, loose bodies) for what the state has on the chuck, in the take's world."""
    held = state["held"]
    asset, part = "", ""
    for name, s in held.items():
        R = np.asarray(s["R"], float)
        yaw = math.degrees(math.atan2(R[1, 0], R[0, 0]))
        if name == f"{GC.PREFIX}part":
            asset, part = GC.part_body(place, GC.triangle_insert_mm(IC, THICK, NOSE, CLEAR), s["centre"], yaw)
        else:
            i = int(name.rsplit("_", 1)[1])
            c = np.asarray(s["centre"], float) - [0.0, 0.0, GC.KEEPER["size_mm"][2] / 2]
            part += GC.keeper_body(place, i, c, yaw)
    return asset, part


def grinder_box(place, state: dict, name: str, grow: float = 0.0):
    """A record box collider as an SDF in the take's world, where the state's table, saddle and head put its link."""
    r = SG.record()
    c = r["colliders"][name]
    link = c["link"]
    off = np.zeros(3)
    if link in ("saddle", "table", "chuck", "chuck_lever", "table_handwheel", "cross_handwheel"):
        off[1] = state["q"]["saddle"] * 1000
    if link in ("table", "chuck", "chuck_lever"):
        off[0] = state["q"]["table"] * 1000
    if link in ("wheelhead", "spindle"):
        off[2] = state["q"]["wheelhead"] * 1000
    lo, hi = np.array(c["box_min_mm"], float) + off, np.array(c["box_max_mm"], float) + off
    return oriented_box(place.world((lo + hi) / 2), place.R, (hi - lo) / 2 + grow)


def world_aabb(place, state: dict, name: str, grow: float = 0.0):
    """A record box collider as (centre, half size) in the take's world, for the body solver's obstacles."""
    r = SG.record()
    c = r["colliders"][name]
    off = np.zeros(3)
    if c["link"] in ("saddle", "table", "chuck"):
        off[1] = state["q"]["saddle"] * 1000
    if c["link"] in ("table", "chuck"):
        off[0] = state["q"]["table"] * 1000
    lo, hi = np.array(c["box_min_mm"], float) + off, np.array(c["box_max_mm"], float) + off
    corners = place.world(np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]))
    a, b = corners.min(0) - grow, corners.max(0) + grow
    return (a + b) / 2, (b - a) / 2


def on_ball(centre, radius, comp=1.5, w=1.0):
    """A pad on a ball's surface, facing its centre."""
    import torch
    C = torch.as_tensor(np.asarray(centre, float))

    def f(c, n):
        rel = c - C
        dist = torch.linalg.norm(rel)
        return w * ((dist - (radius - comp)) ** 2 + 20 * (1.0 + n @ (rel / dist)) ** 2)
    return f


class GrindPlan(SawPlan):
    """A take at the grinder: where the person stands (lumbar, in the station's frame), where the grinder is put, and
    the grinder's state it starts from."""
    place = GC.CHUCK
    lumbar_station = GC.CHUCK_LUMBAR
    card = "sgrind-controls"

    def __init__(self, out, state: dict, verbose: bool = True):
        super().__init__(out, state, verbose)

    def obstacles(self) -> list:
        return [world_aabb(self.place, self.state, n) for n in ("chuck_body", "table", "saddle_top", "controls_box")]

    def save_take(self, extra: dict) -> None:
        self.save({"card": self.card, "station": "sgrind",
                   "place": {"at_mm": list(self.place.at_mm), "yaw_deg": self.place.yaw_deg}} | extra)


def lever_pose(place, state: dict, turn_rad: float):
    """The chuck's lever body's pose (R, origin; the take's world) turned turn_rad past where the state has it. Its
    body's origin is its pivot, carried by the table and saddle."""
    J = SG.record()["joints"]["chuck_lever"]
    axis, at = np.array(J["axis"], float), np.array(J["at_mm"], float) + chuck_shift(state)
    R = Rotation.from_rotvec(axis * (state["q"]["chuck_lever"] + turn_rad)).as_matrix()
    return place.R @ R, place.world(at)


class MagnetOnPlan(GrindPlan):
    """Switch the chuck on (the card's phases 2-3): the right hand onto the lever's ball from above and behind, a power
    grip round it, then up and over toward the left, let go past the middle, the lever running on to its stop."""

    def __init__(self, state: dict, out: Path, verbose=True):
        super().__init__(out, state, verbose)
        self.q_lever = state["q"]["chuck_lever"]
        self.t_turn = None
        self.paths["sg_chuck_lever"] = [(0.0, *lever_pose(self.place, state, 0.0))]
        R, p = lever_pose(self.place, state, 0.0)
        self.solve_grips(self.grip_specs(), {"sg_chuck_lever": (p, R)})

    def obj_at(self, name, t):
        if name != "sg_chuck_lever" or self.t_turn is None:
            return super().obj_at(name, t)
        return lever_pose(self.place, self.state, math.radians(LEVER_PUSH_DEG) * min_jerk((t - self.t_turn) / LEVER_PUSH_S))

    def ball(self, t: float | None = None) -> np.ndarray:
        """The lever's ball's centre (world mm), as the plan turns it at t (where the take finds it if None)."""
        R, o = self.obj_at("sg_chuck_lever", 0.0 if t is None else t)
        R0, o0 = lever_pose(self.place, self.state, 0.0)
        b0 = self.place.world(station_mm("chuck_lever") + chuck_shift(self.state))
        return o + R @ (R0.T @ (b0 - o0))

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731
        h = self.hand
        c = self.ball()
        r = SG.record()["colliders"]["chuck_lever_ball"]["radius_mm"]
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 45.0, 55.0
        q0.update(thumb_cmc_abd=30.0, thumb_cmc_flex=20.0, thumb_mcp_flex=20.0, thumb_ip=15.0)
        on = on_ball(c, r)
        # taken from the front: the ball hangs 50 mm under the chuck's top, in front of its face, so a hand from above
        # came down onto the chuck and its keepers. The palm on its near side, the fingers over its top to its far
        # side, the thumb under it: a power sphere grip, as a hand takes a gear lever's knob to push it up and over
        far = lambda f: (lambda q, n: on(q, n) + f(q))               # noqa: E731
        specs = {"ball": dict(of="sg_chuck_lever", obj=c, q0=q0, iters=1200,
                              colliders=[lambda p: _sdf_sphere(p, c, r),
                                         grinder_box(self.place, self.state, "chuck_body")],
                              targets={"index": far(bands(c, y=(0, r), z=(r / 3, r))),
                                       "middle": far(bands(c, y=(0, r), z=(0, r / 2))),
                                       "ring": far(bands(c, y=(0, r), z=(-r / 2, r / 4))),
                                       "thumb": far(bands(c, y=(-r, 0), z=(-r, -r / 4)))},
                              starts=[S(f, 0, 0, pl, 40, r_, 45, p, -10, 0) for f in (10, 25) for pl in (55, 80)
                                      for r_ in (-10,) for p in (40, 75)])}
        return specs

    def compose(self):
        self.t = 0.4
        g = self.grips["ball"]
        c0 = self.ball()
        self.look(0.0, c0)
        _, Wg = self.grip_pose("ball", self.t)
        up, back = np.array([0, 0, 1.0]), np.array([0, -1.0, 0])
        # quick, as the card's footage: rising 1.3 s, the reach's segments ran 0.97 s at the median against the
        # footage's 0.32-0.67; but still a clear pause before the reach: paused 0.25 s, the rise and the reach read as
        # one 1.5 s reach. Widest 0.13 s before it rests, 74% of the reach (0.12 of 0.55 s was 79%)
        # the rise short and slow, from the thigh to a pause 250 mm short of the ball, and the reach the faster: the
        # grasp's timing finds the reach's peak speed before contact, and a rise faster than the reach (to 160 mm
        # short) put the reach's onset before the rise, 1.7 s
        tg = self.reach("R", "ball", self.t, ready=Wg + up * 20 + back * 250, approach=Wg + up * 10 + back * 45,
                        opened=0.7, lead=0.13, reach_s=0.5, rise_s=0.9, still_s=0.4)
        self.effort("R", tg, 0.0, "ball")
        self.effort("R", tg + 0.2, 0.4, "ball")
        self.t_turn = tg + 0.25
        t_off = self.t_turn + LEVER_PUSH_S
        self.carry("ball", tg, t_off)
        self.event("grip", tg, t_off + 0.1, side="R", grip="ball", on="sg_chuck_lever")
        self.event("carry", tg + 0.05, t_off, obj="sg_chuck_lever", grip="ball", side="R", skin=True)
        self.event("turn", self.t_turn, t_off, side="R", obj="sg_chuck_lever", joint="sg_chuck_lever",
                   knob="sg_chuck_lever_ball", force=LEVER_N, max_n=34.0, q0=self.q_lever,
                   turn_rad=math.radians(LEVER_PUSH_DEG))
        self.effort("R", t_off - 0.1, 0.4, "ball")
        self.effort("R", t_off + 0.05, 0.0, "ball")
        H, W = self.grip_pose("ball", t_off)
        # let go and drawn back up and toward the body, clear of the lever as it runs on to its stop
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.45)
        self.add("R", t_off, t_off + 0.45, lambda t: [("pose", H, W + (up * 60 + back * 80) * min_jerk((t - t_off) / 0.45),
                                                       3.0)])
        self.wrist["R"] = W + up * 60 + back * 80
        self.look(t_off, self.place.world(station_mm("chuck_centre") + chuck_shift(self.state)))
        self.clip("magnet", tg - 1.5, t_off + 0.8, "MAGNET ON  the chuck's lever over to on")
        self.to_rest("R", t_off + 0.45, t_off + 1.6)
        self.t = t_off + 2.2


def _sdf_sphere(p, c, r):
    import torch
    return torch.linalg.norm(p - torch.as_tensor(np.asarray(c, float)), dim=-1) - r


GROOVE_FROM_MIDDLE_MM = IC / 2 - 0.254 - SG.record()["wheels"]["dwheel-1a1r"]["width_mm"] / 2   # the wheel's mid-plane
                           # at the outer cross position: its side the land's .010 in inside the edge
ROCK_PASS = 15             # the pass a rock take shows (proposed: the video shows one cycle and cuts the rest; the
                           # groove near its depth, the next feed taking it to its last, 16)
ROCK_MM = (9.69 - 6.81) / 2    # the table rocked this far either way of the stroke's middle (the plan's 6.81-9.69 mm)
ROCK_STROKE_S = 0.7        # each stroke from one end to the other (proposed: the card's 0.8-2.0 s a stroke)
ROCK_CYCLES = 2
FEED_GRADUATIONS = 2.5     # a pass's down-feed: 0.0005 in at 0.0002 in a graduation
FEED_S = 0.8               # ... turned over this long (the card's 0.5-1.5 s)
KNOB_N = 6.0               # the push along a handwheel knob's way round (the card's 4-5 N, a little over for the stroke's
                           # starts and stops; proposed)


def grind_state(part: str, edge: int, k: int) -> dict:
    """The grinder grinding an edge at its k-th pass: the insert's groove under the wheel (the table at the stroke's
    middle, the saddle at the outer cross position), the wheel at that pass's floor, the chuck and the coolant on, the
    wheel at speed; the insert and its keepers as blocking in left them, carried there by the table and saddle."""
    s = initial_state(part)
    q, J = s["q"], SG.record()["joints"]
    c0 = insert_centre({"table": 0.0, "saddle": 0.0})
    q["table"] = -c0[0] / 1000
    q["saddle"] = -(c0[1] + GROOVE_FROM_MIDDLE_MM) / 1000
    floor = grind_floor_mm(part, edge, k)
    w = SG.record()["wheels"]["dwheel-1a1r"]
    bottom0 = J["spindle"]["at_mm"][2] - w["dia_mm"] / 2
    q["wheelhead"] = (GC.chuck_top_mm() + floor - bottom0) / 1000
    q["table_handwheel"] = q["table"] * 1000 / (J["table_handwheel"]["travel_mm_per_turn"] / (2 * math.pi))
    q["cross_handwheel"] = q["saddle"] * 1000 / (J["cross_handwheel"]["lead_mm"] / (2 * math.pi))
    q["downfeed_handwheel"] = -q["wheelhead"] * 1000 / (J["downfeed_handwheel"]["lead_mm"] / (2 * math.pi))
    q["chuck_lever"] = math.pi
    s["control"] = {"state": "running", "stop_in": False, "coolant_on": True}
    s["spindle_rad_s"] = SG.record()["spindle"]["rpm"] * 2 * math.pi / 60
    s["held"] = blocked_in_poses(q)
    s["pass"] = k
    return s


def grind_floor_mm(part: str, edge: int, k: int) -> float:
    """The groove's floor (the insert's z, mm) after the k-th down-feed of an edge, from the cut simulation's passes
    (takes/<part>-op10-edge<n>/grind.json), its top before the first."""
    g = json.loads((TAKES / f"{part}-op10-edge{edge}" / "grind.json").read_text(encoding="utf-8"))
    return float(g["stock_glbs"][str(k)]["floor_z_mm"]) if k > 0 else THICK


def handwheel_pose(place, state: dict, joint: str, turn_rad: float):
    """A handwheel body's pose (R, origin; the take's world) turned turn_rad past where the state has it; its origin
    on its axis, carried by the saddle if it is the saddle's."""
    J = SG.record()["joints"][joint]
    at = np.array(J["at_mm"], float) + (chuck_shift(state) * [0, 1, 0] if joint in ("table_handwheel",
                                                                                      "cross_handwheel") else 0.0)
    R = Rotation.from_rotvec(np.array(J["axis"], float) * (state["q"][joint] + turn_rad)).as_matrix()
    return place.R @ R, place.world(at)


class KnobTurnPlan(GrindPlan):
    """A handwheel turned by its spinner knob, the fist round the knob as round a suitcase handle and the knob spinning
    in it (as the band saw's handwheel, moonshot/motion/bandsaw.py ClampPlan), through a sequence of strokes."""
    joint, knob = "table_handwheel", "table_handwheel_knob"
    strokes_deg: list = []
    stroke_s = ROCK_STROKE_S
    caption = ""

    def __init__(self, state: dict, out: Path, verbose=True):
        super().__init__(out, state, verbose)
        self.t_turn = None
        self.paths[f"sg_{self.joint}"] = [(0.0, *handwheel_pose(self.place, state, self.joint, 0.0))]
        R, p = handwheel_pose(self.place, state, self.joint, 0.0)
        self.solve_grips(self.grip_specs(), {f"sg_{self.joint}": (p, R)})

    def turned(self, t: float) -> float:
        """The handwheel's turn (rad) from where the take finds it, at t: each stroke a min-jerk turn."""
        if self.t_turn is None or t <= self.t_turn:
            return 0.0
        a, t0 = 0.0, self.t_turn
        for deg in self.strokes_deg:
            x = (t - t0) / self.stroke_s
            if x < 1.0:
                return a + math.radians(deg) * min_jerk(x)
            a, t0 = a + math.radians(deg), t0 + self.stroke_s
        return a

    def obj_at(self, name, t):
        if name != f"sg_{self.joint}" or self.t_turn is None:
            return super().obj_at(name, t)
        return handwheel_pose(self.place, self.state, self.joint, self.turned(t))

    def knob_axis(self):
        """The knob's root at the rim and its axis outward (world mm), where the take finds the wheel."""
        c = SG.record()["colliders"][self.knob]
        J = SG.record()["joints"][self.joint]
        at = np.array(J["at_mm"], float)
        key = "cylinder_y_mm" if "cylinder_y_mm" in c else "cylinder_x_mm"
        lo, hi = c[key]
        k = 1 if key == "cylinder_y_mm" else 0
        near, far = (lo, hi) if abs(lo - at[k]) < abs(hi - at[k]) else (hi, lo)
        root0, tip0 = np.array(c["at_mm"], float), np.array(c["at_mm"], float)
        root0[k], tip0[k] = near, far                     # the knob at joint zero: its root at the rim, its free end
        Rq = Rotation.from_rotvec(np.array(J["axis"], float) * self.state["q"][self.joint]).as_matrix()
        shift = chuck_shift(self.state) * [0, 1, 0] if self.joint in ("table_handwheel", "cross_handwheel") else 0.0
        root, tip = (self.place.world(at + shift + Rq @ (p - at)) for p in (root0, tip0))
        out = (tip - root) / np.linalg.norm(tip - root)
        return root, out, float(np.linalg.norm(tip - root))

    def knob_mid(self, t: float) -> np.ndarray:
        R, o = self.obj_at(f"sg_{self.joint}", t)
        R0, o0 = handwheel_pose(self.place, self.state, self.joint, 0.0)
        root, out, length = self.knob_axis()
        return o + R @ (R0.T @ (root + out * length / 2 - o0))

    def grip_specs(self) -> dict:
        from moonshot.motion.bandsaw import on_knob
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731
        h = self.hand
        root, out, length = self.knob_axis()
        r = SG.record()["colliders"][self.knob]["radius_mm"]
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 55.0, 70.0
        q0.update(thumb_cmc_abd=15.0, thumb_cmc_flex=10.0, thumb_mcp_flex=30.0, thumb_ip=25.0)
        on = lambda lo, hi, w=1.0: on_knob(root, out, r, lo, hi, w=w)       # noqa: E731
        wheel = SG.record()["colliders"][self.joint]
        J = SG.record()["joints"][self.joint]
        R, o = handwheel_pose(self.place, self.state, self.joint, 0.0)
        axis = self.place.R @ np.array(J["axis"], float)
        half = abs(np.diff(wheel.get("cylinder_y_mm", wheel.get("cylinder_x_mm")))[0]) / 2
        disc = lambda p: G.sdf_cyl(p, o - axis * half, o + axis * half, wheel["radius_mm"])   # noqa: E731
        return {"knob": dict(of=f"sg_{self.joint}", obj=root + out * length / 2, q0=q0, iters=1200,
                             colliders=[lambda p: G.sdf_cyl(p, root, root + out * length, r), disc],
                             targets={"index": on(22, 34), "middle": on(37, 49), "ring": on(51, 61),
                                      "thumb": on(22, 52, w=0.2)},
                             starts=[S(f, 0, 0, pl, el, -30, eb, pr, -10, 0) for f in (10, 30) for pl in (50, 70)
                                     for el in (45, 60) for eb in (45, 70) for pr in (5, 35)])}

    def compose(self):
        self.t = 0.4
        g = self.grips["knob"]
        root, out, length = self.knob_axis()
        self.look(0.0, root + out * length / 2)
        _, Wg = self.grip_pose("knob", self.t)
        up = np.array([0, 0, 1.0])
        tg = self.reach("R", "knob", self.t, ready=Wg + out * 160 + up * 60, approach=Wg + out * 70 + up * 25,
                        opened=0.7, lead=0.12, reach_s=0.6, rise_s=1.6, still_s=0.4)
        self.effort("R", tg, 0.0, "knob")
        self.effort("R", tg + 0.25, 0.3, "knob")
        eased = open_like(self.hand, g["q"], 0.15)
        self.fingers("R", tg + 0.15, eased)
        self.t_turn = tg + 0.3
        t_off = self.t_turn + self.stroke_s * len(self.strokes_deg) + 0.2
        H0, W0 = self.grip_pose("knob", tg)
        mid0 = self.knob_mid(tg)
        self.add("R", tg, t_off, lambda t: [("pose", H0, W0 + self.knob_mid(t) - mid0, 3.0)])
        self.event("grip", tg, t_off + 0.1, side="R", grip="knob", on=f"sg_{self.joint}")
        self.event("carry", tg + 0.1, t_off, obj=f"sg_{self.joint}", grip="knob", side="R", skin=True)
        self.event("loose", tg + 0.1, t_off, obj=f"sg_{self.joint}")
        q0 = self.state["q"][self.joint]
        for i, deg in enumerate(self.strokes_deg):
            t0 = self.t_turn + i * self.stroke_s
            self.event("turn", t0, t0 + self.stroke_s, side="R", obj=f"sg_{self.joint}", joint=f"sg_{self.joint}",
                       knob=f"sg_{self.knob}", force=KNOB_N, max_n=20.0,
                       q0=q0 + math.radians(sum(self.strokes_deg[:i])), turn_rad=math.radians(deg))
        self.effort("R", t_off + 0.1, 0.0, "knob")
        W = W0 + self.knob_mid(t_off) - mid0
        self.add("R", t_off, t_off + 0.4, lambda t: [("pose", H0, W + out * 80 * min_jerk((t - t_off) / 0.4), 3.0)])
        self.release_keys(eased, t_off, t_off + 0.4, t_off + 0.7)
        self.wrist["R"] = W + out * 80
        self.clip(self.caption.split()[0].lower(), 0.0, t_off + 0.7, self.caption)
        self.to_rest("R", t_off + 0.4, t_off + 1.5)
        self.t = t_off + 1.7


class RockPlan(KnobTurnPlan):
    """A pass's strokes (the hand-grind card's phase 1): the table rocked by its handwheel from the front, the
    wheel in the groove at a pass's depth."""
    place, lumbar_station, card = GC.FRONT, GC.FRONT_LUMBAR, "sgrind-hand-grind"
    joint, knob = "table_handwheel", "table_handwheel_knob"
    _a = math.degrees(ROCK_MM / (SG.record()["joints"]["table_handwheel"]["travel_mm_per_turn"] / (2 * math.pi)))
    strokes_deg = [_a] + [-2 * _a, 2 * _a] * (ROCK_CYCLES - 1) + [-2 * _a, _a]
    caption = "ROCK  the table rocked under the wheel along the edge's middle"

    def obstacles(self) -> list:
        return [world_aabb(self.place, self.state, n) for n in ("saddle_arm", "base")]


class FeedPlan(KnobTurnPlan):
    """A pass's down-feed (the hand-grind card's phase 2): the down-feed handwheel turned 2.5 graduations, 0.0005
    in, from the machine's right side."""
    place, lumbar_station, card = GC.RIGHT, GC.RIGHT_LUMBAR, "sgrind-hand-grind"
    joint, knob = "downfeed_handwheel", "downfeed_handwheel_knob"
    strokes_deg = [FEED_GRADUATIONS * 360 / SG.record()["joints"]["downfeed_handwheel"]["graduations"]]
    stroke_s = FEED_S
    caption = "FEED  the wheel fed down 0.0005 in by its handwheel"

    def obstacles(self) -> list:
        return [world_aabb(self.place, self.state, n) for n in ("column", "table")]


TAKE_PLANS = {"magnet-on": MagnetOnPlan, "edge1-rock": RockPlan, "edge1-feed": FeedPlan}


def take_dir(part: str, setup: str, take: str) -> Path:
    return TAKES / f"{part}-{setup}-{take}"


def state_before(part: str, setup: str, take: str) -> dict:
    """What a take starts from: the take before it in the chain if it has run, otherwise the grinder as found with the
    work blocked in (initial_state)."""
    if take.endswith("-rock"):                             # a pass at its depth (the chain before it not yet run)
        return grind_state(part, int(take[4]), ROCK_PASS)
    if take.endswith("-feed"):                             # from the rock before it
        f = take_dir(part, setup, take.replace("-feed", "-rock")) / "state.json"
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else grind_state(part, int(take[4]), ROCK_PASS)
    chain = ["wipe-chuck", "block-in", "magnet-on"]
    i = chain.index(take) if take in chain else -1
    for prev in reversed(chain[:i] if i > 0 else []):
        f = take_dir(part, setup, prev) / "state.json"
        if f.exists():
            return json.loads(f.read_text(encoding="utf-8"))
    return initial_state(part)


def build(part: str, setup: str, take: str, solve: bool = True, verbose: bool = True):
    state = state_before(part, setup, take)
    out = take_dir(part, setup, take)
    out.mkdir(parents=True, exist_ok=True)
    (out / "state_in.json").write_text(json.dumps(state, indent=1), encoding="utf-8")
    plan = TAKE_PLANS[take](state, out, verbose=verbose)
    plan.compose()
    if solve:
        plan.solve()
        plan.save_take({"part": part, "setup": setup, "take": take})
    return plan


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], sys.argv[3])
