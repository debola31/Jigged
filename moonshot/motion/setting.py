"""Setting a part up on the VF-2 (plan §4; the vf2-controls card): the motion of a setup's "Find X and Y" and "Set Z"
steps at the pendant (moonshot/motion/pendant.py), and the datum each axis's zero must land on; and of "Check it's
square", where a setup stands the part on the vise floor, the test indicator swept up its side.

    python -m moonshot.motion.setting nist-ftc-10 op10-xy      # plans <data root>/takes/nist-ftc-10/op10-xy

The setup's part stands clamped in the vise as its "Load the part" step left it; the plan knows where its faces are,
as the operator does by eye, so it plans each jog to the click: coarse at .1 to stand the tool off a face, .01 to
close in, and .001 until the edge finder trips (the card's phases), which the physics then has to reproduce.

take.json gets, beside the events: "setup" (what the physics run builds: the part's centre and half-size, the
parallels, the tool in the spindle, setup mode), and "sets" (per axis: the method and the datum's world point at the
take's first frame), which moonshot/tests/gates/test_setting_takes.py holds the run to.
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np

from moonshot.config import data_root
from moonshot.motion.loads import FACE_A_MM, part_pose, vise_load
from moonshot.motion.pendant import STROKE_DEG_S, PendantTake, key_at
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan
from moonshot.world import vf2, vise

INC = {"inc_0.1": 0.1 * vf2.INCH, "inc_0.01": 0.01 * vf2.INCH, "inc_0.001": 0.001 * vf2.INCH}
SPINDLE = np.array(vf2.record()["joints"]["spindle"]["centre_mm"], float) + [-381.0, 0, 0]   # the gauge line at home
# the edge finder (library/records/assets/tooling/edgef) in a CAT40 end mill holder (cat40: 1.75 in gauge length, 1.25
# in body): 79 mm long, its 0.5 in shank 25 mm in the holder [proposed], its 0.2 in tip 9 mm long [proposed]
EDGE_FINDER = {"name": "edge finder", "holder_mm": 44.45, "holder_r": 15.875, "shank_r": 6.35, "stickout_mm": 54.0,
               "tip_r": 2.54, "tip_mm": 9.0}
EDGE_FINDER["length_mm"] = EDGE_FINDER["holder_mm"] + EDGE_FINDER["stickout_mm"]
# the Renishaw OMP40-2 (library/records/assets/workholding/probe) as tool 20: its shank and 40 mm body 85 mm below the
# gauge line, a 50 mm stylus [proposed]; a 2 mm ball [proposed: the record's 6 mm ball can't enter Op 20's 6 mm ear holes]
PROBE = {"name": "spindle probe", "number": 20, "holder_mm": 85.0, "holder_r": 20.0, "shank_r": 2.0, "stickout_mm": 50.0,
         "tip_r": 1.0, "tip_mm": 2.0, "ball": True}
PROBE["length_mm"] = PROBE["holder_mm"] + PROBE["stickout_mm"]
# the lever test indicator (library/records/assets/inspection/dti: Mitutoyo 513-404, its 8 mm stem, a 2 mm ball) in an
# indicator holder in the spindle, as Haas mounts one (the dti-sweep-face card's footage): its ball on a level stylus
# 35 mm off the spindle's axis, so the holder stands clear of the face it sweeps [proposed: the lengths, the reach]
INDICATOR = {"name": "test indicator", "holder_mm": 60.0, "holder_r": 15.875, "shank_r": 4.0, "stickout_mm": 50.0,
             "tip_r": 1.0, "tip_mm": 2.0, "stylus_r": 0.75, "offset_mm": [35.0, 0.0]}
INDICATOR["length_mm"] = INDICATOR["holder_mm"] + INDICATOR["stickout_mm"]
PRELOAD_MM = 0.2            # the dti-sweep-face card's: the needle about 20 divisions in
SWEEP_MM = 75.0             # the card's sweep, about the side the part shows above the jaws
STANDOFF_MM = 6.0           # how far off a face the coarse jog stops: a click at .1 short of it is 2.5 mm
CLOSE_MM = 0.3              # and the .01 jog: a click at .01 short of it is 0.25 mm
APPROACH_MM = 1.5           # a fine move's .1 jog stops this short, so its rounding (a click is 2.54 mm) never passes
Y_TRAVEL_MM = vf2.record()["joints"]["y"]["range_mm"][1]   # the spindle reaches this far toward the operator
STEM_CLEAR_MM = 2.0         # a straight check's indicator stem stands this far off the edge it sweeps
BELOW_TOP_MM = 3.0          # how far below the top the tip runs along a face
SCREEN = np.array([915.0, -986.3, 1650.0]) + [-381.0, 0, 0]
JAW_TOP_MM = 970.3


def part_in_vise(plan: dict, setup_id: str) -> dict:
    """The part as the setup clamps it: centre and half-size (world mm, the table at its loading position), the
    parallels' base centres and height, and the jaw opening."""
    load, pose = vise_load(plan, setup_id), part_pose(plan, setup_id)
    return {"centre_mm": pose["centre_mm"].tolist(), "half_mm": (pose["size_mm"] / 2).tolist(), "R": pose["R"].tolist(),
            "origin_mm": pose["origin_mm"].tolist(), "load": load.to_json(),
            "parallels": {k: v.tolist() for k, v in load.parallels().items()}}


