"""Load the tools (a VF-2 setup's step 7; the vf2-tool-load card): every tool the setup uses first goes into the
carousel through the spindle, as Haas's manual has it for the umbrella changer. The step is a run of takes cut
together, as the body model doesn't walk (the declared cut of moonshot/motion/door_cycle.py): at the pendant, MDI
T<n> M06 and Cycle Start put the probe away and bring pocket n to the spindle, empty; then, for each tool, standing in
the doorway the right hand takes its holder off the tool stand on the table, carries it in under the spindle and pushes it up into the
spindle while the left holds the head's Tool Release button, lets go of the button so the drawbar clamps, and lets
go of the holder (`Seat`); and at the pendant ATC FWD puts it in its pocket and brings the next one (`ToolChange`).

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
from moonshot.motion.pendant import LUMBAR as PENDANT_LUMBAR, OFFSET, PendantTake, key_at
from moonshot.motion.primitives import PosePath, min_jerk, open_for, open_like
from moonshot.motion.setting import PROBE, SCREEN, part_in_vise
from moonshot.motion.step_take import StepTake
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
BELOW_MM = 80.0                                          # the holder carried in to this far below its seat, clear of
                                                         # the bore, and lined up there before it goes up
SHORT_MM = 25.0                                          # pushed up to this far short before Tool Release opens the
                                                         # drawbar: the knob stops 10 mm under the closed fingers
OVER_MM = 1.0                                            # and pushed this far past the seat, which stops it
EASE_MM = 1.5                                            # the hand eases this far down once the drawbar holds it
LIFT_MM = 2.5                                            # off the stand's tines, and slid out toward the operator
SLIDE_MM = 68.0
CLEAR_UP_MM = 200.0                                      # then up, so its tool clears the part and the vise
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


def holder_grip(tool_id: str) -> dict:
    """The grip a holder is carried in (holder_grip.json): its tool's own, else the default."""
    kept = json.loads(HOLDER_GRIP.read_text(encoding="utf-8"))
    return kept["grips"].get(tool_id, kept["grips"][kept["default"]])


