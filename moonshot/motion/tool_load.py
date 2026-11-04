"""Load the tools (a VF-2 setup's step 7; the vf2-tool-load card): every tool the setup uses first goes into the
carousel through the spindle, as Haas's manual has it for the umbrella changer. The step is a run of takes cut
together, as the body model doesn't walk (the declared cut of moonshot/motion/door_cycle.py): at the pendant, MDI,
T<n> and ATC FWD put the probe away and bring pocket n to the spindle, empty; then, for each tool, standing in the
doorway (one fork's pitch further right for each fork further right, across the cut: `door_lumbar`) the right hand
takes its holder off the tool stand on the table, carries it in under the spindle and pushes it
up into the spindle while the left holds the head's Tool Release button, lets go of the button so the drawbar clamps,
and lets go of the holder (`Seat`); and at the pendant ATC FWD puts it in its pocket and brings the next one
(`ToolChange`).

    python -m moonshot.motion.tool_load nist-ftc-10 op50-tools    # plans <data root>/takes/nist-ftc-10/op50-tools/*

The tools are numbered, and so pocketed, in the order the plan first uses them (the probe is the shop's tool 20,
moonshot/library/records/shop.json): op10's five are T1-T5, op20's four T6-T9, op30's drill T10, op50's T11.

Each take's take.json gets, beside the events: "setup" (what its physics run builds: the part in the vise as the
setting takes have it, the tool in the spindle, setup mode, and "tools": the stand's holders by fork, the carousel's by
pocket, the pocket facing the spindle, and the holder this take carries), "card", and "load": what the take does
(kind, tool, pocket), which moonshot/tests/gates/test_setting_takes.py holds the run to.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import torch

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import solver as BS
from moonshot.motion.pendant import (FINGER_DEG_S, LUMBAR as PENDANT_LUMBAR, OFFSET, PendantTake,
                                     fingertip_in_hand, key_at)
from moonshot.motion.primitives import FPS, PosePath, min_jerk, open_for, open_like
from moonshot.motion.setting import PROBE, SCREEN, part_in_vise
from moonshot.motion.step_take import HANGING as STEP_HANGING, REST_NEAR_MM, StepTake
from moonshot.planning.steps import expand
from moonshot.planning.takes import tool_takes
from moonshot.planning.validate import load_plan
from moonshot.world import tooling as TL
from moonshot.world import vf2

CARD = "vf2-tool-load"
PROBE_POCKET = 20                                        # shop.json conventions.probe_tool_number
REC = vf2.record()
SPINDLE = np.array(REC["joints"]["spindle"]["centre_mm"], float) + OFFSET      # the gauge point, head at Z home
BUTTON = np.array(REC["affordances"]["tool_release_head"]["at_mm"], float) + OFFSET
DOOR_LUMBAR = np.array([-470.0, -935.0, 955.0])          # in the doorway, a little left of the spindle: the right
                                                         # hand reaches it and the stand right of the vise, the
                                                         # left the button
BELOW_MM = 115.0                                         # the holder carried in to this far below its seat, its knob
                                                         # 20 mm under the spindle's nose, and lined up there before it
                                                         # goes up: at 80, its knob up in the nose's bore, a holder
                                                         # arriving 40 mm off the axis met the nose from below
PUSH_UP_S = 0.85                                         # pushed up to under the drawbar in this long: in 0.6 s, the
                                                         # front of the shoulder (anterior deltoid) worked past its
                                                         # maximum at 105% as the push stopped, from the second fork
LINE_UP_S = 0.8                                          # lined up under the spindle, by eye, this long
TRANSPORT_S = 1.2                                        # up from the stand to under the spindle ...
TRANSPORT_MM = 430.0                                     # ... this far or less (from fork 0), longer farther
STANCE_MM_PER_FORK = 72.0                                # the stance moves this far right for each fork further right,
                                                         # the stand's pitch: the reach to each holder is the first's
                                                         # (moving half as far, the right hand reached a fork 3
                                                         # forks right 54 mm further and 0.07 s later, still moving as
                                                         # the fingers closed: the grip's load passed 5% of the weight
                                                         # within 0.03-0.13 s)
BACK_S = 1.3                                             # back to rest from the spindle in this long ...
BACK_MM = 900.0                                          # ... from this far, longer farther: in 0.85 s, 1 m from the
                                                         # fifth fork's stance, the arm reached 30 m/s^2
OUT_MM = np.array([20.0, -45.0, -15.0])                  # the hand off the seated holder: back toward the body along
                                                         # the open fingers, a little right and down
OPEN_OFF = 0.9                                           # the fingers open this far off the holder before the palm
                                                         # comes away: at 0.7, with the hand turned 13 deg round the
                                                         # holder from its planned grip, they dragged through it
# the grasp's timing (Guillery 2013, thresholds.toml person.grasp_*): the fingers close, the grip firms with no load
# yet (preload, the middle of people's band), the hand takes the holder's weight (loading) and the holder comes off
# the tines as the weight is taken, about 0.2 s later, as people's 0.16-0.27 s
CLOSE_S = 0.12
PRELOAD_S = 0.23
LIFT_LEAD_S_PER_KG = 0.33                                # the lift planned this much sooner per kg the holder weighs
HOLDER_KG_LIGHT = 1.2                                    # past this (every drill, reamer, tap and end mill weighs less)
LIFT_S = 0.2                                             # the lift off the tines, 2.5 mm from 0.1 s after the
                                                         # loading starts: planned 1 mm up 0.19 s into it
LOAD_RAMP_S = 0.26                                       # the holder's weight fed forward, and the grip firmed, over
                                                         # this from the loading's start (moonshot/sim/tool_load.py)
# the reach to the holder (people's reach to grasp, person.reach_to_grasp_right_s, 0.32-0.67 s from its onset to the
# fingers' contact): from rest to in front of the holder in REACH_S, the approach onto the grip starting APPROACH_AT
# into it and lasting APPROACH_S, overlapping, and the fingers on the holder TOUCH_S after the hand is on its grip
REACH_S = 0.46
REACH_MM = 340.0                                         # ... for a reach this long or shorter (fork 0's)
APPROACH_AT = 0.32
APPROACH_S = 0.24
TOUCH_S = 0.03
TOUCH_MM = 1.0                                           # Tool Release's press planned to the pad just off it: the
                                                         # press pushes (moonshot/sim/pendant.py), as at the keys
HOVER_L_MM = 30.0                                        # the left index waits this far off the button, as over Cycle
                                                         # Start (motion/pendant.py HOVER_DWELL_S), then presses ...
PRESS_IN_S = 0.3                                         # ... coming in this slowly: from 50 mm in 0.15 s it struck
                                                         # the button at 22 N, bounced off and pressed it twice
PRESS_LEAD_S = 0.15                                      # the press starts this long before the pad is planned on it
PRESS_AFTER_S = 0.4                                      # and the pad is on it this long after the holder stops under
                                                         # the drawbar
# where a hand at rest hangs, from the lumbar pivot, and the arm hanging there, the body solve's start where it has no
# task: people standing at work (the posture prior's standing components) hang their arms near straight, the elbow
# a few degrees bent, the shoulder neither turned in nor out across the body. At the planners' usual place
# (moonshot/motion/step_take.py REST_OFFSET, 20 mm higher and 60 mm further in) the solver kept the elbow bent 15 deg
# and the shoulder up to hold the hand there, and a hand at rest scored a negative log-likelihood of 26-28 started
# hanging (moonshot/motion/step_take.py HANGING) and 34-40 started where it works: past people's 28.7, and a pendant take's
# left hand rests through it all. Here, started from this arm, the solver settles at 19-20
REST_MM = np.array([270.0, 55.0, -125.0])
HANGING = [11.0, 9.0, -2.0, 13.0, 12.0, -5.0, 0.0, -6.0, -6.0]
OPEN_AT = 0.785                                          # the hand opens widest this far into its reach, as people's
                                                         # do at 71-77% (person.peak_aperture_reach_frac): measured
                                                         # 0.714 at a planned 0.736, the fingers peaking early
ONSET_LEAD_S = 0.07                                      # the solved reach starts this long before its transit's
                                                         # start, smoothed by the solver, and is timed from there
SHORT_MM = 25.0                                          # pushed up to this far short before Tool Release opens the
                                                         # drawbar: the knob stops 10 mm under the closed fingers
OVER_MM = 1.0                                            # and pushed this far past the seat, which stops it
EASE_MM = 1.5                                            # the hand eases this far down once the drawbar holds it
LIFT_MM = 2.5                                            # off the stand's tines, and slid out toward the operator
SLIDE_MM = 68.0
CLEAR_UP_MM = 200.0                                      # then up, so its tool clears the part and the vise
YAW_DEG_PER_FORK = 10.0                                  # the grip turned this far about the holder's axis (from
                                                         # above, anticlockwise) by the time it is under the spindle,
                                                         # for each fork right of the first: from a stance further
                                                         # right the arm reaches further across to the spindle, and
                                                         # the wrist, kept turned as for the first fork, bent back
                                                         # 45-50 deg (from fork 3, a median negative log-likelihood of
                                                         # 29.9 unturned, 28.2 turned 15 deg, 27.2 turned 30)
CLEAR_STAND_MM = np.array([-50.0, 120.0, 270.0])         # back to rest by way of a point this far above and in front
                                                         # of it: high over the holders still on the stand, and down in
                                                         # front of the vise's crank (straight down to a stance further
                                                         # right, the hand swept through the stand's holders; by way of
                                                         # a point in front of the spindle, its fingers hit the crank)
CAROUSEL = np.array(REC["tool_changer"]["centre_mm"], float) + OFFSET


def pockets(plan: dict) -> dict[str, int]:
    """Each tool's number, and so its pocket: the order the plan first uses it."""
    order = list(dict.fromkeys(op["tool"] for s in plan["setups"] for op in s["operations"]))
    return {t: i + 1 for i, t in enumerate(order)}


