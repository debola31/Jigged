"""Parametric generators for catalogue tools (plan §6, track B): one function per family, so one generator yields every
size of that tool with correct geometry, mass and a record, instead of each being modelled by hand.

Tools stand tip down at the origin, shank up +Z, in millimetres (the asset library's convention). The fluted body is
the family's cross-section twist-extruded at its helix angle; above it the tool is its outline revolved (a step up to
a larger shank, a neck down to a smaller one, a tap's threads as rings); the point or ball is cut on afterwards.
Inspection gauges lie on the bench as the library's do: long axis along X, centred, resting on z = 0.

A maker's tool whose CAD can't be had without an account (SOURCED) is generated from the maker's published
dimensions: its record keeps what the tool is (make, model, description, the plan it serves) and says, in `notes`,
where each dimension came from; `generic` is true, as the model is ours, not the maker's.

    python -m moonshot.library.generators            # writes every tool, gauge and caliper here
    python -m moonshot.library.generators em18 cal24 # writes those
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import cadquery as cq

from moonshot.config import data_root

RECORDS = Path(__file__).resolve().parent / "records" / "assets"
DENSITY_G_CC = {"HSS": 8.1, "cobalt HSS": 8.2, "carbide": 14.5}
INCH = 25.4
MAX_TRIANGLES = 50000
STEEL = [184, 184, 191, 255]


@dataclass(frozen=True)
class Tool:
    id: str
    family: str                  # drill | reamer | tap | ball_end_mill | end_mill | dovetail
    name: str
    dia_mm: float
    flute_mm: float
    overall_mm: float
    material: str
    flutes: int
    helix_deg: float = 30.0
    point_deg: float = 135.0     # a drill's; 180 is a flat bottom
    thread: str | None = None
    shank_mm: float | None = None                   # the shank's diameter, where it isn't the cutting diameter
    neck: tuple[tuple[float, float], ...] = ()      # (height, diameter) points from the flutes' end to the shank: a
                                                    # taper or step up to a larger shank, or a neck down to a smaller
    pitch_mm: float | None = None                   # a tap's thread, cut as rings over thread_mm
    thread_mm: float | None = None
    chamfer_mm: float | None = None                 # a tap's lead
    square_mm: tuple[float, float] | None = None    # a tap's drive square: across flats, length
    flank_deg: float | None = None                  # a dovetail's flank from its axis (per side): a cone, widest
                                                    # at the tip (dia_mm), narrowing up its flute_mm

    @property
    def envelope_mm(self) -> float:
        """The tool's largest diameter anywhere along it."""
        return max([self.dia_mm, self.shank_mm or 0.0] + [d for _, d in self.neck])


TOOLS = [
    Tool("drill-2p5", "drill", "2.5 mm jobber drill", 2.5, 30, 57, "cobalt HSS", 2),
    Tool("drill-5p5", "drill", "5.5 mm jobber drill", 5.5, 57, 93, "cobalt HSS", 2),
    Tool("drill-6", "drill", "6 mm jobber drill", 6.0, 63, 93, "cobalt HSS", 2),
    Tool("drill-7", "drill", "7 mm jobber drill", 7.0, 69, 109, "cobalt HSS", 2),
    Tool("ream-3p5", "reamer", "3.5 mm machine reamer, G6", 3.5, 20, 70, "carbide", 6, helix_deg=0.0),
    Tool("tap-m3", "tap", "M3x0.5 spiral-point tap", 3.0, 12, 56, "HSS", 3, helix_deg=0.0, thread="M3x0.5-6H"),
    Tool("bem14", "ball_end_mill", "1/4 in ball end mill", 6.35, 19.05, 63.5, "carbide", 2),
]

# Makers' tools, generated from their published dimensions (none publishes CAD that can be had without an account,
# 2026-11-04). [proposed] marks a dimension no source gives, chosen as the common form.
SOURCED = [
    Tool("drill-3p3", "drill", "3.3 mm cobalt jobber drill", 3.3, 36, 65, "cobalt HSS", 2),
    Tool("drill-6p5", "drill", "6.5 mm cobalt jobber drill", 6.5, 63, 101, "cobalt HSS", 2),
    Tool("drill-5-32", "drill", "5/32 in cobalt jobber drill", 5 / 32 * INCH, 2 * INCH, 3.125 * INCH, "cobalt HSS", 2),
    Tool("drill-11", "drill", "11 mm flat-bottom carbide drill", 11.0, 48, 90, "carbide", 2, point_deg=180.0,
         shank_mm=12.0, neck=((48.0, 11.0), (49.0, 12.0))),
    Tool("tap-m4", "tap", "M4x0.7 spiral-point tap", 4.0, 14, 54, "HSS", 2, helix_deg=0.0, thread="M4x0.7",
         shank_mm=4.2672, neck=((10.0, 3.0), (19.3, 3.0), (19.94, 4.2672)), pitch_mm=0.7, thread_mm=10.0,
         chamfer_mm=2.8, square_mm=(3.3274, 6.35)),
    Tool("ream-8", "reamer", "8 mm chucking reamer", 8.0, 38.1, 152.4, "HSS", 6, helix_deg=0.0, shank_mm=0.2787 * INCH),
    Tool("ream-1-4", "reamer", "1/4 in chucking reamer", 0.25 * INCH, 1.5 * INCH, 6 * INCH, "HSS", 6, helix_deg=0.0,
         shank_mm=0.24 * INCH),
    Tool("em18", "end_mill", "1/8 in end mill", 0.125 * INCH, 0.375 * INCH, 1.5 * INCH, "carbide", 2),
    Tool("em132", "end_mill", "1/32 in end mill", 0.031 * INCH, 0.093 * INCH, 1.5 * INCH, "carbide", 2,
         shank_mm=0.125 * INCH, neck=((0.093 * INCH, 0.031 * INCH), (0.3141 * INCH, 0.125 * INCH))),
    # sized to the part it cuts, not a catalogue entry: ll-1005337's undercut end-notch walls (SOURCES says how)
    Tool("dovetail-20", "dovetail", "20 deg dovetail cutter", 30.0, 20.0, 70.0, "HSS", 6, helix_deg=0.0,
         flank_deg=20.0, shank_mm=0.75 * INCH, neck=((20.0, 12.0), (25.0, 12.0), (28.0, 0.75 * INCH))),
]

