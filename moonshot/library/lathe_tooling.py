"""The ST-25's generated tooling (plan §6, track B), from makers' published dimensions where no CAD can be had without
an account: the 5/8 in 5C collet in the Royal collet chuck, and the BOT20 ID-station holder with an ER32 collet chuck
for the turret's drills and taps.

- collet-5c-0625: Hardinge's 5C (its spindle tooling catalog, 2348J): 1.250 in back bearing, 3.281 in overall, a
  1.238-20 thread, a 1.468 in head on a 10 deg head angle; three slots. Its asset lies along +X, centred, resting on
  z = 0; the ST-25's link (links/c5/collet.glb) stands in the Royal chuck on the spindle's axis, its face flush with
  the chuck's nose, in the station's frame.
- bot-er32: Haas Tooling's BOT20 1-1/2 in ID static turning holder (04-0757: BOT20 fits the ST-25; ID holders bolt
  round the turret's perimeter, their bore on the station's centreline) with a 1-1/2 in straight-shank ER32 collet
  chuck in its bore. In the frame of a turret station's site (moonshot/world/st25.py station_frames: its x out along
  the station, its z toward the chuck, its origin on the turret's front face on the ID tool's axis), so it goes on a
  station as it is.

Every dimension no source gives is proposed, in each record's notes.

    python -m moonshot.library.lathe_tooling
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import cadquery as cq

from moonshot.config import data_root
from moonshot.library import generators as G

INCH = 25.4
STATIONS = Path(__file__).resolve().parent / "stations"
BLACK_OXIDE = [40, 40, 44, 255]
STEEL = G.STEEL

# Hardinge 2348J, Dimensions and Capacities: 5C
C5 = {"back_bearing": 1.250 * INCH, "overall": 3.281 * INCH, "thread": 1.238 * INCH, "head": 1.468 * INCH,
      "head_half_deg": 10.0}
C5_PROPOSED = {"head_land": 2.0, "thread_len": 12.0, "slot_w": 1.5, "slot_len": 55.0, "relief": 1.6, "chamfer": 0.5}


def _revolve_x(pts: list[tuple[float, float]]) -> cq.Workplane:
    """A solid of revolution about +X from its (x, r) half-section, closed."""
    return cq.Workplane("XY").polyline(pts).close().revolve(360.0, (0, 0, 0), (1, 0, 0))


def collet_5c(size_in: float) -> cq.Workplane:
    """A round 5C collet, its face at x = 0, its body back along -X, its axis on X: the head's land and its 10 deg
    taper, the back bearing, the thread's diameter at the back; the bore at its size for the grip, relieved behind it;
    three slots from the face."""
    c, p = C5, C5_PROPOSED
    taper = (c["head"] - c["back_bearing"]) / 2 / math.tan(math.radians(c["head_half_deg"]))
    bore, relief = size_in * INCH / 2, size_in * INCH / 2 + p["relief"]
    L = c["overall"]
    pts = [(0.0, bore + p["chamfer"]), (0.0, c["head"] / 2), (-p["head_land"], c["head"] / 2),
           (-p["head_land"] - taper, c["back_bearing"] / 2), (-(L - p["thread_len"]), c["back_bearing"] / 2),
           (-(L - p["thread_len"]), c["thread"] / 2), (-L, c["thread"] / 2), (-L, relief), (-25.0, relief),
           (-25.0, bore), (-p["chamfer"], bore)]
    body = _revolve_x(pts)
    for k in range(3):
        a = math.radians(90.0 + 120.0 * k + 60.0)          # between the station's fingers (moonshot/world/st25.py)
        slot = (cq.Workplane("XY").box(p["slot_len"], p["slot_w"], c["head"])
                .translate((-p["slot_len"] / 2 + 0.01, 0, c["head"] / 2))
                .rotate((0, 0, 0), (1, 0, 0), math.degrees(a) - 90.0))
        body = body.cut(slot)
    return body


# Haas Tooling BOT20 1-1/2 in ID static turning holder (04-0757) and a 1-1/2 in straight-shank ER32 collet chuck: no
# drawing was to be had, so their sizes are proposed but for the bore and the turret's geometry (moonshot/library/
# stations/st25.json: the turret's flat 229.5 mm from its centre, the ID axis 278.0 mm, 109 mm thick)
BOT = {"flat_x": 229.5 - 278.0, "out_x": 40.0, "half_y": 50.0, "back_z": -109.0, "front_z": 25.0, "bore": 1.5 * INCH}
ER32 = {"body_d": 42.0, "body_len": 40.0, "nut_d": 50.0, "nut_len": 22.5, "shank_in": 95.0}


def bot_er32() -> list[tuple[str, cq.Workplane, list[int]]]:
    """The holder block and the collet chuck in it, in a turret station's frame (mm): x out along the station from
    the ID axis, z toward the chuck, the turret's front face at z = 0."""
    b, e = BOT, ER32
    block = (cq.Workplane("XY").box(b["out_x"] - b["flat_x"], 2 * b["half_y"], b["front_z"] - b["back_z"])
             .translate(((b["out_x"] + b["flat_x"]) / 2, 0, (b["front_z"] + b["back_z"]) / 2)))
    block = block.cut(cq.Workplane("XY").circle(b["bore"] / 2).extrude(b["front_z"] - b["back_z"] + 2)
                      .translate((0, 0, b["back_z"] - 1)))
    z0 = b["front_z"]
    shank = cq.Workplane("XY").circle(b["bore"] / 2 - 0.05).extrude(e["shank_in"]).translate((0, 0, z0 - e["shank_in"]))
    body = cq.Workplane("XY").circle(e["body_d"] / 2).extrude(e["body_len"]).translate((0, 0, z0))
    nut = (cq.Workplane("XY").circle(e["nut_d"] / 2).circle(12.0).extrude(e["nut_len"])
           .translate((0, 0, z0 + e["body_len"])))
    chuck = shank.union(body).union(nut)
    return [("holder", block, BLACK_OXIDE), ("er32_chuck", chuck, STEEL)]