def part_on_table(plan: dict, setup_id: str) -> dict:
    """A plate on the spoilboard (moonshot/motion/plates.py): its box as part_in_vise gives the vise's part, and which
    plate and clamps the physics run builds."""
    pose = part_pose(plan, setup_id)
    return {"centre_mm": pose["centre_mm"].tolist(), "half_mm": (pose["size_mm"] / 2).tolist(), "R": pose["R"].tolist(),
            "origin_mm": pose["origin_mm"].tolist(), "plate": {"part": plan["part"], "setup": setup_id}}


def clicks(mm: float, inc: str) -> int:
    return round(mm / INC[inc])


class XYEdgeFinder:
    """Find X and Y with the edge finder (vf2-controls phases 1-8), the zero at the centre of the stock's length and
    width: each from the left and the front face, then the half-size keyed onto the offset."""

    def __init__(self, take: PendantTake, part: dict):
        self.k, self.p = take, part
        c, h = np.array(part["centre_mm"]), np.array(part["half_mm"])
        self.c, self.h, ef = c, h, EDGE_FINDER
        self.tip0 = SPINDLE[2] - ef["length_mm"]              # the tip's bottom at machine Z = 0
        # spindle relative to the part (world mm), as machine X and Y move it: +X moves the table left, so the
        # spindle right across the part; +Y the table toward the operator, so the spindle away
        self.rel = SPINDLE[:2] - c[:2]

    def where(self):
        """The tip relative to the part now, as the plan has it: x, y of the spindle, and the tip's bottom z."""
        a = self.k.axis_mm
        return self.rel[0] + a[0], self.rel[1] + a[1], self.tip0 + a[2]

    def jog(self, axis: str, mm: float, inc: str) -> None:
        """Select the axis and increment as needed, then turn the handle for `mm` of travel at that increment."""
        k = self.k
        keys = ([] if k.jog_axis == axis else [f"+{axis}"]) + ([] if math.isclose(k.inc_mm, INC[inc]) else [inc])
        k.keys(keys)
        k.look(k.t, self.tip_world())
        k.turn(clicks(mm, inc), 150.0 if inc == "inc_0.001" else STROKE_DEG_S)

    def tip_world(self):
        x, y, z = self.where()
        return np.array([SPINDLE[0], SPINDLE[1], z])

    def find(self, axis: str) -> None:
        """Stand off the face at -axis below the top, close in at .01, then at .001 until the tip touches it;
        lift clear and one turn at .001 puts the spindle over the edge."""
        i, r = "xy".index(axis), EDGE_FINDER["tip_r"]
        x, y, z = self.where()
        here = (x, y)[i]
        face = -self.h[i]
        self.jog(axis, (face - r - STANDOFF_MM) - here, "inc_0.1")
        self.jog("z", (self.c[2] + self.h[2] - BELOW_TOP_MM) - z, "inc_0.1")
        gap = face - r - self.where()[i]
        self.jog(axis, max(0.0, gap - CLOSE_MM), "inc_0.01")
        gap = face - r - self.where()[i]
        n = math.ceil(gap / INC["inc_0.001"] - 1e-9)
        self.jog(axis, n * INC["inc_0.001"], "inc_0.001")      # the click at which it trips
        self.jog("z", 4 * INC["inc_0.1"], "inc_0.1")
        self.jog(axis, 100 * INC["inc_0.001"], "inc_0.001")    # one full turn: 0.100 in

    def plan(self) -> dict:
        k = self.k
        k.look(0.0, key_at("mdi"))
        k.wait(0.5)
        k.keys(["mdi"])
        k.type("S1200 M03")
        k.keys(["enter", "cycle_start", "handle_jog", "inc_0.1"])
        k.inc_mm = INC["inc_0.1"]
        # over the part's middle in Y, outside its left end, then find the left face
        self.jog("y", -self.where()[1], "inc_0.1")
        self.find("x")
        k.look(k.t, SCREEN)
        k.keys(["offset", "part_zero_set"])
        k.type(f"{self.h[0]:.2f}")
        k.keys(["enter"])
        # over the part's middle in X, outside its front face, then find it
        self.jog("x", -self.where()[0], "inc_0.1")
        self.find("y")
        k.look(k.t, SCREEN)
        k.keys(["right", "part_zero_set"])
        k.type(f"{self.h[1]:.3f}".rstrip("0"))
        k.keys(["enter", "reset"])
        k.rest_hand()
        k.wait(0.5)
        return {"x": {"method": "edge_finder", "datum_mm": self.c.tolist()},
                "y": {"method": "edge_finder", "datum_mm": self.c.tolist()}}