def sequence(plan: dict, step: dict) -> list[dict]:
    """The step's takes in order, each with the state its run starts from: the carousel ({pocket: tool}), the pocket
    facing the spindle, what is in the spindle, and the stand ({fork: tool}). The first tool waits in the rightmost
    fork and is taken first, so the hand, which wraps a holder from its right, never has one beside it there."""
    num = pockets(plan)
    tools = step["facts"]["tool_ids"]
    n = len(tools)
    earlier = {num[t]: t for s in expand(plan) if s["title"] == "Load the tools" and s["id"] != step["id"]
               for t in s["facts"]["tool_ids"] if num[t] < num[tools[0]]}
    carousel, stand = dict(earlier), {n - 1 - i: t for i, t in enumerate(tools)}
    state = lambda: {"pockets": dict(sorted(carousel.items())), "stand": dict(sorted(stand.items()))}    # noqa: E731
    out = [{"name": "00-change", "kind": "change", "to": num[tools[0]], "spindle": "probe", "current": PROBE_POCKET}
           | state()]
    carousel[PROBE_POCKET] = "probe"
    for i, t in enumerate(tools):
        p = num[t]
        out.append({"name": f"{2 * i + 1:02d}-seat-{t}", "kind": "seat", "tool": t, "fork": n - 1 - i, "pocket": p,
                    "spindle": None, "current": p} | state())
        stand.pop(n - 1 - i)
        out.append({"name": f"{2 * i + 2:02d}-atc-{t}", "kind": "atc", "tool": t, "pocket": p, "spindle": t,
                    "current": p} | state())
        carousel[p] = t
    assert [s["name"] for s in out] == tool_takes(step)     # the takes planning/takes.py joins into the step's video
    return out