# Where each sourced tool's dimensions came from, for its record: `dims` goes into its notes, `urls` and `files`
# beside the ones the record already names.
CL = "Chicago-Latrobe publishes no CAD (its site doesn't resolve; its distributors list no files)"
SOURCES = {
    "drill-3p3": {"dims": "3.30 mm, 135 deg, 65 mm overall (Zoro's 47843 listing) and 36 mm of flute, the same "
                          "drill's TiN version's (47953) and DIN 338's for 3.3 mm, as no listing of 47843 gives it; "
                          "30 deg helix [proposed]. " + CL,
                  "urls": ["https://www.zoro.com/chicago-latrobe-135-degree-heavy-duty-cobalt-jobber-length-drill-"
                           "chicago-latrobe-550asp-tn-tin-hss-co-5-m35-rhsrhc-33mm-47953/i/G2826910"]},
    "drill-6p5": {"dims": "6.50 mm, 135 deg, 63 mm of flute and 101 mm overall (Benchmark Tooling's 47875 listing); "
                          "30 deg helix [proposed]. " + CL, "urls": []},
    "drill-5-32": {"dims": "5/32 in, 135 deg, 2 in of flute and 3-1/8 in overall (MRO Supply's 47710 listing); "
                           "30 deg helix [proposed]. " + CL, "urls": []},
    "drill-11": {"dims": "11.0 x 12 x 48 x 90: 11 mm, a 12 mm shank, 48 mm of flute, 90 mm overall and a 180 deg "
                         "point (YG-1's own catalogue page); the 1 mm step up to the shank and a 30 deg helix "
                         "[proposed]. YG-1's pages give no CAD",
                 "urls": ["https://yg1.focuspointsap.com/dpp447110"]},
    "tap-m4": {"dims": "OSG's own page: M4 x 0.7, 2 flutes, 0 deg helix, 54 mm overall, 10 mm of thread, a plug "
                       "(4P) chamfer 0.110 in long, 19.3 mm to the neck's end, a 0.168 in (4.2672 mm) shank and a "
                       "0.131 in (3.3274 mm) square 6.35 mm long; the threads drawn as rings, the neck 3.0 mm across "
                       "and the flutes 14 mm long [proposed]. The page's 'Basic 3D Model (STP)' link "
                       "(res.cloudinary.com/osg-usa-inc/.../1400130601_zb6uia.stp) and its DXF returned 404 on "
                       "2026-11-04",
               "urls": ["https://osgtool.com/1980401/"]},
    "ream-8": {"dims": "8.00 mm, 6 straight flutes 38.10 mm long, 152.40 mm overall (Exact Tooling's C25668 "
                       "listing); the shank 0.2787 in, the next size's (C25669) listed shank, as C25668's isn't "
                       "listed [proposed]. Cleveland publishes no CAD",
               "urls": ["https://exacttooling.com/products/57638108", "https://sourceatlantic.ca/Product/4001-25669"]},
    "ream-1-4": {"dims": "1/4 in, 6 straight flutes 1-1/2 in long, 6 in overall (the catalogue entry) and a 0.24 in "
                         "shank (Source Atlantic's C25513 listing). Cleveland publishes no CAD",
                 "urls": ["https://www.sourceatlantic.ca/Product/4001-25513"]},
    "em18": {"dims": "Harvey Tool's own page and profile drawing (Harvey_72125.dxf, downloaded): 1/8 in for 3/8 in "
                     "of cut, a 1/8 in shank, 1-1/2 in overall; the flutes' 30 deg helix [proposed]. Harvey "
                     "publishes the DXF profile only, no STEP",
             "urls": ["https://www.harveytool.com/products/tool-details-72125",
                      "https://harveyperformance.widen.net/content/bwqje7qymb/original/Harvey_72125.dxf"],
             "files": ["Harvey_72125.dxf (Harvey Tool's profile drawing)"]},
    "em132": {"dims": "Harvey Tool's own page and profile drawing (Harvey_72031.dxf, downloaded): 0.031 in for "
                      "0.093 in of cut, then a straight taper to the 1/8 in shank at 0.3141 in, 1-1/2 in overall; "
                      "the flutes' 30 deg helix [proposed]. Harvey publishes the DXF profile only, no STEP",
              "urls": ["https://www.harveytool.com/products/tool-details-72031",
                       "https://harveyperformance.widen.net/content/tery12h1wd/original/Harvey_72031.dxf"],
              "files": ["Harvey_72031.dxf (Harvey Tool's profile drawing)"]},
    "dovetail-20": {
        "dims": "the wall it cuts, not a catalogue's 10 or 20 deg naming. The angle as read from ll-1005337's STEP "
                "(part.step, 2026-11-05): each end notch's undercut wall is a plane whose normal is (0, -/+0.9397, "
                "-0.3420), 20.000 deg from vertical, leaning 6.93 mm over the 19.05 mm plate (Y 24.62 at the top "
                "face, 31.55 at the bottom), and its R15 corners are cylinders whose axes lean the same 20 deg; the "
                "drawing (314-092-59986-10, section A-A) dimensions it 20 deg and 24.6, and the plan's op10 undercut "
                "'walls 20 deg'. So the flank is 20 deg per side, 40 deg included, widest at the tip. Sized to the "
                "notch: 30 mm at its widest, twice the R15 corners, the largest that doesn't leave them (a cutter "
                "makes no corner tighter than its radius), and 20 mm of cut over the 19.05 mm wall; the 12 mm neck "
                "5 mm long, the 3/4 in shank (for the shop's 3/4 in CAT40 end mill holder), 70 mm overall, 6 "
                "straight flutes and HSS [proposed]. A vertical cutter's corners are its cone, R15 at the wall's "
                "foot narrowing to R8.1 at the top face, where the model's leaning R15 stays R15 all the way up "
                "(the drawing doesn't dimension R15)",
        "urls": [],
        "license": "self-made parametric generator (moonshot.library.generators, family dovetail), sized from the "
                   "part it cuts (ll-1005337's STEP and drawing); no maker's tool"},
}


