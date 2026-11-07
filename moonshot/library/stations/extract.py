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

The surface grinder's STEP (GrabCAD, a 10 x 24 manual grinder with no maker) is one flat compound of 55 solids, split
the same way. Its world frame puts the floor at z = 0, the table's middle at x = 0, the wheel's mid-plane at y = 0
and the operator at -Y: world = (x, 88.7 - z, y) mm. It has no control box, so one is made here (control_box_mesh):
the buttons South Bend's SB1029 manual names, on a box beside the base's right side (sgrind.json's controls link).

The inspection bench's height gauge and surface plate are one placeholder STEP (the hgauge asset), split so the plate
stays on the bench while the gauge moves. Each is in its own frame rather than a world frame: the plate's with its
underside centred at the origin, the gauge's the same frame lowered by the plate's 76.2 mm, so the gauge's underside
is at z = 0 and it rests at any surface's height. The STEP's demonstration part is left out. Links go to
<data root>/library/<category>/<asset>/links/, beside the STEP's own asset.

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
           "sgrind": "machines/sgrind/Surface Grinder Machine.STEP"}
Y_UP = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])
TO_WORLD = {"vf2": (Y_UP, np.array([0.0, 352.0, 505.0])),          # STEP (x, y, z) -> (x, 352 - z, y + 505) mm
            "bandsaw": (Y_UP, np.array([0.0, -395.0, 406.8])),     # STEP (x, y, z) -> (x, -z - 395, y + 406.8) mm
            "sgrind": (Y_UP, np.array([0.0, 88.7, 0.0])),          # STEP (x, y, z) -> (x, 88.7 - z, y) mm
            "inspection_bench": (np.eye(3), np.zeros(3))}             # already Z up, the plate's underside centred
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
    # the base is the pedestal (54) and the column (42). The table carries the chuck (47 its body, 21 its top plate,
    # 9-20 and 22-33 the 24 strips set in it), its end splash guards (0, 1) and the two table stops (51, 52); the
    # saddle the centre stop (48-50) the table stops meet; the wheelhead the guard and its front plate (3, 4); the
    # spindle the wheel (6), its flanges (2, 8) and blotters (5, 7). 43 is the down-feed handwheel's shaft, 44 its
    # graduated dial
    "sgrind": {"saddle": [34, 48, 49, 50], "table": [41, 0, 1, 51, 52],
               "chuck": [47, 21, *range(9, 21), *range(22, 34)],
               "chuck_lever": [53], "wheelhead": [3, 4], "spindle": [2], "wheel_gwheel": [5, 6, 7, 8],
               "table_handwheel": [35, 36, 37], "cross_handwheel": [38, 39, 40],
               "downfeed_handwheel": [43, 45, 46], "downfeed_dial": [44]},
}


def control_box_mesh(station: str):
    """The grinder's control box, which its STEP lacks (world frame, metres): a steel box on a bracket off the base's
    right side, its face toward the operator, with SB1029's ON button (green, flush), OFF button (red mushroom, push
    to stop, twist to reset) and power light. Placed where it is reachable from the front right and clears the
    saddle (x <= 385 mm) and the table (z >= 919 mm) through their travel; its numbers are sgrind.json's."""
    import trimesh

    def box(lo, hi):
        lo, hi = np.asarray(lo, float), np.asarray(hi, float)
        return trimesh.creation.box(extents=(hi - lo) * 0.001,
                                    transform=trimesh.transformations.translation_matrix((lo + hi) / 2 * 0.001))
    r = json.loads((STATIONS / f"{station}.json").read_text(encoding="utf-8"))
    c = r["colliders"]["controls_box"]
    # the box, and its bracket: a plate bolted to the base's right side (x 280) just in front of nothing, under the
    # saddle (whose bottom is at z 750 at its front lip, 801 behind it), out and forward to a riser under the box
    parts = [(box(c["box_min_mm"], c["box_max_mm"]), "sgrind_box"),
             (box([280.0, -350.0, 728.0], [440.0, -330.0, 745.0]), "sgrind_box"),
             (box([420.0, -440.0, 728.0], [440.0, -330.0, 745.0]), "sgrind_box"),
             (box([420.0, -440.0, 745.0], [440.0, -420.0, 780.0]), "sgrind_box")]
    for name, radius, depth, paint in (("start", 0.011, 0.004, "sgrind_green"), ("stop", 0.02, 0.022, "sgrind_red"),
                                       ("power_light", 0.008, 0.006, "sgrind_lamp"),
                                       ("coolant_switch", 0.005, 0.010, "grip_black")):
        at = np.array(r["affordances"][name]["at_mm"]) * 0.001
        cyl = trimesh.creation.cylinder(radius=radius, height=depth)
        cyl.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))   # its axis along y
        cyl.apply_translation(at + np.array([0.0, depth / 2, 0.0]))                          # standing out of the face
        parts.append((cyl, paint))
    return parts


