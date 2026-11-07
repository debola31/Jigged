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

The inspection bench's height gauge and surface plate are one placeholder STEP (the hgauge asset), split so the plate
stays on the bench while the gauge moves. Each is in its own frame rather than a world frame: the plate's with its
underside centred at the origin, the gauge's the same frame lowered by the plate's 76.2 mm, so the gauge's underside
is at z = 0 and it rests at any surface's height. The STEP's demonstration part is left out. Links go to
<data root>/library/<category>/<asset>/links/, beside the STEP's own asset.

The Haas ST-25 STEP (Haas's one model of the ST-20 and ST-25, every option in place) is a deep tree, so its links are
picked by component path (ST25_PATHS): the most specific path named wins, an unnamed component goes with its nearest
named ancestor, and everything else is the base; the options the shop doesn't have, and Haas's own chucks, are left
out (ST25_EXCLUDE). Its world frame puts the floor at z = 0 (the levelling pads' feet), the spindle's axis along +X at
y = 0 and the operator at -Y: world = (x, -z, y + 1005.2) mm. Its workholding comes from its makers' STEPs, each
moved onto the spindle nose (WORKHOLDING): the Kitagawa BR10 3-jaw with its jaws fully open (the UC file), its body
and each jaw a link, and Royal's 42057 collet chuck. Its links.json carries volumes and inertias as the band saw's.

    python -m moonshot.library.stations.extract vf2

The links come out as positions only. The VF-2's take their materials and normals from moonshot/render/dress.py,
which rewrites them in place: after re-extracting the VF-2, run it again, or the render draws the machine unpainted.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root

STATIONS = Path(__file__).resolve().parent
SOURCES = {"vf2": "machines/vf2/VF-2_STEP__1_2023.step",
           "bandsaw": "machines/bandsaw/8962N13_Horizontal Band Saw for Metal.STEP",
           "inspection_bench": "inspection/hgauge/hgauge.step",
           "st25": "machines/st25/ST20-25_Reboot_2-axis_STEP_2019-05.STEP"}
Y_UP = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])
TO_WORLD = {"vf2": (Y_UP, np.array([0.0, 352.0, 505.0])),          # STEP (x, y, z) -> (x, 352 - z, y + 505) mm
            "bandsaw": (Y_UP, np.array([0.0, -395.0, 406.8])),     # STEP (x, y, z) -> (x, -z - 395, y + 406.8) mm
            "inspection_bench": (np.eye(3), np.zeros(3)),             # already Z up, the plate's underside centred
            "st25": (Y_UP, np.array([0.0, 0.0, 1005.2]))}             # STEP (x, y, z) -> (x, -z, y + 1005.2) mm
# The ST-25's links by component path (top-level name, then child names); "base" for everything not named
ST25_PATHS = {
    ("Door",): "door",
    ("BOT Turret (ST20)",): "turret",
    ("X Axis - Turret(37-3842)",): "xslide",
    ("Z Axis Assembly",): "zslide",
    ("Z Axis Assembly", "10000094280"): "zcover_left",      # the telescopic way covers either side of the saddle
    ("Z Axis Assembly", "10000093407"): "zcover_right",
    ("Main Spindle", "Face ring"): "spindle",
    ("Main Spindle", "Drawtube1"): "drawtube",
    ("Enclosure(Default)", "Control (Thin Style)"): "pendant",
    ("Tool Setting Probe(Default)", "Tool Probe assembly", "tre"): "probe_arm",   # the arm and its stylus swing
    ("Tool Setting Probe(Default)", "Tool Probe assembly", "kj"): "probe_arm",
}
ST25_EXCLUDE = {"ST15 8 Inch - 200mm Chuck(DEFAULT)", "ST-20Y CHUCK 10inch", "ST-20 Tailstock Option",
                "ST-20 Sub Spindle", "5 Inch Chuck (ST20 Sub Spindle)(RETRACT)", "BMT65 Turret", "VDI Turret ST20-25r2"}