# --- the tools -------------------------------------------------------------------------------------------------------

def _distinct(pts: list) -> list:
    """Points with consecutive repeats dropped (OCC refuses a zero-length edge)."""
    out = []
    for p in pts:
        if not out or max(abs(a - b) for a, b in zip(p, out[-1])) > 1e-6:
            out.append(p)
    return out


def _revolved(pts: list) -> cq.Workplane:
    """A solid of revolution about +Z from its (r, z) half-section, closed against the axis."""
    return cq.Workplane("XZ").polyline(_distinct(pts)).close().revolve(360, (0, 0, 0), (0, 1, 0))


def fluted_body(t: Tool) -> cq.Workplane:
    """The cutting part: the family's cross-section (a circle with its flute gullets cut out) twist-extruded along
    the helix, so the flutes are one swept profile rather than separate boolean cuts."""
    r = t.dia_mm / 2
    gullet = r * {"drill": 0.55, "end_mill": 0.5}.get(t.family, 0.35)       # a square end mill's deep, as a drill's
    at = r * 0.95
    if t.flank_deg:                    # a dovetail's gullets run from its cone's narrow top out past its wide tip
        top = r - t.flute_mm * math.tan(math.radians(t.flank_deg))
        at, gullet = (r + top) / 2, (r - top) / 2 + 0.05 * r
    centres = [(math.cos(2 * math.pi * i / t.flutes) * at, math.sin(2 * math.pi * i / t.flutes) * at)
               for i in range(t.flutes)]
    face = cq.Sketch().circle(r).push(centres).circle(gullet, mode="s")._faces.Faces()[0]
    lead = math.pi * t.dia_mm / math.tan(math.radians(t.helix_deg)) if t.helix_deg else math.inf
    twist = 360.0 * t.flute_mm / lead if t.helix_deg else 0.0
    if twist:
        solid = cq.Solid.extrudeLinearWithRotation(face.outerWire(), [], cq.Vector(0, 0, 0),
                                                    cq.Vector(0, 0, t.flute_mm), twist)
    else:                                              # straight flutes (reamers, spiral-point taps)
        solid = cq.Solid.extrudeLinear(face, cq.Vector(0, 0, t.flute_mm))
    return cq.Workplane("XY").add(solid)


def outline(t: Tool) -> list[tuple[float, float]]:
    """The tool's (r, z) outline from tip to top, before its flutes and point: a tap's thread as rings (crest flat
    1/8 of the pitch, root 1/4, the ISO external thread's 0.6134 pitch deep), then the neck points, then the shank;
    a shank of another size with no neck given steps to it at 45 deg where the flutes end."""
    r, rs = t.dia_mm / 2, (t.shank_mm or t.dia_mm) / 2
    if t.pitch_mm:
        p, root = t.pitch_mm, r - 0.6134 * t.pitch_mm
        pts = []
        for k in range(int(t.thread_mm / p + 1e-9)):
            z = k * p
            pts += [(root, z), (root, z + 0.125 * p), (r, z + 0.4375 * p), (r, z + 0.5625 * p), (root, z + 0.875 * p)]
        pts.append((root, t.thread_mm))
    elif t.flank_deg:                                   # a dovetail's cone
        pts = [(r, 0.0), (r - t.flute_mm * math.tan(math.radians(t.flank_deg)), t.flute_mm)]
    else:
        pts = [(r, 0.0), (r, t.flute_mm)]
    neck = list(t.neck) or ([(t.flute_mm + abs(rs - r), 2 * rs)] if rs != r else [])
    pts += [(d / 2, z) for z, d in neck]
    return _distinct(pts + [(rs, t.overall_mm)])