def wheel_mesh(station: str, wheel_id: str, on_spindle: bool = True):
    """A wheel the grinder mounts that its STEP doesn't draw, from sgrind.json's wheels: its disc (the diamond rim
    and the core, one thickness, a 1A1R) between its two flanges. On the spindle (the world frame, metres), or, for
    its own asset, lying on z = 0 with its axis +Z (the library's convention), in millimetres."""
    import trimesh
    r = json.loads((STATIONS / f"{station}.json").read_text(encoding="utf-8"))
    w, at = r["wheels"][wheel_id], np.array(r["joints"]["spindle"]["at_mm"], float)
    bore = w["bore_mm"] / 2
    fl, f0, f1 = w["flange_mm"]
    y0, y1 = w["y_mm"]
    rings = [(w["dia_mm"] / 2, y0, y1), (fl / 2, f0, f1), (fl / 2, -f1, -f0)]     # the disc, the front and back flange
    parts = []
    for k, (radius, a, b) in enumerate(rings):
        ring = trimesh.creation.annulus(r_min=bore, r_max=radius, height=b - a, sections=96)
        ring.apply_translation([0.0, 0.0, (a + b) / 2])           # its axis along z, its mid-plane at z = 0 (mm)
        parts.append((ring, "sgrind_diamond" if k == 0 else "ground_steel"))
    if not on_spindle:
        mesh = trimesh.util.concatenate([m for m, _ in parts])
        mesh.apply_translation([0.0, 0.0, -mesh.bounds[0][2]])
        return mesh
    for m, _ in parts:
        m.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))      # z -> y
        m.apply_translation([at[0], 0.0, at[2]])
        m.apply_scale(0.001)
    return parts


def _tube(a, b, radius_mm: float):
    """A round tube from a to b (mm), in metres."""
    import trimesh
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = trimesh.creation.cylinder(radius=radius_mm, height=float(np.linalg.norm(b - a)), sections=24)
    t.apply_transform(trimesh.geometry.align_vectors([0.0, 0.0, 1.0], (b - a) / np.linalg.norm(b - a)))
    t.apply_translation((a + b) / 2)
    t.apply_scale(0.001)
    return t


def coolant_nozzle_mesh(station: str, wheel_id: str):
    """SB1029's coolant nozzle, which the STEP lacks (world frame, metres): a segmented hose along sgrind.json's coolant
    path for the wheel mounted, with a ball joint at each bend and a mount plate on the guard's front."""
    import trimesh
    c = json.loads((STATIONS / f"{station}.json").read_text(encoding="utf-8"))["coolant"]
    path, radius = c["nozzle_mm"][wheel_id], c["radius_mm"]
    parts = [_tube(a, b, radius) for a, b in zip(path[:-1], path[1:])]
    for p in path[:-1]:
        ball = trimesh.creation.icosphere(subdivisions=2, radius=radius * 1.25 * 0.001)
        ball.apply_translation(np.asarray(p, float) * 0.001)
        parts.append(ball)
    m0 = np.asarray(path[0], float)
    plate = trimesh.creation.box(extents=[0.03, 0.008, 0.03])
    plate.apply_translation((m0 + [0.0, 8.7, 0.0]) * 0.001)      # flat on the guard's front plate (y -51.3)
    parts.append(plate)
    return [(trimesh.util.concatenate(parts), "sgrind_locline")]


