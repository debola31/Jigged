"""The render's GLBs for station bodies, written into the data root once (binaries aren't in git). Runs inside Blender:

    blender -b --factory-startup --python moonshot/render/dress.py -- [--data <data root>]

- The VF-2's links, which moonshot/library/stations/extract.py writes as positions only: each face takes the material
  of the nearest face of trainual's vf2.glb (the same machine, in the same frame), so the look's VF-2 materials apply,
  and normals, smooth within 30°. Rewritten in place, so run this again after a re-extract.
- The Kurt D688, from trainual's rig: its body, jaw, handle and knob, each in the frame of the MuJoCo body that moves
  it (moonshot/world/vise.py render_glbs), in library/workholding/d688/links/.
GLBs are written in raw Z-up coordinates (metres), as extract.py writes them and the renderer places them.
"""
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from moonshot.config import data_root  # noqa: E402
from moonshot.world import vise as V  # noqa: E402

MM = 0.001
UNDO_Y_UP = Matrix.Rotation(math.radians(-90), 4, "X")
SMOOTH_DEG = 30.0


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def imported(path: Path) -> list:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [o for o in bpy.data.objects if o not in before]


def baked(o, M: Matrix):
    """o's mesh, with M applied to its vertices, as a new unparented object."""
    me = o.data.copy()
    me.transform(M)
    ob = bpy.data.objects.new(o.name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export(objs: list, path: Path) -> None:
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(SMOOTH_DEG))
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, export_yup=False,
                              export_apply=True)
    print(f"[dress] {path}", flush=True)


def vf2(data: Path) -> None:
    """Each link face takes the material of vf2.glb's nearest face."""
    verts, polys, mats = [], [], []
    for o in imported(data / "library" / "machines" / "vf2" / "vf2.glb"):
        if o.type != "MESH":
            continue
        base, M = len(verts), o.matrix_world
        verts += [M @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
        mats += [o.material_slots[p.material_index].material for p in o.data.polygons]
    tree = BVHTree.FromPolygons(verts, polys)
    for path in sorted((data / "library" / "machines" / "vf2" / "links").glob("*.glb")):
        objs = [o for o in imported(path) if o.type == "MESH"]
        link = [baked(o, UNDO_Y_UP @ o.matrix_world) for o in objs]     # raw coordinates
        for o in link:
            me, used, idx, far = o.data, {}, [], []
            for p in me.polygons:
                _, _, i, dist = tree.find_nearest(p.center)
                idx.append(used.setdefault(mats[i], len(used)))
                far.append(dist / MM)
            me.materials.clear()
            for m in used:
                me.materials.append(m)
            me.polygons.foreach_set("material_index", idx)
            print(f"[dress] {path.stem}: {len(idx)} faces, {len(used)} materials, nearest face median "
                  f"{np.median(far):.2f} mm, 95th {np.percentile(far, 95):.2f} mm", flush=True)
        export(link, path)


def d688(data: Path) -> None:
    """trainual's D688 rig, posed as the MuJoCo vise stands with its crank at zero (CRANK0_DEG), each part moved
    into its body's frame. The rig's own frame: x along the screw, toward the handle; its origin on the table."""
    rig = {o.name: o for o in imported(data / "library" / "workholding" / "d688" / "d688_rig.glb")}
    face = rig["jaw_face_fixed"].matrix_world.translation / MM            # the rig's fixed jaw face, its frame (mm)
    hex_tip = rig["d688_handle"].matrix_world.translation / MM
    lever = rig["d688_handle_knob"].matrix_local.translation / MM          # from the handle's pivot
    turn = Matrix.Rotation(math.radians(-90), 4, "Z")                      # the rig's x is the world's -y
    fy, seat = V.VISE["fixed_face_y"], V.VISE["seat_z"]
    vise = Matrix.Translation(Vector((V.VISE["x"], fy, seat)) * MM) @ turn @ Matrix.Translation(-face * MM)
    phi = math.radians(V.CRANK0_DEG)
    handle = vise @ Matrix.Translation(hex_tip * MM) @ Matrix.Rotation(-phi, 4, "X")
    poses = {"d688_body": vise,
             "d688_jaw": vise @ Matrix.Translation((face + Vector((V.OPENING0, 0, 0))) * MM),
             "d688_handle": handle,
             "d688_handle_knob": handle @ Matrix.Translation(lever * MM) @ Matrix.Rotation(phi, 4, "X")}
    for name, M in poses.items():
        rig[name].matrix_world = M
        bpy.context.view_layer.update()
    ax = Vector(V.VISE["screw_axis"].tolist())
    top = V.VISE["jaw_top_z"]
    origins = {"base": Vector((0, 0, 0)),                                  # the table's frame is the take's start
               "jaw": Vector((V.VISE["x"], fy - V.OPENING0 - 20, (top + seat) / 2)),
               "handle": ax,
               "knob": ax + V.VISE["lever"] * Vector((math.sin(phi), 0, math.cos(phi)))}
    parts = {"base": ["d688_body"], "jaw": ["d688_jaw"], "handle": ["d688_handle_arm", "d688_handle_socket"],
             "knob": ["d688_handle_grip"]}
    for link, names in parts.items():
        to_body = Matrix.Translation(-origins[link] * MM)
        export([baked(rig[n], to_body @ rig[n].matrix_world) for n in names],
               data / V.RENDER_DIR / f"{link}.glb")


def main():
    data = Path(arg("--data", str(data_root())))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    vf2(data)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    d688(data)


main()