def _clip(pts: list, z0: float, z1: float) -> list:
    """The part of an outline between heights z0 and z1, cut at them by interpolation."""
    def at(a, b, z):
        f = (z - a[1]) / (b[1] - a[1])
        return (a[0] + f * (b[0] - a[0]), z)
    out = []
    for a, b in zip(pts, pts[1:]):
        if b[1] < z0 or a[1] > z1 or b[1] == a[1] and not z0 <= a[1] <= z1:
            continue
        out.append(a if a[1] >= z0 else at(a, b, z0))
        out.append(b if b[1] <= z1 else at(a, b, z1))
    return _distinct(out)


def build(t: Tool) -> cq.Workplane:
    r = t.dia_mm / 2
    body = fluted_body(t)
    shaped = bool(t.shank_mm or t.neck or t.pitch_mm)
    if shaped:
        line = outline(t)
        if t.pitch_mm or any(abs(x - r) > 1e-9 for x, _ in _clip(line, 0.0, t.flute_mm)):
            lower = _clip(line, 0.0, t.flute_mm)
            body = body.intersect(_revolved([(0, 0)] + lower + [(0, t.flute_mm)]))
        upper = _clip(line, t.flute_mm, t.overall_mm)
        # from the last point at the flutes' end, so a step in there (a dovetail's neck) doesn't fold the section
        upper = [p for p in upper if p[1] <= t.flute_mm + 1e-9][-1:] + [p for p in upper if p[1] > t.flute_mm + 1e-9]
        shank = _revolved([(0, t.flute_mm)] + upper + [(0, t.overall_mm)])
    else:
        shank = cq.Workplane("XY").workplane(offset=t.flute_mm).circle(r).extrude(t.overall_mm - t.flute_mm)
    tool = body.union(shank)
    top = t.overall_mm + 1
    rk = max(r, t.envelope_mm / 2) * 1.01             # past everything, for the cuts below
    if t.family == "drill" and t.point_deg < 180:
        # a cone point: cut away everything below the cone of the point angle
        h = r / math.tan(math.radians(t.point_deg / 2))
        tool = tool.intersect(_revolved([(0, 0), (r * 1.01, h), (rk, h), (rk, top), (0, top)]))
    elif t.family == "tap":
        # a chamfered lead, from under the thread's root at the tip to its crest chamfer_mm up (else 0.6 r)
        h = t.chamfer_mm or r * 0.6
        r0 = (r - 0.6134 * t.pitch_mm) * 0.97 if t.pitch_mm else 0.0
        tool = tool.intersect(_revolved([(0, 0), (r0, 0), (r * 1.01, h), (rk, h), (rk, top), (0, top)]))
    elif t.family == "ball_end_mill":
        ball = cq.Workplane("XY").sphere(r).translate((0, 0, r))
        above = cq.Workplane("XY").workplane(offset=r).circle(r * 1.01).extrude(t.overall_mm)
        tool = tool.intersect(ball.union(above))
    elif t.family == "reamer":
        # a 45 degree lead on the tip, cut by revolving its profile (chamfering fluted edges fails in OCC)
        tool = tool.intersect(_revolved([(0, 0), (r * 0.85, 0), (r * 1.01, r * 0.16), (rk, r * 0.16), (rk, top),
                                         (0, top)]))
    if t.square_mm:                                    # the drive square, its corners the round shank's
        k, length = t.square_mm
        z = t.overall_mm - length
        keep = cq.Workplane("XY").circle(rk).extrude(z).union(
            cq.Workplane("XY").workplane(offset=z).rect(k, k).extrude(length + 1))
        tool = tool.intersect(keep)
    return tool


def record(t: Tool, shape: cq.Workplane) -> dict:
    vol_cc = shape.val().Volume() / 1000
    mass_g = vol_cc * DENSITY_G_CC[t.material]
    specs = [{"name": "Diameter", "value": round(t.dia_mm, 4), "unit": "mm"},
             {"name": "Flute length", "value": round(t.flute_mm, 4), "unit": "mm"},
             {"name": "Overall length", "value": round(t.overall_mm, 4), "unit": "mm"},
             {"name": "Flutes", "value": t.flutes, "unit": "flutes"},
             {"name": "Material", "value": t.material},
             {"name": "Mass", "value": round(mass_g, 2), "unit": "g", "note": "volume x material density"}]
    if t.shank_mm:
        specs.insert(3, {"name": "Shank diameter", "value": round(t.shank_mm, 4), "unit": "mm"})
    if t.thread:
        specs.insert(0, {"name": "Thread", "value": t.thread})
    if t.family == "drill":
        specs.append({"name": "Point angle", "value": t.point_deg, "unit": "deg"})
    if t.flank_deg:
        specs.insert(1, {"name": "Flank angle", "value": t.flank_deg, "unit": "deg",
                         "note": f"per side, from the axis; {2 * t.flank_deg:g} deg included"})
    return {
        "schema": "setupguide.asset/0.1", "id": t.id, "name": t.name, "category": "tooling",
        "make": "Generic", "model": f"{t.family} {t.dia_mm:g} mm",
        "description": f"{t.name}, {t.material}, {t.flutes} flutes.",
        "generic": True, "key_specs": specs, "source_urls": [], "source_files": [f"{t.id}.step"],
        "license": f"self-made parametric generator (moonshot.library.generators, family {t.family})",
        "notes": "Generated from its dimensions; replace with a vendor STEP when one is sourced.",
        "file": f"{t.id}.glb", "units": "mm", "up": "+Z", "bbox": _bbox(shape),
        "attach_points": [],
        "build": {"from": f"source/{t.id}.step", "placeholder": f"generators.{t.family}", "up": "+Z",
                  "max_triangles": MAX_TRIANGLES},
    }


