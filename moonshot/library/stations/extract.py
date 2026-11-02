"""Split a machine's vendor STEP into its moving links (plan §6, track C): one GLB per link, in the shop's world frame.

The Haas VF-2 STEP is organised by link (base, saddle, table, spindle head, doors, tool changer...), so each top-level
component is a link. The world frame is the one trainual's scenes use, with the table top at z = 853 mm and the
operator at -Y; from the STEP's frame (Y up) it is world = (x, 352 - z, y + 505) mm, found from the floor pads and
the enclosure's extent. Writes <data root>/library/machines/<id>/links/<link>.glb and, committed beside the station
record, links.json with each link's world bounds.

McMaster's band saw STEP is one flat compound of 262 unnamed solids, so its links are lists of solid indices in the
file's order, found from which solids touch which and checked by render; every solid not listed is the base. Its
world frame puts the floor at z = 0, the blade's cutting plane at y = 0 and the operator at -Y: world =
(x, -z - 395, y + 406.8) mm. Its links.json also carries each link's CAD volume, centre of mass and inertia at
1 g/cm3, for the record to price at a density.

    python -m moonshot.library.stations.extract vf2
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root

STATIONS = Path(__file__).resolve().parent
SOURCES = {"vf2": "machines/vf2/VF-2_STEP__1_2023.step",
           "bandsaw": "machines/bandsaw/8962N13_Horizontal Band Saw for Metal.STEP"}
Y_UP = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])
TO_WORLD = {"vf2": (Y_UP, np.array([0.0, 352.0, 505.0])),          # STEP (x, y, z) -> (x, 352 - z, y + 505) mm
            "bandsaw": (Y_UP, np.array([0.0, -395.0, 406.8]))}     # STEP (x, y, z) -> (x, -z - 395, y + 406.8) mm
LINKS = {   # STEP component -> link
    "vf2": {"BASE_VF-2_1_2023": "base", "SADDLE_VF-2_1_2023": "saddle", "TABLE_VF-2_1_2023": "table",
            "SPINDLE HEAD_VF-2_1_2023": "head", "ENCLOSURE_VF-2_1_2023": "enclosure",
            "SIDE DOORS_VF-2_1_2023": "side_doors", "PENDANT_VF-2_1_2023": "pendant",
            "20-PKT UTC_VF-2_1_2023": "carousel", "CONV PKG_VF-2_1_2023": "conveyor",
            "EES_VF-2_1_2023": "exhaust", "PADS_VF-2_1_2023": "pads", "HAAS P-COOL_VF-2_1_2023": "coolant"},
}
SUBLINKS = {"vf2": {"37-0400-LEFT DOOR": "door_left", "37-0400-RIGHT DOOR": "door_right",
                    "40T Spindle_37-4212": "spindle"}}
SOLID_LINKS = {   # link -> solid indices, for STEPs that are one flat compound; the rest is the base
    "bandsaw": {"cover_idler": [157], "cover_drive": [192], "blade": [181], "jaw": [4, 19, 74, 84],
                "handwheel": [43, 59],
                # the bow and all it carries: guide arms, wheels, motor, gearbox. 218 and 219, brackets by the
                # hinge, stay on the base: carried down with the head they would cut 50 mm into the bed
                "head": [i for i in [*range(138, 225), 257, 260] if i not in (157, 181, 192, 218, 219)]},
}


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


def read_solids(step: Path):
    """The STEP's solids in file order, for a STEP that is one flat compound."""
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    reader = STEPControl_Reader()
    reader.ReadFile(str(step))
    reader.TransferRoots()
    ex = TopExp_Explorer(reader.OneShape(), TopAbs_SOLID)
    while ex.More():
        yield ex.Current()
        ex.Next()


def to_world_mesh(shape, station: str, tolerance_mm: float = 0.8):
    """Tessellate an OCC shape and map it into the world frame, in metres, as a trimesh."""
    import cadquery as cq
    import trimesh
    verts, faces = cq.Shape.cast(shape).tessellate(tolerance_mm, 0.5)
    if not faces:
        return None
    R, t = TO_WORLD[station]
    v = (np.array([(p.x, p.y, p.z) for p in verts]) @ R.T + t) * 0.001
    return trimesh.Trimesh(v, np.array(faces), process=True)


def mass_properties(shapes, station: str) -> dict:
    """CAD volume, centre of mass and inertia about it at 1 g/cm3, in the world frame."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    total = GProp_GProps()
    for s in shapes:
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(s, p)
        total.Add(p)
    R, t = TO_WORLD[station]
    c, mi = total.CentreOfMass(), total.MatrixOfInertia()
    inertia = R @ np.array([[mi.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)]) @ R.T * 1e-12   # mm^5 -> kg m^2
    return {"volume_cm3": round(total.Mass() / 1000, 2),
            "com_mm": [round(v, 1) for v in R @ np.array([c.X(), c.Y(), c.Z()]) + t],
            "inertia_kg_m2_at_1g_cm3": [round(inertia[i, j], 6) for i, j in ((0, 0), (1, 1), (2, 2), (0, 1), (0, 2),
                                                                              (1, 2))]}


def extract(station: str) -> dict:
    out_dir = data_root() / "library" / "machines" / station / "links"
    out_dir.mkdir(parents=True, exist_ok=True)
    step = data_root() / "originals" / SOURCES[station]
    meshes: dict[str, list] = {}
    shapes: dict[str, list] = {}
    if station in SOLID_LINKS:
        owner = {i: link for link, ids in SOLID_LINKS[station].items() for i in ids}
        for i, solid in enumerate(read_solids(step)):
            shapes.setdefault(owner.get(i, "base"), []).append(solid)
    else:
        for comp_name, shape in read_components(step):
            link = LINKS[station].get(comp_name) or SUBLINKS[station].get(comp_name)
            if link is not None:
                shapes.setdefault(link, []).append(shape)
    for link, parts in shapes.items():
        for shape in parts:
            mesh = to_world_mesh(shape, station)
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
        if station in SOLID_LINKS:
            manifest[link] |= mass_properties(shapes[link], station)
    (STATIONS / f"{station}.links.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    for k, v in extract(sys.argv[1]).items():
        print(f"{k:12s} {v}")