def _bbox(shapes) -> dict:
    bb = shapes[0].val().BoundingBox()
    for s in shapes[1:]:
        bb.add(s.val().BoundingBox())
    return {"min": [round(bb.xmin, 2), round(bb.ymin, 2), round(bb.zmin, 2)],
            "max": [round(bb.xmax, 2), round(bb.ymax, 2), round(bb.zmax, 2)]}


def write_collet() -> Path:
    shape = collet_5c(0.625)
    src, lib = G._dirs("workholding", "collet-5c-0625")
    cq.exporters.export(shape, str(src / "collet-5c-0625.step"))
    bb = shape.val().BoundingBox()
    asset = shape.translate((-(bb.xmin + bb.xmax) / 2, 0, -bb.zmin))            # centred along X, resting on z = 0
    tris = G.write_parts_glb([("collet", asset, STEEL)], lib / "collet-5c-0625.glb", 0.02)
    # the station's link: the face flush with the Royal chuck's nose, on the spindle's axis
    st = json.loads((STATIONS / "st25.json").read_text(encoding="utf-8"))
    nose = st["workholding"]["c5"]["nose_x_mm"]
    link = shape.translate((nose, 0, 1005.2))
    out = data_root() / "library" / "machines" / "st25" / "links" / "c5"
    out.mkdir(parents=True, exist_ok=True)
    G.write_parts_glb([("collet", link, STEEL)], out / "collet.glb", 0.02)
    _station_glb_y_up_fix(out / "collet.glb")
    vol = shape.val().Volume()
    rec = {"schema": "setupguide.asset/0.1", "id": "collet-5c-0625", "name": "5C round collet, 5/8 in",
           "category": "workholding", "make": "Hardinge", "model": "5C round collet 5/8 in (10010019 series)",
           "description": "5/8 in round 5C collet for the Royal 42057 collet chuck on the ST-25: drawn in by the drawtube, its 10 deg head closes it on the bar.",
           "generic": True,
           "key_specs": [{"name": "Size", "value": 0.625, "unit": "in"},
                         {"name": "Back bearing diameter", "value": 1.250, "unit": "in"},
                         {"name": "Overall length", "value": 3.281, "unit": "in"},
                         {"name": "Thread", "value": "1.238 x 20 RH"},
                         {"name": "Head diameter", "value": 1.468, "unit": "in"},
                         {"name": "Head angle", "value": 10, "unit": "deg", "note": "a side: 0.003 in of draw a 0.001 in of diameter"},
                         {"name": "Chucking range", "value": "+0.001 / -0.003", "unit": "in"},
                         {"name": "Mass", "value": round(vol / 1000 * 7.85, 1), "unit": "g", "note": "volume x steel's density"}],
           "source_urls": ["https://forkardthardinge.com/wp-content/uploads/2348J_SpindleTooling.pdf",
                           "https://shop.hardinge.com/All-Products/Workholding/Collets/Lathe-Collets/5C-Round-Collet/p/10010017030000"],
           "source_files": ["collet-5c-0625.step", "docs/2348J_SpindleTooling.pdf"],
           "license": "self-made from Hardinge's published dimensions (moonshot.library.lathe_tooling); not the maker's CAD",
           "notes": "Hardinge's catalog gives the back bearing, the overall length, the thread, the head's diameter and its 10 deg angle (its FAQ's 1:3) and the good chucking range. Proposed (no drawing to hand): the head's 2 mm land before its taper, the thread's 12 mm length, three 1.5 mm slots 55 mm long, the bore relieved 1.6 mm a side behind its 25 mm grip, a 0.5 mm chamfer at its mouth; no keyway or internal stop thread. Its asset lies along +X, centred, on z = 0; the ST-25's link is library/machines/st25/links/c5/collet.glb.",
           "file": "collet-5c-0625.glb", "units": "mm", "up": "+Z", "triangles": tris,
           "bbox": _bbox([asset]), "attach_points": [],
           "build": {"from": "source/collet-5c-0625.step", "placeholder": "lathe_tooling.collet_5c", "up": "+Z",
                     "max_triangles": G.MAX_TRIANGLES}}
    path = G._record_path("workholding", "collet-5c-0625")
    G._save(path, rec)
    return path