def _bbox(shape: cq.Workplane) -> dict:
    bb = shape.val().BoundingBox()
    return {"min": [round(bb.xmin, 2), round(bb.ymin, 2), round(bb.zmin, 2)],
            "max": [round(bb.xmax, 2), round(bb.ymax, 2), round(bb.zmax, 2)]}


# --- inspection gauges -----------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class PlugGauge:
    """A double-ended go/no-go thread plug gauge: a go member, the handle, a no-go member, on one axis."""
    id: str
    major_mm: float
    pitch_mm: float
    go_mm: float
    nogo_mm: float
    handle_mm: float
    handle_dia_mm: float
    band_mm: float = 5.0          # the go (green) and no-go (red) ends of the handle


@dataclass(frozen=True)
class Caliper:
    """A digital caliper lying on its back, closed: the beam along +X from the fixed jaw's outer edge, the outside
    jaws toward -Y, the inside jaws toward +Y; drawing letters as the maker's datasheet has them."""
    id: str
    length_mm: float              # L, overall
    beam_mm: float                # H, the beam's height
    outside_mm: float             # D, the outside jaws' depth below the beam
    inside_mm: float              # A, the fixed inside jaw above the beam
    slider_inside_mm: float       # C, the slider's inside jaw above its body
    beam_t_mm: float = 6.5        # [proposed] the beam's thickness
    jaw_t_mm: float = 5.0         # [proposed]
    head_mm: float = 40.0         # [proposed] the fixed head's width along the beam, to the measuring faces
    slider_mm: float = 125.0      # [proposed] the slider's length
    slider_below_mm: float = 32.0  # [proposed] the slider's body below the beam's lower edge
    slider_t_mm: float = 16.0     # [proposed] its thickness in front of the beam's back


GAUGES = [PlugGauge("thread-m4", 4.0, 0.7, 10.3, 7.1, 2 * INCH, 0.375 * INCH)]
CALIPERS = [Caliper("cal24", 780.0, 25.0, 90.0, 38.0, 35.9)]

GAUGE_SOURCES = {
    "thread-m4": {
        "dims": "the go member 10.3 mm and the no-go 7.1 mm long (Zoro's 302111530 listing), on Vermont Gage's #0 "
                "taperlock double-end handle, 2 in long, the one for 0.1501-0.2300 in gauges (Zoro's 951410300 "
                "listing); the handle 3/8 in across and its green go and red no-go ends 5 mm wide, the threads drawn "
                "as rings [proposed]. Vermont Gage's site gives no CAD",
        "urls": ["https://www.zoro.com/vermont-gage-plug-gage-handle-2-l-aluminum-951410300/i/G2726783/"],
        "specs": [{"name": "Go member length", "value": 10.3, "unit": "mm"},
                  {"name": "No-go member length", "value": 7.1, "unit": "mm"},
                  {"name": "Handle", "value": "#0 taperlock, double end, aluminium, 2 in long"}]},
    "cal24": {
        "dims": "Mitutoyo's datasheet (shop.mitutoyo.eu, read from a dealer's printed copy): L 780 mm overall, D 90 mm "
                "outside jaws, A 38 mm fixed inside jaw, C 35.9 mm slider inside jaw, H 25 mm beam, 1350 g; the "
                "beam 6.5 mm thick, the fixed head 40 mm wide and the slider 125 x 16 mm, 32 mm below the beam "
                "[proposed]. Mitutoyo offers CAD only through an account",
        "urls": ["https://shop.mitutoyo.eu/web/mitutoyo/en_SE/mitutoyo/$catalogue/mitutoyoData/PR/500-506-10/"
                 "datasheet.xhtml", "https://mme-ae.com/wp-content/uploads/2023/06/Mitutoyo-500-506-10.pdf"],
        "specs": [{"name": "Overall length", "value": 780, "unit": "mm", "note": "L"},
                  {"name": "Outside jaw depth", "value": 90, "unit": "mm", "note": "D"},
                  {"name": "Inside jaw length", "value": 38, "unit": "mm", "note": "A"},
                  {"name": "Beam height", "value": 25, "unit": "mm", "note": "H"},
                  {"name": "Mass", "value": 1350, "unit": "g", "note": "Mitutoyo's datasheet"}]},
}


def _thread_rings(major: float, pitch: float, length: float, lead: bool = True) -> list[tuple[float, float]]:
    """A thread's (r, z) outline as rings from z = 0, its first ring chamfered as a gauge's lead."""
    r, root = major / 2, major / 2 - 0.6134 * pitch
    pts = [(root, 0.0)] if lead else []
    for k in range(int(length / pitch + 1e-9)):
        z = k * pitch
        pts += [(root, z + 0.125 * pitch), (r if k or not lead else (r + root) / 2, z + 0.4375 * pitch),
                (r, z + 0.5625 * pitch), (root, z + 0.875 * pitch)]
    return _distinct(pts + [(root, length)])