class Probing:
    """Find X and Y, or Set Z, with the spindle probe: jog the ball beside a face or into a bore (.1, then .01 to place
    it in a bore), choose the cycle in VPS and output it to MDI (the vf2-tool-setter card's phases 1-2, for the work
    offset), then the left hand presses Cycle Start with the right over Feed Hold (vf2-controls phases 18-19); hands
    off while it measures; and key in the shift from what it touched to the datum."""

    def __init__(self, take: PendantTake, part: dict, features: dict):
        self.k, self.p, self.f = take, part, features
        self.c, self.h = np.array(part["centre_mm"]), np.array(part["half_mm"])
        self.top = self.c[2] + self.h[2]
        self.ball0 = SPINDLE[2] - PROBE["length_mm"] + PROBE["tip_r"]       # the ball's centre at machine Z = 0
        self.vps: list[dict] = []
        self.page = ""

    def ball(self) -> np.ndarray:
        """The ball's centre among the part's frame-0 positions: machine X and Y move the spindle across the part."""
        a = self.k.axis_mm
        return np.array([SPINDLE[0] + a[0], SPINDLE[1] + a[1], self.ball0 + a[2]])

    def jog(self, axis: str, mm: float, inc: str) -> None:
        k = self.k
        k.keys(([] if k.jog_axis == axis else [f"+{axis}"]) + ([] if math.isclose(k.inc_mm, INC[inc]) else [inc]))
        k.look(k.t, self.ball() * [1, 1, 1])
        k.turn(clicks(mm, inc), STROKE_DEG_S)

    def to(self, target, fine: bool = False, fine_z: bool = False) -> None:
        """The ball over to a point: up clear of the part first if it has to cross it, across in X and Y, then down
        (and at .01 for fine, fine_z: in a bore, beside a 3 mm sheet's edge)."""
        target = np.asarray(target, float)
        if self.ball()[2] < self.top + 10 and np.linalg.norm(target[:2] - self.ball()[:2]) > 1:
            self.jog("z", self.top + 15 - self.ball()[2], "inc_0.1")
        for i, a in enumerate("xy"):
            if fine:
                approach(self, a, target[i])
            else:
                self.jog(a, target[i] - self.ball()[i], "inc_0.1")
        if fine_z:
            approach(self, "z", target[2])
        else:
            self.jog("z", target[2] - self.ball()[2], "inc_0.1")

    def cycle(self, template: str, wait_s: float, **values) -> None:
        """Choose the cycle in VPS, output it to MDI, start it with the left hand over Feed Hold, and wait it out."""
        k = self.k
        k.look(k.t, SCREEN)
        k.keys(["edit", "down", "down", "enter", "down", "enter"] + ["right"] * {"surface": 1, "bore": 2}[template]
               + ["enter", "f4"])
        self.page = "vps"
        self.vps.append({"template": template, "ball_r": PROBE["tip_r"]} | values)
        k.press_left("cycle_start", hover_right="feed_hold")
        k.look(k.t, self.ball())
        k.wait(wait_s)
        k.release_left()

    def shift(self, axis: str, mm: float) -> None:
        """Add mm to G54's axis on the work offsets page."""
        k = self.k
        if self.page != "work":
            k.keys(["offset"])
            self.page, k.cursor = "work", 0
        i = "xyz".index(axis)
        k.keys((["right"] if i > k.cursor else ["left"]) * abs(i - k.cursor))
        k.cursor = i
        if abs(mm) > 1e-6:
            k.type(f"{mm:.3f}".rstrip("0").rstrip("."))
            k.keys(["enter"])

    def surface(self, axis: str, face: np.ndarray, normal: np.ndarray, datum: float, z: float,
                standoff: float = 2 * STANDOFF_MM, fine: bool = False) -> None:
        """A single-surface cycle on the face through `face` with outward `normal` (world, along axis), then the shift
        to the datum's coordinate on that axis. The ball starts `standoff` mm off the face, placed at .01 if fine."""
        i = "xyz".index(axis)
        stand = face + normal * (PROBE["tip_r"] + standoff)
        if axis != "z":
            stand[2] = z
        self.to(stand, fine=fine, fine_z=fine)
        self.cycle("surface", 4.0, axis=axis, sign=int(-normal[i]))
        self.shift(axis, datum - face[i])
        if axis != "z":
            self.jog("z", self.top + 15 - self.ball()[2], "inc_0.1")

    def bore(self, centre: np.ndarray, z: float, datum: np.ndarray, axes: str = "xy") -> None:
        """A bore cycle with the ball at z in a vertical bore; the zero shifted from its centre to the datum, on the
        axes the bore gives."""
        self.to([centre[0], centre[1], z], fine=True)
        self.cycle("bore", 12.0)
        for a in axes:
            self.shift(a, datum["xy".index(a)] - centre["xy".index(a)])
        self.jog("z", self.top + 15 - self.ball()[2], "inc_0.1")

    def plan(self, axes: str) -> dict:
        k, f = self.k, self.f
        k.look(0.0, key_at("handle_jog"))
        k.wait(0.5)
        k.keys(["handle_jog", "inc_0.1"])
        sets = {}
        if axes == "xy":
            if "bore" in f:
                self.bore(np.array(f["bore"]["centre_mm"]), f["bore"]["z_mm"], np.array(f["datum_mm"]),
                          "".join(a for a in "xy" if a not in f))
            for a in ("x", "y"):
                if a in f:
                    s = f[a]
                    self.surface(a, np.array(s["face_mm"]), np.array(s["normal"]), f["datum_mm"]["xy".index(a)],
                                 s["z_mm"], s.get("standoff_mm", 2 * STANDOFF_MM), s.get("fine", False))
            sets = {a: {"method": "probe", "datum_mm": list(f["datum_mm"])} for a in "xy"}
        else:
            top = np.array([*f["z"]["at_xy"], f["z"].get("z_mm", self.top)])
            self.surface("z", top, np.array([0, 0, 1.0]), f["datum_mm"][2], 0.0)
            self.jog("z", -k.axis_mm[2], "inc_0.1")             # back up to home
            sets = {"z": {"method": "probe", "datum_mm": list(f["datum_mm"])}}
        k.rest_hand()
        k.wait(0.5)
        return sets