class Seat(StepTake):
    """One holder off the stand and into the spindle (the vf2-tool-load card's phases 2-7)."""

    def __init__(self, out, tool_id: str, fork: int, n_forks: int, verbose=True):
        super().__init__(out, DOOR_LUMBAR, verbose)
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

        t_on, t_near, t_c = 0.2, 0.6, 0.82                 # reach onset, at the pre-grasp, contact
        pre = Wg + [12.0, -60.0, -4.0]           # in front of the holder and right of it: the open fingers go past its side
        self.look(0.0, P0 + [0, 0, -30.0])
        self.transit("R", t_on, t_near, pre, fade=(H, 2.0))
        size = 2 * TL.BODY[0]
        self.fingers("R", t_on + 0.05, open_like(self.hand, g["q"], 0.2))
        self.fingers("R", t_on + 0.74 * (t_c - t_on), open_for(self.hand, g["q"], size))
        self.add("R", t_near, t_c + 0.05, lambda t: [("pose", H, pre + (Wg - pre) * min_jerk((t - t_near) / (t_c - t_near)), 2.0)])
        self.fingers("R", t_c + 0.12, g["q"])
        self.effort("R", t_c, 0.0, "holder")
        self.effort("R", t_c + 0.2, 0.6, "holder")
        # off the tines, out of the fork toward the operator, up clear of the part, and in under the spindle
        t1, t2, t2b, t3 = t_c + 0.42, t_c + 0.85, t_c + 1.35, t_c + 2.45
        slid = P0 + [0, -SLIDE_MM, LIFT_MM]
        keys += [(t_c + 0.12, P0), (t1, P0 + [0, 0, LIFT_MM]), (t2, slid), (t2b, slid + [0, 0, CLEAR_UP_MM]),
                 (t3, SPINDLE - [0, 0, BELOW_MM])]
        self.look(t_c + 0.5, SPINDLE - [0, 0, 60.0])
        t4 = t3 + 0.6                                       # lined up under it, by eye
        t5 = t4 + 0.4
        keys += [(t4, SPINDLE - [0, 0, BELOW_MM]), (t5, SPINDLE - [0, 0, SHORT_MM])]
        # the left hand to the button, pressed and held while the right pushes the holder home
        gl = self.grips["release"]
        HL, WL = gl["H"], gl["W"]                        # in the mirrored world, as solved
        WL_on = WL + [0, -1.0, 0]
        hover = WL_on + [0, -40.0, 0]
        tl0, tl1 = t3 - 0.7, t4 + 0.15
        self.transit("L", tl0, tl1, self.at("L", hover), fade=(HL, 1.0))
        self.fingers("L", tl0 + 0.1, gl["q"])
        tp = t5 + 0.05
        t6 = tp + 0.35                                      # the drawbar open: pushed up past the seat
        t7 = t6 + 0.45
        keys += [(t6, SPINDLE + [0, 0, OVER_MM]), (t7, SPINDLE + [0, 0, OVER_MM])]
        tr = t7 + 0.05                                      # Tool Release let go: the drawbar clamps
        path = PosePath(HL, hover).to(tl1, tp - tl1, HL, WL_on).to(tr, 0.15, HL, hover)
        self.add("L", tl1, tr + 0.15, lambda t, path=path: [("pose", *path.at(t), 3.0)])
        self.event("press", round(tp + 0.05, 3), round(tr, 3), side="L", key="tool_release_head",
                   force=REC["affordances"]["tool_release_head"]["force_n"], normal=[0.0, 1.0, 0.0], hold=True)
        self.look(tl1, BUTTON)
        self.look(t5, SPINDLE - [0, 0, 20.0])
        self.side["L"]["wrist"] = hover
        self.transit("L", tr + 0.2, tr + 1.2, self.rest_of("L"))
        self.fingers("L", tr + 0.4, self.q_relax)
        # the right hand holds on while the fingers close, eases off the flange, opens and comes back out
        t8 = tr + 0.35
        t9 = t8 + 0.25
        keys += [(t8, SPINDLE + [0, 0, OVER_MM]), (t9, SPINDLE - [0, 0, EASE_MM])]
        self.follow("R", t_c + 0.05, t9, "holder", at)
        self.load("R", t_c + 0.3, t8, kg)
        self.effort("R", t8, 0.6, "holder")
        self.effort("R", t9, 0.0, None)
        self.fingers("R", t9, g["q"])
        open_q = open_like(self.hand, g["q"], 0.6)
        self.fingers("R", t9 + 0.25, open_q)
        _, W9 = self.grip_pose("holder", SPINDLE - [0, 0, EASE_MM])
        out = W9 + [30.0, -50.0, -30.0]                     # out to the right, back and down, off the holder
        self.add("R", t9, t9 + 0.4, lambda t: [("pose", H, W9 + (out - W9) * min_jerk((t - t9) / 0.4), 2.0)])
        self.side["R"]["wrist"] = out
        self.transit("R", t9 + 0.4, t9 + 1.4, self.rest)
        self.fingers("R", t9 + 1.2, self.q_relax)
        self.look(t9 + 0.2, SPINDLE - [0, 0, 40.0])
        self.event("grip", round(t_c, 3), round(t9, 3), side="R", grip="holder", on="holder")
        self.event("carry", round(t_c + 0.12, 3), round(t8, 3), side="R", kg=round(kg, 4))
        self.event("seat", round(t5, 3), round(t8, 3), tool=self.tool)
        self.clip("Load the tools", 0.0, t9 + 1.4, f"Load {self.tool}")
        self.t = t9 + 1.6
        self.keys = keys
        return {"path": [[round(t, 3), *np.round(p, 3).tolist()] for t, p in keys]}


class ToolChange(PendantTake):
    """At the pendant: MDI T<n> M06 and Cycle Start (the left hand, the right over Feed Hold), or ATC FWD."""

    def __init__(self, out, verbose=True, shared: Path | None = None):
        super().__init__(out, PENDANT_LUMBAR, verbose, shared=shared or Path(out) / "grips.json",
                         grip_source=ToolChange._grip_specs)

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
    shared = {"seat": root / "seat-grips.json", "pendant": root / "pendant-grips.json"}
    made = []
    for s in seq:
        if only and s["name"] != only:
            continue
        out = root / s["name"]
        extra = {}
        if s["kind"] == "seat":
            own = out / "grips.json"
            out.mkdir(parents=True, exist_ok=True)
            if shared["seat"].exists():
                own.write_bytes(shared["seat"].read_bytes())
            take = Seat(out, s["tool"], s["fork"], len(step["facts"]["tool_ids"]), verbose)
            shared["seat"].write_bytes(own.read_bytes())
            extra = take.plan()
        else:
            out.mkdir(parents=True, exist_ok=True)
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
