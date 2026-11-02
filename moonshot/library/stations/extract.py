"""Split a machine's vendor STEP into its moving links (plan §6, track C): one GLB per link, in the shop's world frame.

The Haas VF-2 STEP is organised by link (base, saddle, table, spindle head, doors, tool changer...), so each top-level
component is a link. The world frame is the one trainual's scenes use, with the table top at z = 853 mm and the
operator at -Y; from the STEP's frame (Y up) it is world = (x, 352 - z, y + 505) mm, found from the floor pads and
the enclosure's extent. Writes <data root>/library/machines/<id>/links/<link>.glb and, committed beside the station
record, links.json with each link's world bounds.

    python -m moonshot.library.stations.extract vf2
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root

STATIONS = Path(__file__).resolve().parent
SOURCES = {"vf2": "machines/vf2/VF-2_STEP__1_2023.step"}
# STEP (x, y, z) mm -> world (x, 352 - z, y + 505) mm
TO_WORLD = (np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]]), np.array([0.0, 352.0, 505.0]))
LINKS = {   # STEP component -> link
    "vf2": {"BASE_VF-2_1_2023": "base", "SADDLE_VF-2_1_2023": "saddle", "TABLE_VF-2_1_2023": "table",
            "SPINDLE HEAD_VF-2_1_2023": "head", "ENCLOSURE_VF-2_1_2023": "enclosure",
            "SIDE DOORS_VF-2_1_2023": "side_doors", "PENDANT_VF-2_1_2023": "pendant",
            "20-PKT UTC_VF-2_1_2023": "carousel", "CONV PKG_VF-2_1_2023": "conveyor",
            "EES_VF-2_1_2023": "exhaust", "PADS_VF-2_1_2023": "pads", "HAAS P-COOL_VF-2_1_2023": "coolant"},
}
SUBLINKS = {"vf2": {"37-0400-LEFT DOOR": "door_left", "37-0400-RIGHT DOOR": "door_right",
                    "40T Spindle_37-4212": "spindle"}}


def read_components(step: Path):
    """(name, shape) for the STEP's top-level components and, for those in SUBLINKS, their children."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.ReadFile(str(step))
    reader.Transfer(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)

    def name(label):
        attr = TDataStd_Name()
        return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else "?"

    def children(label):
        seq = TDF_LabelSequence()
        tool.GetComponents_s(label, seq)
        for i in range(1, seq.Length() + 1):
            comp, ref = seq.Value(i), TDF_Label()
            tool.GetReferredShape_s(comp, ref)
            yield comp, ref

    for comp, ref in children(roots.Value(1)):
        yield name(ref), tool.GetShape_s(comp)
        for sub_comp, sub_ref in children(ref):
            loc = tool.GetLocation_s(comp)
            shape = tool.GetShape_s(sub_comp).Moved(loc)
            yield name(sub_ref), shape
    _ = BRepBuilderAPI_Transform                            # (imported for symmetry with other readers)


def to_world_mesh(shape, tolerance_mm: float = 0.8):
    """Tessellate an OCC shape and map it into the world frame, in metres, as a trimesh."""
    import cadquery as cq
    import trimesh
    verts, faces = cq.Shape.cast(shape).tessellate(tolerance_mm, 0.5)
    if not faces:
        return None
    R, t = TO_WORLD
    v = (np.array([(p.x, p.y, p.z) for p in verts]) @ R.T + t) * 0.001
    return trimesh.Trimesh(v, np.array(faces), process=True)


def extract(station: str) -> dict:
    out_dir = data_root() / "library" / "machines" / station / "links"
    out_dir.mkdir(parents=True, exist_ok=True)
    meshes: dict[str, list] = {}
    for comp_name, shape in read_components(data_root() / "originals" / SOURCES[station]):
        link = LINKS[station].get(comp_name) or SUBLINKS[station].get(comp_name)
        if link is None:
            continue
        mesh = to_world_mesh(shape)
        if mesh is not None:
            meshes.setdefault(link, []).append(mesh)
    import trimesh
    manifest = {}
    # sub-links (doors, spindle) are cut out of their parents' meshes by being exported separately; their parent
    # component also contains them, so parents are rebuilt without their sub-links' geometry where they overlap
    for link, parts in meshes.items():
        mesh = trimesh.util.concatenate(parts)
        if link in ("head",) and "spindle" in meshes:
            pass                                           # the spindle stays drawn in the head; it only turns
        mesh.export(out_dir / f"{link}.glb")
        lo, hi = mesh.bounds * 1000
        manifest[link] = {"min_mm": [round(v, 1) for v in lo], "max_mm": [round(v, 1) for v in hi],
                          "triangles": int(len(mesh.faces))}
    (STATIONS / f"{station}.links.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    for k, v in extract(sys.argv[1]).items():
        print(f"{k:12s} {v}")