# The ST-25's workholding, from its makers' STEPs: each moved so its back face sits on the spindle nose's face
# (x = 39.7 in the world frame, where Haas's own chucks in the STEP seat), its axis on the spindle's; R_from maps the
# file's frame into the world's, and back_mm is the file's x at the chuck's back face. A STEP component goes to the
# link its name's first match in `links` gives, the rest to the body.
NOSE_X_MM, AXIS_Z_MM = 39.7, 1005.2
WORKHOLDING = {
    "br10": {"file": "workholding/chuck3/DEV-BR10-UC.STEP", "R_from": Y_UP, "back_mm": -100.6,
             "links": {"SB10B1": "jaw", "Plus-T": "jaw", "M12": "jaw"}, "rest": "body", "tess": (0.15, 0.1)},
    "c5": {"file": "workholding/c5/220473-0-42057.stp", "R_from": None, "back_mm": None, "links": {}, "rest": "body",
           "tess": (0.05, 0.05)},
}
LINK_ORIGIN_MM = {"inspection_bench": {"height_gauge": [0.0, 0.0, 76.2]}}   # where a link's own frame sits
LINKS = {   # STEP component -> link
    "vf2": {"BASE_VF-2_1_2023": "base", "SADDLE_VF-2_1_2023": "saddle", "TABLE_VF-2_1_2023": "table",
            "SPINDLE HEAD_VF-2_1_2023": "head", "ENCLOSURE_VF-2_1_2023": "enclosure",
            "SIDE DOORS_VF-2_1_2023": "side_doors", "PENDANT_VF-2_1_2023": "pendant",
            "20-PKT UTC_VF-2_1_2023": "carousel", "CONV PKG_VF-2_1_2023": "conveyor",
            "EES_VF-2_1_2023": "exhaust", "PADS_VF-2_1_2023": "pads", "HAAS P-COOL_VF-2_1_2023": "coolant"},
    "inspection_bench": {"surface_plate": "plate", "base": "height_gauge", "column": "height_gauge",
                         "slider_display": "height_gauge", "scriber": "height_gauge"},
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


def read_paths(step: Path, paths: dict, exclude: set):
    """(link, shape) for every leaf component of a STEP's tree: a component goes with the most specific path in
    `paths` it lies under, "base" if none; components named in `exclude` are left out with all they contain."""
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
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

    def walk(label, loc, path, link):
        seq = TDF_LabelSequence()
        tool.GetComponents_s(label, seq)
        for i in range(1, seq.Length() + 1):
            comp, ref = seq.Value(i), TDF_Label()
            tool.GetReferredShape_s(comp, ref)
            p = path + (name(ref),)
            if p[-1] in exclude:
                continue
            loc_i = loc.Multiplied(tool.GetLocation_s(comp))
            here = paths.get(p, link)
            sub = TDF_LabelSequence()
            tool.GetComponents_s(ref, sub)
            if sub.Length():
                yield from walk(ref, loc_i, p, here)
            else:
                yield here, tool.GetShape_s(ref).Moved(loc_i)

    yield from walk(roots.Value(1), TopLoc_Location(), (), "base")


def _leaves(step: Path):
    """(component name, shape) for each leaf of a STEP's tree, in place: a maker's small assembly (a chuck)."""
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
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

    def walk(label, loc):
        seq = TDF_LabelSequence()
        tool.GetComponents_s(label, seq)
        if not seq.Length():
            yield name(label), tool.GetShape_s(label).Moved(loc)
        for i in range(1, seq.Length() + 1):
            comp, ref = seq.Value(i), TDF_Label()
            tool.GetReferredShape_s(comp, ref)
            yield from walk(ref, loc.Multiplied(tool.GetLocation_s(comp)))

    for k in range(1, roots.Length() + 1):
        yield from walk(roots.Value(k), TopLoc_Location())


def workholding_world(key: str):
    """(R, t) taking a workholding STEP's frame (mm) into the ST-25's world frame: its axis onto the spindle's, its
    back face onto the nose's face. The Royal's STEP has its axis at y = -11.65 and its flange's back at x = -65.2."""
    w = WORKHOLDING[key]
    if key == "c5":
        return Y_UP, np.array([NOSE_X_MM + 65.2, 0.0, AXIS_Z_MM + 11.65])
    return w["R_from"], np.array([NOSE_X_MM - w["back_mm"], 0.0, AXIS_Z_MM])


def extract_workholding(key: str) -> dict:
    """A chuck's links, in the ST-25's world frame at joint zero (spindle at 0, jaws fully open): the BR10's body and
    its three jaws, numbered from the one standing up (+Z) round toward -Y (the operator), each with its soft jaw,
    T-nut and bolts; the Royal's body (its STEP's plug, a stand-in for a collet, is left out: moonshot/world/st25.py
    builds the 5C collet)."""
    import cadquery as cq
    import trimesh
    w = WORKHOLDING[key]
    R, t = workholding_world(key)
    out_dir = data_root() / "library" / "machines" / "st25" / "links" / key
    out_dir.mkdir(parents=True, exist_ok=True)
    shapes: dict[str, list] = {}
    for nm, shape in _leaves(data_root() / "originals" / w["file"]):
        if "PLUG" in nm:
            continue
        link = next((v for k, v in w["links"].items() if k in nm), w["rest"])
        if link == "jaw":
            c = cq.Shape.cast(shape).Center()
            p = R @ np.array([c.x, c.y, c.z]) + t
            ang = np.degrees(np.arctan2(p[2] - AXIS_Z_MM, p[1]))         # from +Y toward +Z, about +X
            link = f"jaw_{round(((90.0 - ang) % 360) / 120.0) % 3}"
        shapes.setdefault(link, []).append(shape)
    manifest = {}
    for link, parts in shapes.items():
        meshes = []
        for shape in parts:
            # fine (WORKHOLDING tess: mm, rad): the camera comes close at the chuck, where 0.3 rad drew it faceted
            verts, faces = cq.Shape.cast(shape).tessellate(*w["tess"])
            if faces:
                v = (np.array([(q.x, q.y, q.z) for q in verts]) @ R.T + t) * 0.001
                meshes.append(trimesh.Trimesh(v, np.array(faces), process=True))
        mesh = trimesh.util.concatenate(meshes)
        mesh.export(out_dir / f"{link}.glb")
        lo, hi = mesh.bounds * 1000
        manifest[f"{key}/{link}"] = {"min_mm": [round(v, 1) for v in lo], "max_mm": [round(v, 1) for v in hi],
                                     "triangles": int(len(mesh.faces)),
                                     **_mass_rt(parts, R, t)}
    return manifest


def _mass_rt(shapes, R, t) -> dict:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    total = GProp_GProps()
    for s in shapes:
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(s, p)
        total.Add(p)
    c, mi = total.CentreOfMass(), total.MatrixOfInertia()
    inertia = R @ np.array([[mi.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)]) @ R.T * 1e-12
    return {"volume_cm3": round(total.Mass() / 1000, 2),
            "com_mm": [round(v, 1) for v in R @ np.array([c.X(), c.Y(), c.Z()]) + t],
            "inertia_kg_m2_at_1g_cm3": [round(inertia[i, j], 6) for i, j in ((0, 0), (1, 1), (2, 2), (0, 1), (0, 2),
                                                                              (1, 2))]}


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


def to_world_mesh(shape, station: str, link: str = "", tolerance_mm: float = 0.8):
    """Tessellate an OCC shape and map it into the world frame (or the link's own), in metres, as a trimesh."""
    import cadquery as cq
    import trimesh
    verts, faces = cq.Shape.cast(shape).tessellate(tolerance_mm, 0.5)
    if not faces:
        return None
    R, t = TO_WORLD[station]
    t = t - np.array(LINK_ORIGIN_MM.get(station, {}).get(link, [0.0, 0.0, 0.0]))
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
    out_dir = data_root() / "library" / Path(SOURCES[station]).parent / "links"
    out_dir.mkdir(parents=True, exist_ok=True)
    step = data_root() / "originals" / SOURCES[station]
    meshes: dict[str, list] = {}
    shapes: dict[str, list] = {}
    if station in SOLID_LINKS:
        owner = {i: link for link, ids in SOLID_LINKS[station].items() for i in ids}
        for i, solid in enumerate(read_solids(step)):
            shapes.setdefault(owner.get(i, "base"), []).append(solid)
    elif station == "st25":
        for link, shape in read_paths(step, ST25_PATHS, ST25_EXCLUDE):
            shapes.setdefault(link, []).append(shape)
    else:
        for comp_name, shape in read_components(step):
            link = LINKS[station].get(comp_name) or SUBLINKS.get(station, {}).get(comp_name)
            if link is not None:
                shapes.setdefault(link, []).append(shape)
    for link, parts in shapes.items():
        for shape in parts:
            mesh = to_world_mesh(shape, station, link)
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
        if station in SOLID_LINKS or station == "st25":
            manifest[link] |= mass_properties(shapes[link], station)
    if station == "st25":
        for key in WORKHOLDING:
            manifest |= extract_workholding(key)
    (STATIONS / f"{station}.links.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    if sys.argv[1:] == ["st25", "--workholding"]:            # the chucks alone, merged into st25.links.json
        path = STATIONS / "st25.links.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for key in WORKHOLDING:
            manifest |= extract_workholding(key)
        path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
        sys.exit(0)
    for k, v in extract(sys.argv[1]).items():
        print(f"{k:12s} {v}")