# --- the grips ---------------------------------------------------------------------------------------------------------
HOLDER_GRIP = Path(__file__).with_name("holder_grip.json")


def cyl_target(axis_pt, r, z_band, phi_band, comp=2.0, w=1.0):
    """A pad on a vertical cylinder's side (axis through axis_pt, radius r) within a height band (mm from axis_pt)
    and an angle band (deg about the axis from +X, toward +Y), facing the axis."""
    C = torch.as_tensor(np.asarray(axis_pt, float))

    def f(c, n):
        rel = c - C
        rad = torch.linalg.norm(rel[:2]) + 1e-9
        u = torch.cat([rel[:2] / rad, torch.zeros(1, dtype=rel.dtype)])
        phi = torch.rad2deg(torch.atan2(rel[1], rel[0]))
        return w * ((rad - (r - comp)) ** 2 + 30 * (1.0 + n @ u) ** 2
                    + 0.5 * (torch.relu(z_band[0] - rel[2]) ** 2 + torch.relu(rel[2] - z_band[1]) ** 2)
                    + 0.05 * (torch.relu(phi_band[0] - phi) ** 2 + torch.relu(phi - phi_band[1]) ** 2))
    return f


def holder_colliders(at, tool_id: str) -> list:
    """A holder's solids for the grip solver (world mm), its gauge line at `at`."""
    at = np.asarray(at, float)
    t = TL.cutter(tool_id)
    cyl = lambda r, z0, z1: (lambda p, r=r, a=at + [0, 0, z0], b=at + [0, 0, z1]: G.sdf_cyl(p, a, b, r))  # noqa: E731
    return [cyl(TL.FLANGE_TOP[0], TL.FLANGE_BOTTOM[1], TL.FLANGE_TOP[2]), cyl(*TL.BODY),
            cyl(t["r"], -t["length"], -TL.GAUGE_MM), cyl(TL.TAPER["r"], -4.5, 68.5)]