def coolant_stream_mesh(station: str, wheel_id: str):
    """The coolant's flow from the nozzle's tip to the wheel's lowest point (world frame, metres): drawn, not
    simulated."""
    r = json.loads((STATIONS / f"{station}.json").read_text(encoding="utf-8"))
    tip = np.asarray(r["coolant"]["nozzle_mm"][wheel_id][-1], float)
    at, w = r["joints"]["spindle"]["at_mm"], r["wheels"][wheel_id]
    bottom = np.array([at[0], 0.0, at[2] - w["dia_mm"] / 2])
    return [(_tube(tip, bottom, 2.5), "sgrind_coolant")]


GENERATED = {"sgrind": {"controls": control_box_mesh,               # links with no solid in the STEP, made here
                        "wheel_dwheel-1a1r": lambda s: wheel_mesh(s, "dwheel-1a1r"),
                        **{f"coolant_nozzle_{w}": (lambda s, w=w: coolant_nozzle_mesh(s, w))
                           for w in ("gwheel", "dwheel-1a1r")},
                        **{f"coolant_stream_{w}": (lambda s, w=w: coolant_stream_mesh(s, w))
                           for w in ("gwheel", "dwheel-1a1r")}}}
WHEEL_ASSETS = {"sgrind": ("dwheel-1a1r",)}    # wheels made here that are also assets of their own (consumables)
KEEPER_MM = (38.1, 12.7, 3.175)                 # the grinding keeper (records workholding/keeper): its length proposed


def keeper_mesh():
    """A grinding keeper, a ground bar lying on z = 0, its length along X (the library's convention), in mm."""
    import trimesh
    box = trimesh.creation.box(extents=KEEPER_MM)
    box.apply_translation([0.0, 0.0, KEEPER_MM[2] / 2])
    return box


def write_wheel_assets(station: str) -> None:
    """Each made wheel's own asset GLB, <data root>/library/consumables/<id>/<id>.glb, from the same dimensions, and
    the keepers its chuck blocks parts in with, <data root>/library/workholding/keeper/keeper.glb."""
    for wheel_id in WHEEL_ASSETS.get(station, ()):
        out = data_root() / "library" / "consumables" / wheel_id
        out.mkdir(parents=True, exist_ok=True)
        wheel_mesh(station, wheel_id, on_spindle=False).export(out / f"{wheel_id}.glb")
    if station == "sgrind":
        out = data_root() / "library" / "workholding" / "keeper"
        out.mkdir(parents=True, exist_ok=True)
        keeper_mesh().export(out / "keeper.glb")


# each link's material, by the name moonshot/render/look.py paints it (the CAD's colours: light grey castings, blue
# guards, black handwheels; the chuck's face ground steel between brass separators), and the solids that differ from
# their link's
MATERIALS = {"sgrind": {
    "links": {"base": "sgrind_paint", "saddle": "sgrind_paint", "table": "sgrind_paint", "chuck": "sgrind_chuck_body",
              "chuck_lever": "handle_steel", "wheelhead": "sgrind_blue", "spindle": "ground_steel",
              "wheel_gwheel": "sgrind_abrasive", "table_handwheel": "grip_black", "cross_handwheel": "grip_black",
              "downfeed_handwheel": "grip_black", "downfeed_dial": "sgrind_dial"},
    "solids": {21: "ground_steel", **{i: "sgrind_brass" for i in (*range(9, 21), *range(22, 34))},
               0: "sgrind_blue", 1: "sgrind_blue", 51: "sgrind_red", 52: "sgrind_red", 48: "grip_black",
               49: "grip_black", 50: "grip_black", 5: "sgrind_blotter", 7: "sgrind_blotter", 8: "ground_steel"}}}
