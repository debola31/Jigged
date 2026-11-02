"""Parametric generators for catalogue tools (plan §6, track B): one function per family, so one generator yields every
size of that tool with correct geometry, mass and a record, instead of each being modelled by hand.

Tools stand tip down at the origin, shank up +Z, in millimetres (the asset library's convention). The fluted body is
the family's cross-section twist-extruded at its helix angle; the point or ball is cut on afterwards.

    python -m moonshot.library.generators            # writes every tool in TOOLS that the catalogue lacks
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import cadquery as cq

from moonshot.config import data_root

RECORDS = Path(__file__).resolve().parent / "records" / "assets"
DENSITY_G_CC = {"HSS": 8.1, "cobalt HSS": 8.2, "carbide": 14.5}


@dataclass(frozen=True)
class Tool:
    id: str
    family: str                  # drill | reamer | tap | ball_end_mill
    name: str
    dia_mm: float
    flute_mm: float
    overall_mm: float
    material: str
    flutes: int
    helix_deg: float = 30.0
    point_deg: float = 135.0
    thread: str | None = None


TOOLS = [
    Tool("drill-2p5", "drill", "2.5 mm jobber drill", 2.5, 30, 57, "cobalt HSS", 2),
    Tool("drill-5p5", "drill", "5.5 mm jobber drill", 5.5, 57, 93, "cobalt HSS", 2),
    Tool("drill-6", "drill", "6 mm jobber drill", 6.0, 63, 93, "cobalt HSS", 2),
    Tool("drill-7", "drill", "7 mm jobber drill", 7.0, 69, 109, "cobalt HSS", 2),
    Tool("ream-3p5", "reamer", "3.5 mm machine reamer, G6", 3.5, 20, 70, "carbide", 6, helix_deg=0.0),
    Tool("tap-m3", "tap", "M3x0.5 spiral-point tap", 3.0, 12, 56, "HSS", 3, helix_deg=0.0, thread="M3x0.5-6H"),
    Tool("bem14", "ball_end_mill", "1/4 in ball end mill", 6.35, 19.05, 63.5, "carbide", 2),
]


def fluted_body(t: Tool) -> cq.Workplane:
    """The cutting part: the family's cross-section (a circle with its flute gullets cut out) twist-extruded along
    the helix, so the flutes are one swept profile rather than separate boolean cuts."""
    r = t.dia_mm / 2
    gullet = r * (0.55 if t.family == "drill" else 0.35)
    centres = [(math.cos(2 * math.pi * i / t.flutes) * r * 0.95, math.sin(2 * math.pi * i / t.flutes) * r * 0.95)
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


def build(t: Tool) -> cq.Workplane:
    r = t.dia_mm / 2
    body = fluted_body(t)
    shank = cq.Workplane("XY").workplane(offset=t.flute_mm).circle(r).extrude(t.overall_mm - t.flute_mm)
    tool = body.union(shank)
    if t.family in ("drill", "tap"):
        # a cone point: cut away everything below the cone of the point angle (tap: a short chamfer lead)
        h = r / math.tan(math.radians(t.point_deg / 2)) if t.family == "drill" else r * 0.6
        keep = cq.Workplane("XZ").polyline([(0, 0), (r * 1.01, h), (r * 1.01, t.overall_mm + 1), (0, t.overall_mm + 1)]) \
            .close().revolve(360, (0, 0, 0), (0, 1, 0))
        tool = tool.intersect(keep)
    elif t.family == "ball_end_mill":
        ball = cq.Workplane("XY").sphere(r).translate((0, 0, r))
        above = cq.Workplane("XY").workplane(offset=r).circle(r * 1.01).extrude(t.overall_mm)
        tool = tool.intersect(ball.union(above))
    elif t.family == "reamer":
        # a 45 degree lead on the tip, cut by revolving its profile (chamfering fluted edges fails in OCC)
        top = t.overall_mm + 1
        keep = cq.Workplane("XZ").polyline([(0, 0), (r * 0.85, 0), (r * 1.01, r * 0.16), (r * 1.01, top), (0, top)])             .close().revolve(360, (0, 0, 0), (0, 1, 0))
        tool = tool.intersect(keep)
    return tool


def record(t: Tool, shape: cq.Workplane) -> dict:
    vol_cc = shape.val().Volume() / 1000
    mass_g = vol_cc * DENSITY_G_CC[t.material]
    bb = shape.val().BoundingBox()
    specs = [{"name": "Diameter", "value": t.dia_mm, "unit": "mm"},
             {"name": "Flute length", "value": t.flute_mm, "unit": "mm"},
             {"name": "Overall length", "value": t.overall_mm, "unit": "mm"},
             {"name": "Flutes", "value": t.flutes, "unit": "flutes"},
             {"name": "Material", "value": t.material},
             {"name": "Mass", "value": round(mass_g, 2), "unit": "g", "note": "volume x material density"}]
    if t.thread:
        specs.insert(0, {"name": "Thread", "value": t.thread})
    if t.family == "drill":
        specs.append({"name": "Point angle", "value": t.point_deg, "unit": "deg"})
    return {
        "schema": "setupguide.asset/0.1", "id": t.id, "name": t.name, "category": "tooling",
        "make": "Generic", "model": f"{t.family} {t.dia_mm:g} mm",
        "description": f"{t.name}, {t.material}, {t.flutes} flutes.",
        "generic": True, "key_specs": specs, "source_urls": [], "source_files": [f"{t.id}.step"],
        "license": f"self-made parametric generator (moonshot.library.generators, family {t.family})",
        "notes": "Generated from its dimensions; replace with a vendor STEP when one is sourced.",
        "file": f"{t.id}.glb", "units": "mm", "up": "+Z",
        "bbox": {"min": [round(bb.xmin, 2), round(bb.ymin, 2), round(bb.zmin, 2)],
                 "max": [round(bb.xmax, 2), round(bb.ymax, 2), round(bb.zmax, 2)]},
        "attach_points": [],
        "build": {"from": f"source/{t.id}.step", "placeholder": f"generators.{t.family}", "up": "+Z", "max_triangles": 50000},
    }


def write_glb(shape: cq.Workplane, path: Path, tolerance_mm: float = 0.01) -> int:
    """glTF is metres and +Y up; the library's geometry is millimetres and +Z up."""
    import numpy as np
    import trimesh
    verts, faces = shape.val().tessellate(tolerance_mm, 0.08)
    v = np.array([(p.x, p.y, p.z) for p in verts]) * 0.001
    v = v[:, [0, 2, 1]] * np.array([1.0, 1.0, -1.0])            # (x, y, z) -> (x, z, -y)
    mesh = trimesh.Trimesh(v, np.array(faces), process=True)
    mesh.visual.face_colors = [184, 184, 191, 255]
    mesh.export(path, include_normals=True)          # smooth shading: no faceted flutes in close-ups
    return len(mesh.faces)


def write(t: Tool) -> Path:
    shape = build(t)
    src = data_root() / "originals" / "tooling" / t.id
    lib = data_root() / "library" / "tooling" / t.id
    src.mkdir(parents=True, exist_ok=True)
    lib.mkdir(parents=True, exist_ok=True)
    cq.exporters.export(shape, str(src / f"{t.id}.step"))
    triangles = write_glb(shape, lib / f"{t.id}.glb")
    rec_dir = RECORDS / "tooling" / t.id
    rec_dir.mkdir(parents=True, exist_ok=True)
    out = rec_dir / f"{t.id}.json"
    rec = record(t, shape) | {"triangles": triangles}
    out.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    return out


def main() -> None:
    for t in TOOLS:
        print("wrote", write(t))


if __name__ == "__main__":
    main()