def plug_gauge(g: PlugGauge) -> list[tuple[str, cq.Workplane, list[int]]]:
    """The gauge's parts, built up +Z (go member, handle, no-go member), then laid along +X, go end at -X."""
    rh, ch, b = g.handle_dia_mm / 2, 0.8, g.band_mm
    z1, z2 = g.go_mm, g.go_mm + g.handle_mm
    total = z2 + g.nogo_mm
    go = _revolved([(0, 0)] + _thread_rings(g.major_mm, g.pitch_mm, g.go_mm) + [(0, g.go_mm)])
    nogo = _revolved([(0, 0)] + _thread_rings(g.major_mm, g.pitch_mm, g.nogo_mm) + [(0, g.nogo_mm)])
    nogo = nogo.rotate((0, 0, 0), (1, 0, 0), 180).translate((0, 0, total))
    parts = [
        ("go", go, [214, 214, 220, 255]),
        ("go_band", _revolved([(0, z1), (rh - ch, z1), (rh, z1 + ch), (rh, z1 + b), (0, z1 + b)]), [40, 150, 70, 255]),
        ("handle", _revolved([(0, z1 + b), (rh, z1 + b), (rh, z2 - b), (0, z2 - b)]), [196, 198, 204, 255]),
        ("nogo_band", _revolved([(0, z2 - b), (rh, z2 - b), (rh, z2 - ch), (rh - ch, z2), (0, z2)]),
         [190, 40, 40, 255]),
        ("nogo", nogo, [214, 214, 220, 255]),
    ]
    return [(n, s.rotate((0, 0, 0), (0, 1, 0), 90).translate((-total / 2, 0, rh)), c) for n, s, c in parts]


def caliper(c: Caliper) -> list[tuple[str, cq.Workplane, list[int]]]:
    """The caliper's parts, closed, lying on its back (the beam's back on z = 0), centred on its box in X and Y."""
    def plate(pts, z0, z1):
        return cq.Workplane("XY").workplane(offset=z0).polyline(pts).close().extrude(z1 - z0)

    L, H, D, hw = c.length_mm, c.beam_mm, c.outside_mm, c.head_mm
    tip = H + c.inside_mm                              # the inside jaws' tips
    s0, s1 = hw, hw + c.slider_mm                      # the slider, its measuring faces on the head's at x = hw
    top = tip - c.slider_inside_mm                     # the slider's body's upper edge
    jz = ((c.beam_t_mm - c.jaw_t_mm) / 2, (c.beam_t_mm + c.jaw_t_mm) / 2)
    back = -1.5                                        # the slider's back plate, behind the beam
    beam = (cq.Workplane("XY").box(L, H, c.beam_t_mm, centered=False)
            .union(plate([(0, 0), (hw, 0), (hw, -D), (hw - 7, -D), (0, -0.55 * D)], *jz))
            .union(plate([(hw - 14, H - 1), (hw, H - 1), (hw, tip), (hw - 4, tip), (hw - 14, H + 15)], *jz)))
    jaws = (plate([(s0, -c.slider_below_mm + 1), (s0 + 42, -c.slider_below_mm + 1), (s0 + 7, -D), (s0, -D)], *jz)
            .union(plate([(s0, top - 1), (s0 + 14, top - 1), (s0 + 14, top + 15), (s0 + 4, tip), (s0, tip)], *jz)))
    body = (cq.Workplane("XY").workplane(offset=back)
            .center((s0 + s1) / 2, (top - c.slider_below_mm) / 2)
            .rect(c.slider_mm, top + c.slider_below_mm).extrude(c.slider_t_mm - back)
            .edges("|Z").fillet(4.0))
    lcd = (cq.Workplane("XY").workplane(offset=c.slider_t_mm - 0.4)
           .center(s0 + 52, -c.slider_below_mm / 2 + 2).rect(62, 24).extrude(0.6))
    parts = [("beam", beam, [204, 206, 210, 255]), ("jaws", jaws, [204, 206, 210, 255]),
             ("slider", body, [38, 40, 44, 255]), ("lcd", lcd, [150, 162, 140, 255])]
    bb = cq.Compound.makeCompound([s.val() for _, s, _ in parts]).BoundingBox()
    move = (-(bb.xmin + bb.xmax) / 2, -(bb.ymin + bb.ymax) / 2, -bb.zmin)
    return [(n, s.translate(move), col) for n, s, col in parts]


# --- hand tools ------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class RatchetWrench:
    """A ratcheting combination wrench from its maker's published dimensions (the record's key specs): the ratcheting
    box end's head round its ring, the ring's 12-point opening, the handle, the open end's jaws at their angle. In the
    wrench's frame (moonshot/world/wrench.py's): the box end's middle at the origin, the handle along +X, the head's
    mid-plane at z = 0."""
    id: str
    across_flats_mm: float        # the fastener it fits
    length_mm: float              # overall
    head_w_mm: float              # the box end's width across its head
    head_t_mm: float              # ... and its thickness
    open_w_mm: float              # the open end's width across its jaws
    open_t_mm: float              # ... and its thickness
    open_deg: float = 15.0        # the open end's jaws' angle to the handle
    handle_w_mm: float = 17.0     # [proposed]
    handle_t_mm: float = 7.0      # [proposed]
    ring_r_mm: float = 13.0       # [proposed] the ratchet ring's outside radius in the head


RATCHET_WRENCHES = [RatchetWrench("ratchet-wrench", 0.75 * INCH, 9.594 * INCH, 1.339 * INCH, 0.441 * INCH,
                                  1.626 * INCH, 0.374 * INCH)]