class SquareCheck:
    """Check it's square with the test indicator in the spindle (the dti-sweep-face card, phases 6-11): its ball
    beside the part's left side just above the jaws, in at .001 to the card's preload, up the side by Z at .01 while
    the eyes stay on the needle, a look at it at the top, then back off the side and up to home.

    Where a stop stands against the left side (moonshot/world/vise.py Load.stop), the right side is swept instead,
    from low between the jaws, the indicator turned in the spindle to face it (SQUARE)."""

    def __init__(self, take: PendantTake, part: dict, side: int = -1, from_z: float = JAW_TOP_MM + 6.0,
                 sweep_mm: float = SWEEP_MM):
        self.k, self.c, self.h = take, np.array(part["centre_mm"]), np.array(part["half_mm"])
        self.side, self.from_z, self.sweep_mm = side, from_z, sweep_mm
        self.tool = INDICATOR | {"offset_mm": [-side * INDICATOR["offset_mm"][0], 0.0]}
        self.ball0 = SPINDLE + [*self.tool["offset_mm"], -INDICATOR["length_mm"] + INDICATOR["tip_r"]]

    def ball(self) -> np.ndarray:
        """The ball's centre among the part's frame-0 positions, as machine X, Y and Z move it."""
        return self.ball0 + self.k.axis_mm

    def jog(self, axis: str, mm: float, inc: str, deg_s: float = STROKE_DEG_S) -> None:
        k = self.k
        k.keys(([] if k.jog_axis == axis else [f"+{axis}"]) + ([] if math.isclose(k.inc_mm, INC[inc]) else [inc]))
        k.look(k.t, self.ball())
        k.turn(clicks(mm, inc), deg_s)

    def plan(self) -> dict:
        k, r, side = self.k, INDICATOR["tip_r"], self.side
        face = self.c[0] + side * self.h[0]
        gap = lambda: side * (self.ball()[0] - face) - r          # noqa: E731  the ball off the face
        k.look(0.0, key_at("handle_jog"))
        k.wait(0.5)
        k.keys(["handle_jog", "inc_0.1"])
        k.inc_mm = INC["inc_0.1"]
        self.jog("y", self.c[1] - self.ball()[1], "inc_0.1")
        self.jog("x", face + side * (r + STANDOFF_MM) - self.ball()[0], "inc_0.1")
        self.jog("z", self.from_z - self.ball()[2], "inc_0.1")
        self.jog("x", -side * max(0.0, gap() - CLOSE_MM), "inc_0.01")
        self.jog("x", -side * (gap() + PRELOAD_MM), "inc_0.001", 150.0)
        self.jog("z", self.sweep_mm, "inc_0.01", 200.0)
        k.look(k.t, self.ball())
        k.wait(1.0)
        self.jog("x", side * 2 * INC["inc_0.1"], "inc_0.1")
        self.jog("z", -k.axis_mm[2], "inc_0.1")
        k.rest_hand()
        k.wait(0.5)
        return {}