def _station_glb_y_up_fix(path: Path) -> None:
    """write_parts_glb writes the library's glTF (+Y up); a station's link GLBs are raw Z-up metres, as extract.py
    writes them and the renderer places them: rewrite it so."""
    import numpy as np
    import trimesh
    m = trimesh.load(path, force="mesh")
    v = np.asarray(m.vertices)
    m.vertices = np.column_stack([v[:, 0], -v[:, 2], v[:, 1]])     # undo (x, y, z) -> (x, z, -y)
    m.export(path)


def write_bot_er32() -> Path:
    parts = bot_er32()
    src, lib = G._dirs("tooling", "bot-er32")
    assy = cq.Assembly()
    for n, s, _ in parts:
        assy.add(s, name=n)
    assy.export(str(src / "bot-er32.step"))
    tris = G.write_parts_glb(parts, lib / "bot-er32.glb", 0.02)
    rec = {"schema": "setupguide.asset/0.1", "id": "bot-er32", "name": "BOT20 ID holder with an ER32 collet chuck",
           "category": "tooling", "make": "Haas Tooling",
           "model": "BOT20 1-1/2 in Ø ID static turning holder (04-0757) with a 1-1/2 in straight-shank ER32 collet chuck",
           "description": "An ID station holder bolted round the ST-25's BOT turret, its 1-1/2 in bore on the station's centreline, holding an ER32 collet chuck for the spot drill, the drills and the taps on the spindle's centre.",
           "generic": True,
           "key_specs": [{"name": "Turret", "value": "BOT20 (ST-20, ST-25, ST-30...)"},
                         {"name": "Bore", "value": 1.5, "unit": "in"},
                         {"name": "Collet", "value": "ER32"},
                         {"name": "Nut diameter", "value": ER32["nut_d"], "unit": "mm"}],
           "source_urls": ["https://www.haastooling.com/c/bot20-toolholding",
                           "https://www.haascnc.com/content/dam/haascnc/hfo-microsite/hfo-morris-trident/Morris_Trident_TMT-Haas-Lathe-Set-up.pdf"],
           "source_files": ["bot-er32.step"],
           "license": "self-made from the makers' published sizes (moonshot.library.lathe_tooling); not the makers' CAD",
           "notes": "Haas Tooling lists the BOT20 1-1/2 in ID holder (04-0757) for the ST-25 and says BOT turrets take bolt-on holders round their perimeter; the HFO's set-up course has ID holders bolted to the turret's outside to put the tools on centreline, holding them in a bore with lathe collets. Its seat and bore from the ST-25's turret (moonshot/library/stations/st25.json: the flat 229.5 mm from the turret's centre, the ID axis 278.0, the turret 109 mm thick). Proposed (no drawing to hand): the block 88.5 mm radially (from the flat to 40 mm past the axis), 100 mm wide, from the turret's back face to 25 mm proud of its front; the ER32 chuck's 95 mm of shank in the bore, a 42 mm body 40 mm long and a 50 mm nut 22.5 mm long. In a turret station's frame: x out along the station from the ID axis, z toward the chuck, the turret's front face at z = 0; mount it on the station's site (st25_station_k).",
           "file": "bot-er32.glb", "units": "mm", "up": "+Z", "triangles": tris,
           "bbox": _bbox([s for _, s, _ in parts]), "attach_points": [],
           "build": {"from": "source/bot-er32.step", "placeholder": "lathe_tooling.bot_er32", "up": "+Z",
                     "max_triangles": G.MAX_TRIANGLES}}
    path = G._record_path("tooling", "bot-er32")
    G._save(path, rec)
    return path


if __name__ == "__main__":
    print(write_collet())
    print(write_bot_er32())