def fit_holder_grip(tool_id: str = "drill-5p5", iters: int = 350) -> dict:
    """A holder's grip, solved for the hand alone (moonshot/motion/grasp.py Problem.solve) and kept in
    holder_grip.json by tool: a handshake, the hand's long axis along +Y into the machine, thumb up, the palm on the
    holder's right side, the index under the flange and the fingers round its back, the thumb round its front; where
    the tool is wider than the holder's body (the face mill), the middle finger on the tool's side. The same grip holds
    it on the stand and in under the spindle; the body finds the arm for each (the planner). A tool with none of its
    own takes the default's, when the skin doesn't sink into its tool by more than the checks allow."""
    from moonshot.body.hand import AnatomicalHand
    from moonshot.body.nimble import Nimble
    hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
    th, at, r = G.TorchHand(hand), np.zeros(3), TL.BODY[0]
    cols = holder_colliders(at, tool_id)
    tool = TL.cutter(tool_id)
    targets = {"index": cyl_target(at, r, (-31.0, -23.0), (60.0, 175.0)),
               "thumb": cyl_target(at, r, (-34.0, -22.0), (-150.0, -50.0))}
    if tool["r"] <= r:                       # a tool wider than the body (the face mill): the middle rests on its top
        targets["middle"] = cyl_target(at, r, (-46.0, -32.0), (40.0, 175.0))
    long, radial, dorsal = np.array([0, 1.0, 0]), np.array([0, 0, 1.0]), np.array([1.0, 0, 0])
    starts = []
    kept = json.loads(HOLDER_GRIP.read_text(encoding="utf-8")) if HOLDER_GRIP.exists() else None
    if kept and tool_id != kept["default"]:  # from the default tool's grip, moved off this tool
        d = kept["grips"][kept["default"]]
        starts.append((d["q"], np.array(d["H"]), np.array(d["W_rel"])))
    else:
        for mcp, pip in ((55.0, 60.0), (70.0, 75.0)):
            q = hand.neutral()
            for n in ("index", "middle", "ring", "little"):
                q[f"{n}_mcp_flex"], q[f"{n}_pip"], q[f"{n}_dip"] = mcp, pip, 30.0
            q.update(thumb_cmc_abd=40.0, thumb_cmc_flex=20.0, thumb_mcp_flex=15.0, thumb_ip=10.0)
            for back in (70.0, 90.0):
                starts.append((q, np.stack([long, radial, dorsal], 1), at + dorsal * (r + 10.0) - long * back + radial * -52.0))
    best = None
    for q, H0, W0 in starts:
        g = G.Problem(th, cols, targets, hand.clamp(q)).solve(H0, W0, iters=iters, lr=0.05, rot_free_deg=25.0,
                                                              move_mm=40.0)
        if best is None or g["loss"] < best["loss"]:
            best = g
    out = {"q": best["q"], "H": np.asarray(best["H"]).tolist(), "W_rel": np.asarray(best["W"]).tolist(),
           "loss": round(best["loss"], 2), "terms": {k: round(v, 2) for k, v in best["terms"].items()}}
    kept = kept or {"default": tool_id}
    kept.setdefault("grips", {})[tool_id] = out
    HOLDER_GRIP.write_text(json.dumps(kept, indent=1), encoding="utf-8")
    return out


class InRange(BS.BodySolver):
    """The body solver, the trunk also held inside people's range as the left arm's people see it: mirrored
    (moonshot/validate/posture.py left_arm), so its lateral bend and rotation must lie inside the range turned about
    zero too. The solver's own range cost (posture_cost) counts the trunk once, against the right arm's people."""

    def _arm_terms(self, th, L, packed, side, boxes, trunk):
        terms = super()._arm_terms(th, L, packed, side, boxes, trunk)
        if trunk:
            lo, hi = (torch.as_tensor(self.prior.pct[1:3, i], dtype=th.dtype) for i in (0, -1))
            m = BS.RANGE_MARGIN_DEG
            out = torch.relu(-hi + m - th[:, 1:3]) + torch.relu(th[:, 1:3] + lo + m)
            terms["range_mirrored"] = self.W["range"] * (out ** 2).sum()
        return terms


class ToolTake(StepTake):
    """What the Load the tools takes plan alike, at the pendant and in the doorway.

    Every trunk-to-wrist angle held firmly inside people's range (`SOLVER_W` range, InRange for the trunk as the left
    arm's people see it), as the posture checks hold each arm to it: at the solver's own 0.5 the holder held out under
    the spindle turned the trunk 16-19 deg (people's 1st percentile is 13.9) to bring the shoulder nearer, at the keypad
    the trunk bent 10 deg sideways (8.4), and the left arm, coming down from Tool Release, turned its shoulder out
    34 deg (30.9): out of an arm's range in 13-20% of the frames, where the checks allow 7%. People's posture prior
    weighed 1.5, not every take's 0.3: holding the holder up under the spindle, the right arm was as unlike people as a
    median 28.1-28.3 negative log-likelihood, a few tenths inside their 28.7; at 1.0 27.7, at 2.0 27.2, the hands on
    their targets as before.

    The hands rest at REST_MM, and an arm with no task starts the body solve hanging there (HANGING, on top of
    StepTake.theta0's start, which hangs it at the planners' usual place)."""
    SOLVER_W = {"prior": 1.5, "range": 30.0}
    body_solver = InRange

    def theta0(self, n) -> np.ndarray:
        """StepTake.theta0, each arm hanging as HANGING where it hangs there; and the left after its last task too
        when that task brings it back to rest: StepTake.theta0 compares the left's target, in the mirrored world as
        the planner has it, with its rest in the world, 540 mm apart, so a left hand back at rest started working."""
        th = super().theta0(n)
        for side, cols in (("R", slice(3, 12)), ("L", slice(12, 21))):
            hung = np.all(np.isclose(th[:, cols], STEP_HANGING), axis=1)
            th[hung, cols] = HANGING
            cons = self.side[side]["cons"]
            if cons:
                _, last, fn = max(cons, key=lambda c: c[1])
                if np.linalg.norm(self.target_of(fn, last - 1e-6) - self.rest) < REST_NEAR_MM:
                    th[np.arange(n) / FPS >= last, cols] = HANGING
        return th