def approach(s, axis: str, to: float) -> None:
    """s's ball (a Probing's, a StraightCheck's) to `to` along axis: at .1 to short of it, a click's rounding never
    taking it past (into a sheet, past the Y travel's front), then at .01."""
    i = "xyz".index(axis)
    d = to - s.ball()[i]
    if abs(d) > APPROACH_MM:
        s.jog(axis, d - math.copysign(APPROACH_MM, d), "inc_0.1")
    s.jog(axis, to - s.ball()[i], "inc_0.01")


class StraightCheck:
    """Check it's straight: a plate's near long edge swept along X by the test indicator, as SquareCheck sweeps a side
    up Z: the ball beside the edge at mid-thickness, in at .001 to the preload, along the edge at .01 between its clamps,
    a look at the needle, then back off and up to home.

    The indicator is turned in the spindle so its stylus runs along the edge and a little out from it, its stem, which
    reaches down to the ball's height, STEM_CLEAR_MM off the edge. Where the Y travel's front leaves no room for that
    (ll-1005337's plate is the travel's width) the stem stands as far forward as it reaches and the ball sweeps 1.5 mm
    under the top, the stem over the edge's top corner by the rest [declared shortcut: the real lever angles down to
    its ball]."""

    def __init__(self, take: PendantTake, part: dict):
        self.k, self.c, self.h = take, np.array(part["centre_mm"]), np.array(part["half_mm"])
        r, face = INDICATOR["tip_r"], self.c[1] - self.h[1]
        self.front = SPINDLE[1] - Y_TRAVEL_MM + 0.3             # the spindle's nearest reach, less a margin
        out = min(INDICATOR["shank_r"] + STEM_CLEAR_MM - r, face - r - self.front - 0.7)
        self.tool = INDICATOR | {"offset_mm": [math.sqrt(INDICATOR["offset_mm"][0] ** 2 - out ** 2), out]}
        top = self.c[2] + self.h[2]
        self.z = top - (self.h[2] if out >= INDICATOR["shank_r"] - r else 1.5)
        self.ball0 = SPINDLE + [*self.tool["offset_mm"], -INDICATOR["length_mm"] + r]

    def ball(self) -> np.ndarray:
        return self.ball0 + self.k.axis_mm

    def jog(self, axis: str, mm: float, inc: str, deg_s: float = STROKE_DEG_S) -> None:
        k = self.k
        k.keys(([] if k.jog_axis == axis else [f"+{axis}"]) + ([] if math.isclose(k.inc_mm, INC[inc]) else [inc]))
        k.look(k.t, self.ball())
        k.turn(clicks(mm, inc), deg_s)

    def plan(self) -> dict:
        k, r = self.k, INDICATOR["tip_r"]
        face = self.c[1] - self.h[1]
        gap = lambda: face - self.ball()[1] - r                    # noqa: E731  the ball off the edge
        stand = min(STANDOFF_MM, face - r - (self.front + self.tool["offset_mm"][1]))
        k.look(0.0, key_at("handle_jog"))
        k.wait(0.5)
        k.keys(["handle_jog", "inc_0.1"])
        k.inc_mm = INC["inc_0.1"]
        self.jog("x", self.c[0] - SWEEP_MM / 2 - self.ball()[0], "inc_0.1")
        approach(self, "y", face - r - stand)
        approach(self, "z", self.z)
        self.jog("y", max(0.0, gap() - CLOSE_MM), "inc_0.01")
        self.jog("y", gap() + PRELOAD_MM, "inc_0.001", 150.0)
        self.jog("x", SWEEP_MM, "inc_0.01", 200.0)
        k.look(k.t, self.ball())
        k.wait(1.0)
        self.jog("y", -(stand + PRELOAD_MM), "inc_0.01")
        up = -k.axis_mm[2]                                         # home: whole clicks at .1, the rest at .01
        self.jog("z", math.trunc(up / INC["inc_0.1"]) * INC["inc_0.1"], "inc_0.1")
        self.jog("z", -k.axis_mm[2], "inc_0.01")
        k.rest_hand()
        k.wait(0.5)
        return {}


