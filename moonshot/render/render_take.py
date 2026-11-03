"""Render a take record (moonshot/contracts/take_record.py) in Cycles, first person, from its skin bake
(moonshot/render/bake.py): every object body from its GLBs, a changing body from the mesh of its frame, a body with
neither from its geoms; both hands and sleeves from the bake's point caches; the camera at the operator's eyes; the
approved draft's look (moonshot/render/look.py). Ported from trainual's blender/showcase_physics.py. Runs inside
Blender:

    blender -b --factory-startup --python moonshot/render/render_take.py -- --take <folder> --bake <folder>
        [--data <data root>] [--look <cc0 folder>] [--out <folder>] [--frames lo:hi] [--res 1920x1080]
        [--samples 64] [--device METAL] [--inspect <report.json>] [--save <scene.blend>]

Frames are the bake's (24 fps), written as <out>/<k:05d>.png. A GLB's in_body places its raw stored coordinates, in
metres; a changing body's meshes are in mm in its frame. Blender's glTF importer turns every file from Y up to Z up,
so that turn is undone. Everything that moves is
keyframed per frame, with a frame either side of the range, so Cycles' motion blur sees the real motion. --inspect
writes what each frame would draw instead of rendering it (moonshot/tests/gates/test_render_take.py).
"""
import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from moonshot.config import data_root  # noqa: E402
from moonshot.render import look  # noqa: E402

MM = 0.001
UNDO_Y_UP = Matrix.Rotation(math.radians(-90), 4, "X")
HANDLED_MM = 600.0          # what the hands handle: objects smaller than this across, which the skin blanches on


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def log(*parts):
    print("[render]", *parts, flush=True)


def link(ob, parent=None, local=None):
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    if local is not None:
        ob.matrix_basis = local
    return ob


def tag(ob, body: str, kind: str):
    ob["body"], ob["kind"] = body, kind


def pose(p_mm, q_wxyz) -> Matrix:
    return Matrix.Translation(Vector(p_mm) * MM) @ Quaternion(q_wxyz).to_matrix().to_4x4()


# --- what bodies look like ----------------------------------------------------------------------------------------

def import_glb(path: Path, parent, local: Matrix, body: str, kind: str) -> list:
    """A GLB under `parent`, its raw coordinates placed by `local`."""
    if not path.exists():
        raise SystemExit(f"no GLB at {path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    holder = link(bpy.data.objects.new(f"{kind}:{body}:{path.stem}", None), parent, local @ UNDO_Y_UP)
    vf2 = "machines/vf2/" in path.as_posix()
    for o in new:
        if o.parent is None:
            o.parent = holder
        if o.type == "MESH":
            tag(o, body, kind)
            if not o.data.materials:                    # unpainted CAD: bare steel, not Cycles' white
                o.data.materials.append(look.bare_steel())
            for m in o.data.materials:                  # a CAD export's mat_N is the VF-2's only on the VF-2
                if m and m.name.startswith("mat_") and not vf2:
                    m.name = f"{path.stem}_{m.name}"
    return [o for o in new if o.type == "MESH"]


def geom_object(g: dict, body: str, parent):
    """A MuJoCo geom as a mesh, in its body's frame. Meshes and height fields carry no shape here: not drawn."""
    kind, s = g["type"], np.asarray(g["size"], float) * MM
    bm = bmesh.new()
    smooth = kind != "box"
    if kind == "box":
        bmesh.ops.create_cube(bm, size=2.0)
        bmesh.ops.scale(bm, vec=s, verts=bm.verts)
    elif kind in ("sphere", "ellipsoid"):
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
        bmesh.ops.scale(bm, vec=(s[0], s[0], s[0]) if kind == "sphere" else s, verts=bm.verts)
    elif kind == "capsule":                                 # a sphere split at its equator, the halves moved apart
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=25, radius=s[0])
        for v in bm.verts:
            v.co.z += s[1] if v.co.z > 0 else -s[1]
    elif kind == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=s[0], radius2=s[0], depth=2 * s[1])
    elif kind == "plane":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
        bmesh.ops.scale(bm, vec=(s[0] or 10.0, s[1] or 10.0, 1.0), verts=bm.verts)
    else:
        bm.free()
        return None
    for f in bm.faces:
        f.smooth = smooth and (kind != "cylinder" or abs(f.normal.z) < 0.5)
    me = bpy.data.meshes.new(f"geom:{body}:{g['name']}")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(look.geom(g["rgba"]))
    ob = link(bpy.data.objects.new(me.name, me), parent, pose(g["pos"], g["quat"]))
    tag(ob, body, "geom")
    return ob