BASE_COLOURS = {"sgrind_paint": (0.42, 0.44, 0.5), "sgrind_blue": (0.03, 0.2, 0.55), "sgrind_red": (0.55, 0.08, 0.06),
                "sgrind_chuck_body": (0.12, 0.12, 0.13), "sgrind_brass": (0.6, 0.46, 0.2), "ground_steel": (0.62, 0.63, 0.65),
                "handle_steel": (0.7, 0.71, 0.72), "grip_black": (0.02, 0.02, 0.02), "sgrind_dial": (0.75, 0.75, 0.77),
                "sgrind_abrasive": (0.6, 0.6, 0.57), "sgrind_blotter": (0.75, 0.7, 0.6), "sgrind_diamond": (0.08, 0.08, 0.09),
                "sgrind_box": (0.3, 0.31, 0.33), "sgrind_green": (0.03, 0.35, 0.06), "sgrind_lamp": (0.85, 0.82, 0.7),
                "sgrind_locline": (0.75, 0.3, 0.04), "sgrind_coolant": (0.86, 0.88, 0.86)}


def painted_glb(parts):
    """A link's meshes as one GLB, a mesh per material, each material named for the look to paint (its base colour
    the CAD's, for a viewer that doesn't)."""
    import trimesh
    scene = trimesh.Scene()
    groups: dict[str, list] = {}
    for mesh, mat in parts:
        groups.setdefault(mat or "ground_steel", []).append(mesh)
    for mat, ms in groups.items():
        m = trimesh.util.concatenate(ms)
        rgb = BASE_COLOURS.get(mat, (0.62, 0.63, 0.65))
        m.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
            name=mat, baseColorFactor=[*rgb, 1.0], metallicFactor=0.0, roughnessFactor=0.5))
        scene.add_geometry(m, geom_name=mat)
    return scene


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
    solid_of: dict[str, list] = {}
    if station in SOLID_LINKS:
        owner = {i: link for link, ids in SOLID_LINKS[station].items() for i in ids}
        for i, solid in enumerate(read_solids(step)):
            shapes.setdefault(owner.get(i, "base"), []).append(solid)
            solid_of.setdefault(owner.get(i, "base"), []).append(i)
    else:
        for comp_name, shape in read_components(step):
            link = LINKS[station].get(comp_name) or SUBLINKS.get(station, {}).get(comp_name)
            if link is not None:
                shapes.setdefault(link, []).append(shape)
    paints = MATERIALS.get(station)
    for link, parts in shapes.items():
        for k, shape in enumerate(parts):
            mesh = to_world_mesh(shape, station, link)
            if mesh is not None:
                mat = None if paints is None else paints["solids"].get(solid_of[link][k], paints["links"].get(link))
                meshes.setdefault(link, []).append((mesh, mat))
    for link, make in GENERATED.get(station, {}).items():
        made = make(station)
        meshes[link] = made if isinstance(made, list) else [(made, None)]
    import trimesh
    manifest = {}
    # sub-links (doors, spindle) are cut out of their parents' meshes by being exported separately; their parent
    # component also contains them, so parents are rebuilt without their sub-links' geometry where they overlap
    for link, parts in meshes.items():
        mesh = trimesh.util.concatenate([p for p, _ in parts])
        if link in ("head",) and "spindle" in meshes:
            pass                                           # the spindle stays drawn in the head; it only turns
        if any(mat for _, mat in parts):                   # painted by name: the render's look paints each
            painted_glb(parts).export(out_dir / f"{link}.glb")
        else:
            mesh.export(out_dir / f"{link}.glb")
        lo, hi = mesh.bounds * 1000
        manifest[link] = {"min_mm": [round(v, 1) for v in lo], "max_mm": [round(v, 1) for v in hi],
                          "triangles": int(len(mesh.faces))}
        if station in SOLID_LINKS and link in shapes:
            manifest[link] |= mass_properties(shapes[link], station)
    (STATIONS / f"{station}.links.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    write_wheel_assets(station)
    return manifest


if __name__ == "__main__":
    for k, v in extract(sys.argv[1]).items():
        print(f"{k:12s} {v}")