def ratchet_wrench(w: RatchetWrench) -> list[tuple[str, cq.Workplane, list[int]]]:
    """The wrench's two parts in its frame: its body (head, handle, open end) and the ring that turns in its head
    (moonshot/world/wrench.py's ratchet), each a node of its own as the take record draws them on their bodies."""
    h, r_out = w.head_t_mm, w.head_w_mm / 2
    head = cq.Workplane("XY").circle(r_out).circle(w.ring_r_mm).extrude(h).translate((0, 0, -h / 2))
    open_r = w.open_w_mm / 2
    x_open = w.length_mm - r_out - open_r                       # the open end's middle: overall from head to jaw tips
    x0, x1 = r_out - 2.0, x_open - open_r + 2.0
    handle = (cq.Workplane("XY").box(x1 - x0, w.handle_w_mm, w.handle_t_mm).translate(((x0 + x1) / 2, 0, 0))
              .edges("|X").fillet(2.0))
    gap = w.across_flats_mm + 0.25
    jaw = (cq.Workplane("XY").circle(open_r).extrude(w.open_t_mm).translate((0, 0, -w.open_t_mm / 2))
           .cut(cq.Workplane("XY").circle(gap / 2).extrude(w.open_t_mm * 2).translate((0, 0, -w.open_t_mm)))
           .cut(cq.Workplane("XY").box(open_r * 2, gap, w.open_t_mm * 2).translate((open_r, 0, 0))))
    jaw = jaw.rotate((0, 0, 0), (0, 0, 1), w.open_deg).translate((x_open, 0, 0))
    body = head.union(handle).union(jaw)
    across_corners = (w.across_flats_mm + 0.2) / math.cos(math.pi / 6)
    hole = (cq.Workplane("XY").polygon(6, across_corners).extrude(h * 2)
            .union(cq.Workplane("XY").transformed(rotate=(0, 0, 30)).polygon(6, across_corners).extrude(h * 2))
            .translate((0, 0, -h)))
    ring = (cq.Workplane("XY").circle(w.ring_r_mm - 0.2).extrude(h - 1.0).translate((0, 0, -(h - 1.0) / 2))
            .cut(hole))
    return [("ratchet_wrench", body, STEEL), ("ratchet_wrench_ring", ring, [170, 170, 178, 255])]


def write_hand_tool(w: RatchetWrench) -> Path:
    """The wrench's STEP, its library GLB lying on the bench (z = 0 its underside, each part a node), the same as its
    rig's GLB, its parts' GLBs in its own frame for a take record (links/<part>.glb), and its record's build."""
    parts = ratchet_wrench(w)
    src, lib = _dirs("hand_tools", w.id)
    compound = cq.Workplane("XY").add(cq.Compound.makeCompound([s.val() for _, s, _ in parts]))
    cq.exporters.export(compound, str(src / f"{w.id}.step"))
    lift = w.head_t_mm / 2
    lying = [(n, s.translate((0, 0, lift)), c) for n, s, c in parts]
    triangles = write_parts_glb(lying, lib / f"{w.id}.glb", tolerance_mm=0.02, max_triangles=MAX_TRIANGLES)
    shutil.copy2(lib / f"{w.id}.glb", lib / f"{w.id}_rig.glb")
    (lib / "links").mkdir(exist_ok=True)
    for n, s, c in parts:
        write_parts_glb([(n, s, c)], lib / "links" / f"{n}.glb", tolerance_mm=0.02, max_triangles=MAX_TRIANGLES)
    out = _record_path("hand_tools", w.id)
    rec = json.loads(out.read_text(encoding="utf-8"))
    rec.pop("pending", None)
    bbox = _bbox(cq.Workplane("XY").add(cq.Compound.makeCompound([s.val() for _, s, _ in lying])))
    rec |= {"source_files": [f"{w.id}.step"], "triangles": triangles, "bbox": bbox,
            "build": {"from": f"source/{w.id}.step", "placeholder": "generators.ratchet_wrench", "up": "+Z",
                      "max_triangles": MAX_TRIANGLES}}
    _save(out, rec)
    return out


# --- writing ---------------------------------------------------------------------------------------------------------

def _mesh(shape: cq.Workplane, tolerance_mm: float, color: list[int], angle_rad: float = 0.08):
    """glTF is metres and +Y up; the library's geometry is millimetres and +Z up."""
    import numpy as np
    import trimesh
    from OCP.BRepTools import BRepTools
    BRepTools.Clean_s(shape.val().wrapped)            # else OCC keeps the finer mesh it made before
    verts, faces = shape.val().tessellate(tolerance_mm, angle_rad)
    v = np.array([(p.x, p.y, p.z) for p in verts]) * 0.001
    v = v[:, [0, 2, 1]] * np.array([1.0, 1.0, -1.0])            # (x, y, z) -> (x, z, -y)
    mesh = trimesh.Trimesh(v, np.array(faces), process=True)
    mesh.visual.face_colors = color
    return mesh


def write_glb(shape: cq.Workplane, path: Path, tolerance_mm: float = 0.01,
              max_triangles: int | None = None) -> int:
    """One mesh, smooth shaded (no faceted flutes in close-ups); the tessellation coarsened until it fits
    max_triangles, when one is given."""
    return write_parts_glb([("tool", shape, STEEL)], path, tolerance_mm, max_triangles)