def door_lumbar(fork: int) -> np.ndarray:
    """Where the body stands to take a holder from fork `fork` and seat it."""
    return DOOR_LUMBAR + [STANCE_MM_PER_FORK * fork, 0.0, 0.0]


def rest_at(take: StepTake) -> None:
    """The take's hands hang at rest at REST_MM from its lumbar (the left's mirrored, as the planner has it)."""
    take.rest = take.lumbar + REST_MM
    for s in take.side.values():
        s["wrist"] = take.rest.copy()


def holder_grip(tool_id: str) -> dict:
    """The grip a holder is carried in (holder_grip.json): its tool's own, else the default."""
    kept = json.loads(HOLDER_GRIP.read_text(encoding="utf-8"))
    return kept["grips"].get(tool_id, kept["grips"][kept["default"]])


class Seat(ToolTake):
    """One holder off the stand and into the spindle (the vf2-tool-load card's phases 2-7)."""

    def __init__(self, out, tool_id: str, fork: int, n_forks: int, verbose=True):
        super().__init__(out, door_lumbar(fork), verbose)
        rest_at(self)
        self.tool, self.fork, self.n = tool_id, fork, n_forks
        boxes = []
        for lo, hi in ((np.array(REC["colliders"]["table_top"]["box_min_mm"]) + OFFSET,
                        np.array(REC["colliders"]["table_top"]["box_max_mm"]) + OFFSET),
                       (TL.stand_axis(0) + [-40.0, TL.STAND["plate_y"], TL.STAND["table_z"] - TL.stand_axis(0)[2]],
                        TL.stand_axis(n_forks - 1) + [40.0, TL.STAND["plate_y"] + 8.0, 12.0])):
            boxes.append(((lo + hi) / 2, (hi - lo) / 2))
        self.boxes = boxes
        self.solve_grips({"release": self.release_spec()}, source=Seat.release_spec)
        g = holder_grip(tool_id)
        W_rel = np.array(g["W_rel"], float)
        self.grips["holder"] = {"q": self.hand.clamp(g["q"]), "H": np.array(g["H"], float), "W": W_rel, "obj": np.zeros(3),
                                "side": "R", "theta": np.zeros(12), "W_rel": W_rel, "loss": g["loss"]}

    def shape_s(self, a: dict, b: dict) -> float:
        """How long the hand takes from one shape to another, as a pendant take's (moonshot/motion/pendant.py)."""
        return 1.875 * max(abs(a[n] - b[n]) for n in a) / FINGER_DEG_S

    def release_spec(self) -> dict:
        """The left index on the head's Tool Release button, pressing it into the head."""
        b = BUTTON
        qb = self.hand.neutral()
        qb.update(index_mcp_flex=15, index_pip=20, middle_mcp_flex=75, middle_pip=95, ring_mcp_flex=80, ring_pip=95,
                  little_mcp_flex=80, little_pip=90, thumb_cmc_flex=15, thumb_cmc_abd=5, thumb_mcp_flex=40, thumb_ip=35)
        band = lambda p, b=b: 0.5 * ((p[0] - b[0]) ** 2 + (p[2] - b[2]) ** 2)              # noqa: E731
        head = lambda p, c=b + [0, 15.0, 0]: G.sdf_box(p, c, np.eye(3), np.array([150.0, 10.0, 80.0]))  # noqa: E731
        return dict(obj=b, q0=qb, side="L", iters=900, colliders=[head],
                    targets={"index": G.plane_target(b, [0, -1.0, 0], 1.0, band)},
                    starts=[[t, 0, 0, pl, 95, 0, 45, p, -10, 0, 0, 0] for t in (25,) for pl in (70, 90)
                            for p in (0, 40)])

    # --- the holder's path -----------------------------------------------------------------------------------------
    def plan(self) -> dict:
        P0 = TL.on_stand(self.fork)
        g = self.grips["holder"]
        H, Wg = self.grip_pose("holder", P0)
        kg = TL.holder_kg(self.tool)
        keys = []                                         # (t, holder's gauge line), min-jerk between them

        def at(t, keys=keys):
            p = keys[0][1]
            for (t0, a), (t1, b) in zip(keys, keys[1:]):
                if t >= t0:
                    p = a + (b - a) * min_jerk((t - t0) / max(t1 - t0, 1e-9))
            return p

        # the reach: from rest to in front of the holder, right of it and below its flange (the open fingers go past
        # its side, and the hand rises the last few millimetres to the flange's underside), and on to the grip, as two
        # overlapping minimum-jerk submovements (Flash & Henis 1991), the grip's turn faded in on the way: as two
        # moves one after the other, the first crossed its 330 mm in 0.22 s, and the plan's hand, at 31 m/s^2, outran
        # the acceleration the cause check allows (physics.acceleration_spike_m_s2) and the arm, after it, twice that
        t_on = 0.2
        # in from level with the grip where the tool is wider than the holder's body (the face mill): from below it,
        # the open fingers swept through the cutter
        pre = Wg + [15.0, -60.0, 0.0 if TL.cutter(self.tool)["r"] > TL.BODY[0] else -12.0]
        # farther reaches take longer, their peak acceleration kept (a minimum-jerk move's grows as its length over its
        # duration squared), the approach onto the grip as long as ever
        reach_s = REACH_S * math.sqrt(max(1.0, np.linalg.norm(pre - self.side["R"]["wrist"]) / REACH_MM))
        t_app = t_on + APPROACH_AT + reach_s - REACH_S
        t_c = t_app + APPROACH_S                          # on the grip
        t_touch = t_c + TOUCH_S                           # the fingers on it: the carry takes it (moonshot/sim/
        # tool_load.py: the hand and the holder don't collide from the final approach on, as a welded tool's grip, so
        # that is when the hand has it), and the reach, timed to it, ends
        W0 = self.side["R"]["wrist"]
        self.look(0.0, P0 + [0, 0, -30.0])

        def reach(t, W0=W0, pre=pre, Wg=Wg, H=H):
            W = W0 + (pre - W0) * min_jerk((t - t_on) / reach_s) + (Wg - pre) * min_jerk((t - t_app) / APPROACH_S)
            w = min_jerk((t - t_on) / (t_app + 0.1 - t_on))
            return [("pos", W, 1.0)] + ([("pose", H, W, 2.0 * w)] if w > 0 else [])
        self.add("R", t_on, t_c + 0.05, reach)
        self.side["R"]["wrist"] = Wg
        size = 2 * TL.BODY[0]
        # the hand opens for the reach as for the default grip where its own is the default's with fingers moved
        # ("from"): an end mill's grip, its middle and ring fingers straightened off the cutter, opened so, put them on
        # the table's front edge as the hand rose
        kept = json.loads(HOLDER_GRIP.read_text(encoding="utf-8"))
        reach_q = self.hand.clamp(kept["grips"][kept["default"]]["q"]) if "from" in holder_grip(self.tool) else g["q"]
        self.fingers("R", t_on + 0.05, open_like(self.hand, reach_q, 0.2))
        onset = t_on - ONSET_LEAD_S
        self.fingers("R", onset + OPEN_AT * (t_touch - onset), open_for(self.hand, reach_q, size))
        self.fingers("R", t_c + CLOSE_S, g["q"])
        self.effort("R", t_c, 0.0, "holder")
        self.effort("R", t_c + 0.2, 0.6, "holder")
        # the weight taken (moonshot/sim/tool_load.py feeds it forward) and the holder lifted off the tines as it is
        # taken
        tw0 = t_touch + PRELOAD_S
        # a heavier holder lifted sooner: the arm, taking its weight, comes up to it later (the face mill's, 0.4 kg
        # more than a drill's, came off the tines 0.13 s later than the plan)
        tl = tw0 + 0.14 - LIFT_LEAD_S_PER_KG * max(0.0, kg - HOLDER_KG_LIGHT)
        # off the tines, out of the fork toward the operator, up clear of the part, and in under the spindle
        t1 = tl + LIFT_S
        t2 = t1 + 0.43
        t2b = t2 + 0.5
        slid = P0 + [0, -SLIDE_MM, LIFT_MM]
        lifted = slid + [0, 0, CLEAR_UP_MM]
        # the carry in under the spindle, longer from a farther fork
        t3 = t2b + TRANSPORT_S * math.sqrt(max(1.0, np.linalg.norm(SPINDLE - [0, 0, BELOW_MM] - lifted) / TRANSPORT_MM))
        keys += [(t_touch, P0), (tl, P0), (t1, P0 + [0, 0, LIFT_MM]), (t2, slid),
                 (t2b, lifted), (t3, SPINDLE - [0, 0, BELOW_MM])]
        self.look(t2, SPINDLE - [0, 0, 60.0])
        t4 = t3 + LINE_UP_S                                 # lined up under it, by eye
        t5 = t4 + PUSH_UP_S
        keys += [(t4, SPINDLE - [0, 0, BELOW_MM]), (t5, SPINDLE - [0, 0, SHORT_MM])]
        # the left hand to the button, pressed and held while the right pushes the holder home
        gl = self.grips["release"]
        HL = gl["H"]                                     # in the mirrored world, as solved
        # the wrist with the index's pad, where the physics presses with it (moonshot/motion/pendant.py
        # fingertip_in_hand), 1 mm off the button: the grip's own pad, the skin's, stood 13 mm deeper and 12 mm across,
        # so the index met the button a quarter of a second early and off its middle
        pt = fingertip_in_hand(gl["q"], HL.T @ np.array([0.0, 1.0, 0.0]))
        WL_on = self.at("L", BUTTON) - [0, TOUCH_MM, 0] - HL @ pt
        hover = WL_on + [0, -HOVER_L_MM, 0]
        tl0, tl1 = t3 - 0.7, t4 + 0.15
        self.transit("L", tl0, tl1, self.at("L", hover), fade=(HL, 1.0))
        # the index shaped on the way up and held so through the press: blended from the reach's start to the
        # relaxed hand after it, the fingers were 70% of the way back to relaxed by the press, and the pad 30 mm under
        # the button
        self.fingers("L", tl0, self.q_relax)
        self.fingers("L", tl0 + self.shape_s(self.q_relax, gl["q"]), gl["q"])
        # the index on the button, from the hover in PRESS_IN_S, once the right hand has stopped the holder under the
        # drawbar: pressed while the right pushed it up there, the trunk carried the left hand 20 mm across the head and
        # the index struck the button's edge, bounced and pressed it twice
        tp = t5 + PRESS_AFTER_S
        t6 = tp + 0.35                                      # the drawbar open: pushed up past the seat
        t7 = t6 + 0.45
        keys += [(t6, SPINDLE + [0, 0, OVER_MM]), (t7, SPINDLE + [0, 0, OVER_MM])]
        tr = t7 + 0.05                                      # Tool Release let go: the drawbar clamps
        path = PosePath(HL, hover).to(tp - PRESS_IN_S, PRESS_IN_S, HL, WL_on).to(tr, 0.15, HL, hover)
        self.add("L", tl1, tr + 0.15, lambda t, path=path: [("pose", *path.at(t), 3.0)])
        # the press from PRESS_LEAD_S before the pad is planned on the button, as a key's (moonshot/motion/pendant.py
        # press): from then the physics pushes, once the pad is over it
        self.event("press", round(tp - PRESS_LEAD_S, 3), round(tr, 3), side="L", key="tool_release_head",
                   force=REC["affordances"]["tool_release_head"]["force_n"], normal=[0.0, 1.0, 0.0], hold=True,
                   reach_t0=round(tl0, 3))
        self.look(tl1, BUTTON)
        self.look(t5, SPINDLE - [0, 0, 20.0])
        self.side["L"]["wrist"] = hover
        self.transit("L", tr + 0.2, tr + 1.2, self.rest_of("L"))
        self.fingers("L", tr + 0.15, gl["q"])
        self.fingers("L", tr + 0.15 + self.shape_s(gl["q"], self.q_relax), self.q_relax)
        # the right hand holds on while the fingers close, eases off the flange, opens and comes back out
        t8 = tr + 0.35
        t9 = t8 + 0.25
        keys += [(t8, SPINDLE + [0, 0, OVER_MM]), (t9, SPINDLE - [0, 0, EASE_MM])]
        def turned(t):                                      # the grip turned about the holder's axis on the way in
            a = math.radians(YAW_DEG_PER_FORK * self.fork) * min_jerk((t - t2b) / (t3 - t2b))
            return np.array([[math.cos(a), -math.sin(a), 0.0], [math.sin(a), math.cos(a), 0.0], [0.0, 0.0, 1.0]])
        self.follow("R", t_c + 0.05, t9, "holder", at, turned)
        self.load("R", tw0, t8, kg)
        self.effort("R", t8, 0.6, "holder")
        self.effort("R", t9, 0.0, None)
        self.fingers("R", t9, g["q"])
        open_q = open_like(self.hand, g["q"], OPEN_OFF)
        t_open = t9 + self.shape_s(g["q"], open_q)
        self.fingers("R", t_open, open_q)
        H9, W9 = self.grip_pose("holder", SPINDLE - [0, 0, EASE_MM], turned(t9))
        # the fingers open off it first, then the hand draws back along them, toward the body, a little right and
        # down, so the open fingers slide out from round the holder's far side: drawn back with them still round it,
        # they would pass through it, and moved right across its front, they dragged through its body
        out = W9 + turned(t9) @ OUT_MM
        t_out = t_open - 0.1                                # off it as the fingers finish opening
        self.add("R", t9, t_out + 0.45, lambda t: [("pose", H9, W9 + (out - W9) * min_jerk((t - t_out) / 0.45), 2.0)])
        self.side["R"]["wrist"] = out
        clear = self.rest + CLEAR_STAND_MM
        back_s = BACK_S * math.sqrt(max(1.0, (np.linalg.norm(clear - out) + np.linalg.norm(self.rest - clear)) / BACK_MM))
        self.transit("R", t_out + 0.45, t_out + 0.45 + back_s, self.rest, via=[clear])
        t10 = t_out + 0.45 + back_s                         # at rest
        self.fingers("R", t10 - 0.2, self.q_relax)
        self.look(t9 + 0.2, SPINDLE - [0, 0, 40.0])
        self.event("grip", round(t_c, 3), round(t9, 3), side="R", grip="holder", on="holder")
        self.event("carry", round(t_touch, 3), round(t8, 3), side="R", obj="holder", kg=round(kg, 4),
                   loading=[round(tw0, 3), round(tw0 + LOAD_RAMP_S, 3)])
        self.event("seat", round(t5, 3), round(t8, 3), tool=self.tool)
        self.clip("Load the tools", 0.0, t10, f"Load {self.tool}")
        self.t = t10 + 0.2
        self.keys = keys
        return {"path": [[round(t, 3), *np.round(p, 3).tolist()] for t, p in keys]}