def probe_features(plan: dict, setup_id: str) -> dict:
    """What each setup of nist-ftc-10 probes, and where its zero is (world mm, frame 0), from the plan's wcs.

    The plan's X and Y are the machine's. Op 50 stands the part on end with datum A facing along X, so datum A
    can't give Y as its wcs says: there it gives X, and the front face Y. The bar parts' are in PROBES."""
    if (plan["part"], setup_id) in PROBES:
        return g1_features(plan, setup_id)
    pose = part_pose(plan, setup_id)
    R, O, c, h = pose["R"], pose["origin_mm"], pose["centre_mm"], pose["size_mm"] / 2
    world = lambda p: O + R @ np.asarray(p, float)           # noqa: E731  a point of the part's model
    top, bottom = c[2] + h[2], c[2] - h[2]
    faces = {f"{s}{a}": (c + np.eye(3)[i] * (1 if s == "+" else -1) * h[i], np.eye(3)[i] * (1 if s == "+" else -1))
             for i, a in enumerate("xy") for s in "+-"}
    datum_a = next((k for k, (_, n) in faces.items() if np.allclose(n, R @ [0, -1.0, 0])), None)
    surface = lambda name, z: {"face_mm": faces[name][0].tolist(), "normal": faces[name][1].tolist(), "z_mm": z}   # noqa: E731
    side_z = float(max(JAW_TOP_MM + 6.0, top - 10.0))         # a clamped face shows above the jaws
    out = {"z": {"at_xy": (c[:2] + [h[0] / 2, 0]).tolist()}}
    if setup_id == "op20":                                   # an ear hole; the zero at the holes' pattern's centre
        hole = world([-70.0, 3.0, -28.5])
        out["bore"] = {"centre_mm": hole[:2].tolist(), "z_mm": float(hole[2]), "r_mm": 3.0, "top_z_mm": float(top)}
        xy = world([0.0, 0.0, 0.0])[:2]
    elif setup_id in ("op30", "op40"):                       # the left end (op 40: a Ø7 bore) for X, datum A for Y
        if setup_id == "op40":
            b = world([-52.0, 23.0, 0.0])
            out["bore"] = {"centre_mm": b[:2].tolist(), "z_mm": float(top - 8.0), "r_mm": 3.5, "top_z_mm": float(top)}
            x = b[0]
        else:
            out["x"] = surface("-x", float(top - 10.0))
            x = faces["-x"][0][0]
        out["y"] = surface(datum_a, side_z)
        xy = [x, faces[datum_a][0][1]]
    elif setup_id == "op50":
        out["x"] = surface(datum_a, float(top - 10.0))
        out["y"] = surface("-y", side_z)
        xy = [faces[datum_a][0][0], faces["-y"][0][1]]
    else:
        xy = c[:2]
    z = {"op10": top - FACE_A_MM.get(plan["part"], 0.0), "op20": bottom + 31.0}.get(setup_id, top)
    out["datum_mm"] = [float(xy[0]), float(xy[1]), float(z)]
    return out