def write_parts_glb(parts: list, path: Path, tolerance_mm: float = 0.01, max_triangles: int | None = None) -> int:
    """Each (name, shape, rgba) a node of its own, so a part keeps its colour. Over max_triangles, the deflection
    and the angle both coarsened by half again until it fits (the angle, 0.08 rad, is what bounds a fluted tool's)."""
    import trimesh
    angle = 0.08
    while True:
        meshes = [(n, _mesh(s, tolerance_mm, c, angle)) for n, s, c in parts]
        triangles = sum(len(m.faces) for _, m in meshes)
        if max_triangles is None or triangles <= max_triangles or angle > 0.5:
            break
        tolerance_mm, angle = tolerance_mm * 1.5, angle * 1.5
    if len(meshes) == 1:
        meshes[0][1].export(path, include_normals=True)
    else:
        scene = trimesh.Scene()
        for n, m in meshes:
            scene.add_geometry(m, node_name=n, geom_name=n)
        scene.export(path, include_normals=True)
    return triangles


def _dirs(category: str, asset: str) -> tuple[Path, Path]:
    src = data_root() / "originals" / category / asset
    lib = data_root() / "library" / category / asset
    src.mkdir(parents=True, exist_ok=True)
    lib.mkdir(parents=True, exist_ok=True)
    return src, lib


def _record_path(category: str, asset: str) -> Path:
    d = RECORDS / category / asset
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{asset}.json"


MARK = " Model generated by moonshot.library.generators"


def sourced_record(base: dict, gen: dict, src: dict, family: str, triangles: int) -> dict:
    """A maker's catalogue entry once its model is generated: what the tool is stays the maker's (its make, model,
    description, specs as published, the plan it serves); the generator adds the specs the entry lacked, the mass,
    the box and the build, and says where each dimension came from."""
    names = {s["name"] for s in base["key_specs"]} - {"Mass"}
    specs = ([s for s in base["key_specs"] if s["name"] != "Mass"] + list(src.get("specs", []))
             + [s for s in gen.get("key_specs", []) if s["name"] not in names])
    first = {}
    for s in specs:
        first.setdefault(s["name"], s)
    specs = list(first.values())
    use = base.get("notes", "").split(MARK)[0].strip()
    urls = list(dict.fromkeys(base["source_urls"] + src["urls"]))
    out = {k: base[k] for k in ("schema", "id", "name", "category", "make", "model", "description")}
    return out | {
        "generic": True, "key_specs": specs, "source_urls": urls,
        "source_files": [f"{base['id']}.step"] + src.get("files", []),
        "license": src.get("license") or f"self-made parametric generator (moonshot.library.generators, family "
                                         f"{family}), from {base['make']}'s published dimensions; not the maker's CAD",
        "notes": f"{use}{MARK} (family {family}) from {src['dims']}.".strip(),
        "file": f"{base['id']}.glb", "units": "mm", "up": "+Z", "bbox": gen["bbox"], "attach_points": [],
        "build": {"from": f"source/{base['id']}.step", "placeholder": f"generators.{family}", "up": "+Z",
                  "max_triangles": MAX_TRIANGLES},
        "triangles": triangles,
    }


def write(t: Tool) -> Path:
    shape = build(t)
    src, lib = _dirs("tooling", t.id)
    cq.exporters.export(shape, str(src / f"{t.id}.step"))
    triangles = write_glb(shape, lib / f"{t.id}.glb", max_triangles=MAX_TRIANGLES)
    out = _record_path("tooling", t.id)
    gen = record(t, shape)
    if t.id in SOURCES:
        rec = sourced_record(json.loads(out.read_text(encoding="utf-8")), gen, SOURCES[t.id], t.family, triangles)
    else:
        rec = gen | {"triangles": triangles}
    _save(out, rec)
    return out


def _save(path: Path, rec: dict) -> None:
    """A record as UTF-8 (a maker's Ø stays Ø)."""
    path.write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_inspection(item: PlugGauge | Caliper) -> Path:
    family = "plug_gauge" if isinstance(item, PlugGauge) else "caliper"
    parts = plug_gauge(item) if family == "plug_gauge" else caliper(item)
    src, lib = _dirs("inspection", item.id)
    compound = cq.Workplane("XY").add(cq.Compound.makeCompound([s.val() for _, s, _ in parts]))
    cq.exporters.export(compound, str(src / f"{item.id}.step"))
    triangles = write_parts_glb(parts, lib / f"{item.id}.glb", tolerance_mm=0.02, max_triangles=MAX_TRIANGLES)
    out = _record_path("inspection", item.id)
    base = json.loads(out.read_text(encoding="utf-8"))
    rec = sourced_record(base, {"bbox": _bbox(compound)}, GAUGE_SOURCES[item.id], family, triangles)
    _save(out, rec)
    return out


def main(ids: list[str]) -> None:
    every = ({t.id: t for t in TOOLS + SOURCED} | {g.id: g for g in GAUGES + CALIPERS}
             | {w.id: w for w in RATCHET_WRENCHES})
    for i in ids or list(every):
        item = every[i]
        if isinstance(item, Tool):
            print("wrote", write(item))
        elif isinstance(item, RatchetWrench):
            print("wrote", write_hand_tool(item))
        else:
            print("wrote", write_inspection(item))


if __name__ == "__main__":
    main(sys.argv[1:])