class ToolChange(ToolTake, PendantTake):
    """At the pendant, the right index: MDI, T<n> and ATC FWD (`plan_change`), or ATC FWD alone (`plan_atc`)."""

    def __init__(self, out, verbose=True, shared: Path | None = None):
        super().__init__(out, PENDANT_LUMBAR, verbose, shared=shared or Path(out) / "grips.json",
                         grip_source=ToolChange._grip_specs)
        rest_at(self)

    USES = ("keypad_num", "keypad_inc")                  # the keypad regions these keys fall in: the numbers and
                                                         # letters, and the mode and increment keys with ATC FWD

    def _grip_specs(self) -> dict:
        specs = PendantTake._grip_specs(self)
        specs.pop("dial")                                 # no jog in these takes, and no offset pages
        specs.pop("keypad")
        return specs

    def solve_grips(self, specs, source=None, depends=()):
        """Only the grips these takes press with: each takes the hub most of an hour to solve."""
        super().solve_grips({k: v for k, v in specs.items() if k in self.USES}, source, depends)

    def plan_change(self, n: int) -> None:
        """MDI, the tool's number, ATC FWD: the manual's way to call a tool to the spindle (vf2-tool-load phase 1)."""
        self.look(0.0, key_at("mdi"))
        self.wait(0.4)
        self.keys(["mdi"])
        self.look(self.t, SCREEN)
        self.type(f"T{n}")
        self.keys(["atc_fwd"])
        self.look(self.t, CAROUSEL)
        self.rest_hand()
        self.wait(1.0)

    def plan_atc(self) -> None:
        self.look(0.0, key_at("atc_fwd"))
        self.wait(0.4)
        self.keys(["atc_fwd"])
        self.look(self.t, SPINDLE - [0, 0, 60.0])
        self.rest_hand()
        self.wait(0.6)