# What the bar parts' setups probe (planning/plans/<part>.json wcs), in each model's frame (mm): per axis, a point on
# the face the ball touches and the face's outward normal; for z, the point it comes down on (the box's top, off its
# middle, if none); and the zero's point. A side's touch stands 10 mm below the top, above the jaws.
PROBES = {
    ("ct-slbeam", "op10"): {"datum": (38.1, 19.05, -3.175)},                     # the top of the blank
    ("ct-slbeam", "op20"): {"x": ((69.375, 19.05, 0.0), "-Z"), "y": ((69.375, 0.0, 26.99), "-Y"),
                            "datum": (79.375, 0.0, 0.0)},                        # the faced bottom; the top of the end
    ("ct-slbeam", "op30"): {"x": ((6.825, 19.05, 0.0), "-Z"), "y": ((6.825, 0.0, 26.99), "-Y"),
                            "datum": (0.0, 0.0, 0.0)},                           # the vise floor, plus 76.2
    ("ct-slbeam", "op40"): {"x": ((0.0, 19.05, 43.975), "-X"), "y": ((38.1, 0.0, 43.975), "-Y"),
                            "datum": (0.0, 0.0, 50.8)},                          # the back; the bottom, plus 50.8
    ("ll-1007223", "op10"): {"datum": (24.5, 40.0, 0.0)},                        # the top of the faced stock
    # Op 20 off the fixed soft jaw (the user's decision, 2026-11-04): its end, and its face past the part's end, as
    # world points (FIXED_JAW); the zero at the finished end and the flange's edge, the top on the parallels plus 40
    ("ll-1007223", "op20"): {"x": "jaw_end", "y": "jaw_face", "datum": (0.0, 0.0, -37.5)},
    # Op 30 on its flange's edge: X off the top, Y off the end above the fixed jaw (the flange, below the top's
    # chamfer), Z off the stem's side, down in the T's notch: a cut in the box that the probe senses through
    ("ll-1007223", "op30"): {"x": ((10.0, 40.0, 0.0), "+Y"), "y": ((2.4, 33.0, -37.5), "-Z"),
                             "z": (24.0, 10.0, 0.0), "cuts": [((-50.0, 24.0), (-50.0, 20.0), (-60.0, 60.0))],
                             "datum": (24.0, 40.0, -37.5)},
}
# The plates (moonshot/motion/plates.py), on the spoilboard, probed as their plans say ("probe in X, Y and Z"): the
# stock's -x end, between its clamps, and its near edge, each at mid-thickness and placed at .01 (nist-ftc-09's sheet
# is 3.04 mm), the zero at the stock's middle, its top. ll-1005337's 406.4 mm plate is the Y travel's width: in front
# of its near edge the spindle has 3.65 mm, so the ball stands 2 mm off it, not 13.
PROBES |= {
    ("nist-ftc-09", "op10"): {"x": ((-51.5, 1.52, -171.45), "-Z", {"fine": True}),
                              "y": ((-127.0, 1.52, 0.0), "-X", {"fine": True}), "datum": (0.0, 3.04, 0.0)},
    ("ll-1005337", "op10"): {"x": ((-212.25, 630.2, -10.475), "+Y", {"fine": True}),
                             "y": ((-403.2, 300.0, -10.475), "-X", {"fine": True, "standoff_mm": 2.0}),
                             "datum": (-200.0, 300.0, -0.95)},
}
# the fixed jaw's -x end, and its face 17 mm past the end of a part up to 83 mm long: 5 and 3 mm below its top
FIXED_JAW = {"jaw_end": ([vise.VISE["x"] - vise.VISE["half_width"], vise.VISE["fixed_face_y"] + 20.0, JAW_TOP_MM - 5.0],
                         [-1.0, 0.0, 0.0]),
             "jaw_face": ([vise.VISE["x"] - 58.7, vise.VISE["fixed_face_y"], JAW_TOP_MM - 3.0], [0.0, -1.0, 0.0])}
# the square checks that sweep the part's right side, a stop against its left: from 15 mm above the vise's floor
SQUARE = {("ct-slbeam", "op20"), ("ct-slbeam", "op30")}


def square_sweep(plan: dict, setup_id: str, part: dict) -> dict:
    """SquareCheck's side, start and length for a setup: the left side above the jaws, unless SQUARE has the right."""
    if (plan["part"], setup_id) not in SQUARE:
        return {}
    top = part["centre_mm"][2] + part["half_mm"][2]
    start = vise.VISE["seat_z"] + 15.0
    # a whole number of clicks at .1, so the jog home at .1 ends on Z's home, not past it
    sweep = math.floor(min(SWEEP_MM, top - 6.0 - start) / INC["inc_0.1"]) * INC["inc_0.1"]
    return {"side": 1, "from_z": start, "sweep_mm": sweep}