def mesh_from(name, verts, faces, uv=None, face_uv=None, attrs=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.update()
    if uv is not None:
        layer = me.uv_layers.new(name="UVMap")
        if face_uv is not None:
            data = np.asarray(uv)[np.asarray(face_uv).reshape(-1)]
        else:
            vidx = np.empty(len(me.loops), np.int32)
            me.loops.foreach_get("vertex_index", vidx)
            data = np.asarray(uv)[vidx]
        layer.data.foreach_set("uv", data.astype(np.float32).ravel())
    for k, v in (attrs or {}).items():
        v = np.asarray(v, np.float32)
        a = me.attributes.new(k, "FLOAT_VECTOR" if v.ndim == 2 else "FLOAT", "POINT")
        a.data.foreach_set("vector" if v.ndim == 2 else "value", v.ravel())
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    return link(bpy.data.objects.new(name, me))


def read_pc2(path: Path, k: int) -> np.ndarray:
    with open(path, "rb") as f:
        head = f.read(32)
        v = int(np.frombuffer(head[16:20], "<i4")[0])
        f.seek(32 + k * v * 12)
        return np.frombuffer(f.read(v * 12), "<f4").reshape(v, 3)


def mesh_cache(ob, path: Path):
    m = ob.modifiers.new("cache", "MESH_CACHE")
    m.cache_format = "PC2"
    m.filepath = str(path)
    m.frame_start = 0.0
    m.frame_scale = 1.0
    m.time_mode = "FRAME"
    m.play_mode = "SCENE"
    m.interpolation = "LINEAR"


def contact_nodes(ob, targets):
    """Geometry Nodes: a 'contact' attribute, 1 where the skin touches any of the targets (within 0.4 mm), fading out
    by 2 mm: what the shader blanches."""
    ng = bpy.data.node_groups.new("skin_contact", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = ng.nodes, ng.links
    gin, gout = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    join = N.new("GeometryNodeJoinGeometry")
    for t in targets:
        oi = N.new("GeometryNodeObjectInfo")
        oi.inputs["Object"].default_value = t
        oi.transform_space = "RELATIVE"
        L.new(oi.outputs["Geometry"], join.inputs[0])
    prox = N.new("GeometryNodeProximity")
    L.new(join.outputs[0], prox.inputs[0])
    mr = N.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.0004
    mr.inputs["From Max"].default_value = 0.002
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    L.new(prox.outputs["Distance"], mr.inputs["Value"])
    store = N.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT"
    store.inputs["Name"].default_value = "contact"
    L.new(gin.outputs[0], store.inputs["Geometry"])
    L.new(mr.outputs["Result"], store.inputs["Value"])
    L.new(store.outputs[0], gout.inputs[0])
    ob.modifiers.new("contact", "NODES").node_group = ng


# --- the take -----------------------------------------------------------------------------------------------------

class Take:
    def __init__(self, take: Path, bake: Path, data: Path, cc0: Path):
        self.take, self.bake_dir, self.data, self.cc0 = take, bake, data, cc0
        self.b = np.load(bake / "bake.npz")
        self.scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
        self.n, self.fps = int(self.b["n"]), int(self.b["fps"])
        self.bodies = [str(x) for x in self.b["bodies"]]
        self.arms = [str(s) for s in self.b["arms"]]
        self.empties: dict[str, bpy.types.Object] = {}
        self.versions: dict[str, dict[int, list]] = {}      # changing body -> take frame -> its mesh's objects
        self.objects: list = []
        for name, body in self.scene["bodies"].items():
            if body["role"] == "object":
                self._body(name, body)
        self.skin: list = []
        for s in self.arms:
            self._arm(s)
        targets = [o for o in self.objects if max(o.dimensions) < HANDLED_MM * MM]
        for ob in self.skin:
            if ob["kind"] == "hand" and targets:
                contact_nodes(ob, targets)

    def _body(self, name: str, body: dict):
        e = link(bpy.data.objects.new(f"body:{name}", None))
        e.rotation_mode = "QUATERNION"
        self.empties[name] = e
        if "meshes" in body:
            folder = self.take / body["meshes"]["dir"]
            self.versions[name] = {k: import_glb(folder / f"{k}.glb", e, Matrix.Scale(MM, 4), name, "mesh")
                                   for k in body["meshes"]["frames"]}
            self.objects += [o for objs in self.versions[name].values() for o in objs]
        elif body.get("glbs"):
            for g in body["glbs"]:
                p, q = g["in_body"][:3], g["in_body"][3:]
                self.objects += import_glb(self.data / g["path"], e, pose(p, q), name, "glb")
        else:
            self.objects += [o for o in (geom_object(g, name, e) for g in body.get("geoms", [])
                                         if g["rgba"][3] > 0) if o is not None]

    def _arm(self, s: str):
        b, d = self.b, self.bake_dir
        attrs = {k[5:]: b[k] for k in b.files if k.startswith("attr_")}
        hand = mesh_from(f"hand_{s}", read_pc2(d / f"hand_{s}.pc2", 0), b[f"hand_faces_{s}"], b["hand_uv"],
                         b[f"hand_face_uv_{s}"], attrs)
        mesh_cache(hand, d / f"hand_{s}.pc2")
        sub = hand.modifiers.new("subsurf", "SUBSURF")
        sub.levels, sub.render_levels = 0, 1
        hand.data.materials.append(look.skin(d))
        tag(hand, f"hand_{s}", "hand")
        sleeve = mesh_from(f"sleeve_{s}", read_pc2(d / f"sleeve_{s}.pc2", 0), b[f"sleeve_faces_{s}"], b["sleeve_uv"])
        mesh_cache(sleeve, d / f"sleeve_{s}.pc2")
        sub = sleeve.modifiers.new("subsurf", "SUBSURF")
        sub.levels, sub.render_levels = 1, 1
        shirt = bpy.data.materials.get("shirt_cotton")
        if shirt is None:
            shirt = bpy.data.materials.new("shirt_cotton")
            look.cotton(shirt, (0.05, 0.07, 0.11))
        sleeve.data.materials.append(shirt)
        tag(sleeve, f"sleeve_{s}", "sleeve")
        self.skin += [hand, sleeve]

    def keyframe(self, cam, frames: range):
        """Bodies, the changing bodies' meshes, the camera and its focus, at each of `frames`."""
        b = self.b
        bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
        for name, e in self.empties.items():
            i = self.bodies.index(name)
            pos, quat = b["pos"][:, i], b["quat"][:, i]
            still = np.allclose(pos, pos[0], atol=1e-4) and np.allclose(quat, quat[0], atol=1e-7)
            for k in (frames[:1] if still else frames):
                e.location, e.rotation_quaternion = Vector(pos[k]) * MM, Quaternion(quat[k])
                if not still:
                    e.keyframe_insert("location", frame=k)
                    e.keyframe_insert("rotation_quaternion", frame=k)
        for name, versions in self.versions.items():
            drawn = b[f"mesh_{name}"]
            for key, objs in versions.items():
                for o in objs:
                    for k in frames:
                        if k == frames[0] or (drawn[k] == key) != (drawn[k - 1] == key):
                            o.hide_render = o.hide_viewport = bool(drawn[k] != key)
                            o.keyframe_insert("hide_render", frame=k)
                            o.keyframe_insert("hide_viewport", frame=k)
        cam.rotation_mode = "QUATERNION"
        prev = None
        for k in frames:
            e, lk, u = (Vector(b[x][k]) * MM for x in ("eye", "look", "up"))
            zc = (e - lk).normalized()
            xc = u.normalized().cross(zc).normalized()
            q = Matrix((xc, zc.cross(xc), zc)).transposed().to_quaternion()
            if prev is not None and prev.dot(q) < 0:          # the short way round, so motion blur stays sane
                q.negate()
            prev = q
            cam.location, cam.rotation_quaternion = e, q
            cam.keyframe_insert("location", frame=k)
            cam.keyframe_insert("rotation_quaternion", frame=k)
            cam.data.dof.focus_distance = (Vector(b["focus"][k]) * MM - e).length
            cam.data.dof.keyframe_insert("focus_distance", frame=k)


def gpu(kind: str) -> list[str]:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = kind
    prefs.get_devices()
    used = []
    for d in prefs.devices:
        d.use = d.type == kind                              # the GPU alone: mixing in the CPU is slower here
        if d.use:
            used.append(d.name)
    if not used:
        raise SystemExit(f"no {kind} device found")
    return used


def settings(sc, w: int, h: int, fps: int, n: int, samples: int):
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.use_persistent_data = True                    # the static scene stays built from frame to frame
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 0.5
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 0, n - 1
    sc.view_settings.view_transform = "AgX"
    sc.render.image_settings.file_format = "PNG"


def inspect(take: Take, cam, frames: range) -> dict:
    sc = bpy.context.scene
    out = {"render": {"engine": sc.render.engine, "res": [sc.render.resolution_x, sc.render.resolution_y],
                      "fps": sc.render.fps, "frames": [sc.frame_start, sc.frame_end]}, "frames": {}}
    for k in frames:
        sc.frame_set(k)
        dg = bpy.context.evaluated_depsgraph_get()
        drawn = []
        for ob in sc.objects:
            if ob.type != "MESH" or "body" not in ob or ob.hide_render:
                continue
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            M = np.array(ev.matrix_world)
            w = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
            ev.to_mesh_clear()
            drawn.append({"body": ob["body"], "kind": ob["kind"], "min": (w.min(0) / MM).tolist(),
                          "max": (w.max(0) / MM).tolist()})
        M = cam.matrix_world
        out["frames"][str(k)] = {"camera": {"eye": list(M.translation / MM), "forward": list(-M.col[2].xyz),
                                            "up": list(M.col[1].xyz)}, "drawn": drawn}
    return out


def main():
    t0 = time.perf_counter()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cc0 = Path(arg("--look", str(data_root() / "cc0")))
    take = Take(Path(arg("--take")), Path(arg("--bake")), Path(arg("--data", str(data_root()))), cc0)
    lo, hi = (int(x) for x in arg("--frames", f"0:{take.n}").split(":"))
    w, h = (int(x) for x in arg("--res", "1920x1080").split("x"))
    sc = bpy.context.scene
    cam = link(bpy.data.objects.new("eye", bpy.data.cameras.new("eye")))
    sc.camera = cam
    cam.data.clip_start = 0.02
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(50)
    cam.data.dof.use_dof = True
    cam.data.dof.aperture_fstop = 4.0
    settings(sc, w, h, take.fps, take.n, int(arg("--samples", "64")))
    report = arg("--inspect")
    take.keyframe(cam, range(lo, hi) if report else range(max(0, lo - 1), min(take.n, hi + 1)))
    if report:
        Path(report).write_text(json.dumps(inspect(take, cam, range(lo, hi))), encoding="utf-8")
        log(f"inspected frames {lo}:{hi} -> {report}")
        return
    look.apply_look(cc0)
    look.world(cc0, 0.6)
    look.lights(take.scene["station"], Vector(np.mean(take.b["look"], 0)))
    device = arg("--device", "METAL")
    sc.cycles.device = "CPU" if device == "CPU" else "GPU"
    log("devices", ["CPU"] if device == "CPU" else gpu(device))
    if arg("--save"):
        bpy.ops.wm.save_as_mainfile(filepath=arg("--save"))
    out = Path(arg("--out", str(take.bake_dir / "frames")))
    out.mkdir(parents=True, exist_ok=True)
    log(f"scene built in {time.perf_counter() - t0:.1f} s; frames {lo}:{hi} at {w}x{h}, {sc.cycles.samples} samples")
    for k in range(lo, hi):
        t1 = time.perf_counter()
        sc.frame_set(k)
        sc.render.filepath = str(out / f"{k:05d}.png")
        bpy.ops.render.render(write_still=True)
        log(f"frame {k}: {time.perf_counter() - t1:.2f} s")


if __name__ == "__main__":
    main()