def build(part: str, step_id: str, only: str | None = None, verbose: bool = True) -> list[Path]:
    """Plan the step's takes (or the one named `only`) into <data root>/takes/<part>/<step id>/<take>/."""
    plan = load_plan(part)
    step = next(s for s in expand(plan) if s["id"] == step_id)
    if step["title"] != "Load the tools":
        raise ValueError(f"{step_id} is {step['title']!r}, not Load the tools")
    root = data_root() / "takes" / part / step_id
    p = part_in_vise(plan, step["setup"])
    seq = sequence(plan, step)
    # the grips the takes share: the pendant's, and Tool Release's for each fork, which the body reaches from where it
    # stands for that fork (door_lumbar)
    shared = {"pendant": root / "pendant-grips.json"} | {
        f"seat{s['fork']}": root / f"seat-grips-fork{s['fork']}.json" for s in seq if s["kind"] == "seat"}
    for f in shared.values():               # every step's takes stand and grip alike: a grip another step solved
        if not f.exists():                  # serves (the cache's key says whether it still does)
            other = sorted(root.parent.glob(f"*/{f.name}"))
            if other:
                root.mkdir(parents=True, exist_ok=True)
                f.write_bytes(other[0].read_bytes())
    made = []
    for s in seq:
        if only and s["name"] != only:
            continue
        out = root / s["name"]
        own = out / "grips.json"
        out.mkdir(parents=True, exist_ok=True)
        extra = {}
        if s["kind"] == "seat":
            seat = shared[f"seat{s['fork']}"]
            if seat.exists():
                own.write_bytes(seat.read_bytes())
            take = Seat(out, s["tool"], s["fork"], len(step["facts"]["tool_ids"]), verbose)
            seat.write_bytes(own.read_bytes())
            extra = take.plan()
        else:
            if shared["pendant"].exists():
                own.write_bytes(shared["pendant"].read_bytes())
            take = ToolChange(out, verbose, shared=shared["pendant"])
            take.plan_change(s["to"]) if s["kind"] == "change" else take.plan_atc()
        take.solve()
        take.save()
        tk = json.loads((out / "take.json").read_text(encoding="utf-8"))
        spindle_tool = PROBE if s["spindle"] == "probe" else None
        tk |= {"step": step, "card": CARD, "load": s | extra,
               "setup": p | {"tool": spindle_tool, "setup_mode": True, "mode": "mdi" if s["kind"] != "change" else "",
                             "tool_length": {str(PROBE["number"]): PROBE["length_mm"]}}}
        (out / "take.json").write_text(json.dumps(tk, indent=1), encoding="utf-8")
        if verbose:
            print(f"{step_id}/{s['name']}: {take.t:.1f} s, {sum(e['kind'] == 'press' for e in take.events)} presses")
        made.append(out)
    return made


if __name__ == "__main__":
    if sys.argv[1] == "--fit-grip":                      # python -m moonshot.motion.tool_load --fit-grip [tool]
        print(fit_holder_grip(*sys.argv[2:3]))
    else:
        build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