def g1_features(plan: dict, setup_id: str) -> dict:
    """probe_features for a PROBES setup: its touches, cuts and zero as world points (mm, frame 0)."""
    spec, pose = PROBES[(plan["part"], setup_id)], part_pose(plan, setup_id)
    R, O, c, h = pose["R"], pose["origin_mm"], pose["centre_mm"], pose["size_mm"] / 2
    world = lambda p: O + R @ np.asarray(p, float)           # noqa: E731  a point of the part's model
    out = {}
    for a in "xy":
        if a not in spec:
            continue
        extra = {}
        if isinstance(spec[a], str):
            face, normal = (np.asarray(v, float) for v in FIXED_JAW[spec[a]])
        else:
            point, n, *more = spec[a]
            face, normal = world(point), R @ (np.eye(3)["XYZ".index(n[1])] * (1.0 if n[0] == "+" else -1.0))
            extra = more[0] if more else {}
        assert abs(abs(normal["xy".index(a)]) - 1) < 1e-9, f"{setup_id}: the {a} touch's face doesn't face along {a}"
        out[a] = {"face_mm": face.tolist(), "normal": normal.tolist(), "z_mm": float(face[2])} | extra
    if "z" in spec:
        p = world(spec["z"])
        out["z"] = {"at_xy": p[:2].tolist(), "z_mm": float(p[2])}
    else:
        out["z"] = {"at_xy": (c[:2] + [h[0] / 2, 0]).tolist()}
    out["cuts"] = []
    for box in spec.get("cuts", []):
        corners = np.array([world(q) for q in np.array(np.meshgrid(*box)).reshape(3, -1).T])
        lo, hi = corners.min(0), corners.max(0)
        out["cuts"].append({"centre_mm": ((lo + hi) / 2).tolist(), "half_mm": ((hi - lo) / 2).tolist()})
    out["datum_mm"] = world(spec["datum"]).tolist()
    return out


def build(part: str, step_id: str, solve: bool = True, verbose: bool = True) -> PendantTake:
    plan = load_plan(part)
    step = next(s for s in expand(plan) if s["id"] == step_id)
    setup = step["setup"]
    s = next(x for x in plan["setups"] if x["id"] == setup)
    p = part_on_table(plan, setup) if "clamps" in s["workholding"] else part_in_vise(plan, setup)
    take = PendantTake(data_root() / "takes" / part / step_id, verbose=verbose)
    extra = {}
    if step["title"] == "Find X and Y" and "edge finder" in s["wcs"].get("by", ""):
        sets = XYEdgeFinder(take, p).plan()
        tool = EDGE_FINDER
    elif step["title"] in ("Find X and Y", "Set Z"):
        f = probe_features(plan, setup)
        pr = Probing(take, p, f)
        sets = pr.plan("xy" if step["title"] == "Find X and Y" else "z")
        tool = PROBE
        extra = {"vps": pr.vps, "bores": [f["bore"]] if "bore" in f else [], "cuts": f.get("cuts", []),
                 "tool_length": {str(PROBE["number"]): PROBE["length_mm"]}}
    elif step["title"] == "Check it's straight":
        sq = StraightCheck(take, p)
        sets = sq.plan()
        tool = sq.tool
    elif step["title"] == "Check it's square":
        sq = SquareCheck(take, p, **square_sweep(plan, setup, p))
        sets = sq.plan()
        tool = sq.tool
    else:
        raise NotImplementedError(f"{step_id}: {step['title']} by {step['facts']} isn't planned yet")
    take.clip(step["title"], 0.0, take.t, step["caption"])
    if solve:
        take.solve()
        take.save()
        tk = json.loads((take.out / "take.json").read_text(encoding="utf-8"))
        tk |= {"step": step, "setup": p | {"tool": tool, "setup_mode": True} | extra, "sets": sets,
               "machine_end_mm": take.axis_mm.tolist()}
        (take.out / "take.json").write_text(json.dumps(tk, indent=1), encoding="utf-8")
    if verbose:
        print(f"{step_id}: {take.t:.1f} s, {sum(e['kind'] == 'press' for e in take.events)} presses, "
              f"{sum(abs(e['clicks']) for e in take.events if e['kind'] == 'turn')} clicks; machine ends at "
              f"{np.round(take.axis_mm, 3)}")
    return take


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
