"""Review pictures of a prepared asset (Workbench: cheap, no Cycles), for checking a mapping by eye:

    materials  each library material in its own palette colour, with cavity shading; the legend says which is which
    natural    each material in its own colour (roughly what it is: white paint, dark casting, grey steel)
    parts      a random colour per connected solid, to write rules by part
    links      a colour per link (per source mesh)
    cads       a colour per CAD material name

    blender -b --factory-startup --python look.py -- <job.json>     (job: blend, out_dir, modes, views, palette)

Writes <out_dir>/<mode>_<view>.png and <out_dir>/legend.json; moonshot.web.realism.review composes the sheets.
"""
from __future__ import annotations

import colorsys
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

J = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
OUT = Path(J["out_dir"])
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=J["blend"])
sc = bpy.context.scene
for o in list(bpy.data.objects):
    if o.get("occluder_only"):
        bpy.data.objects.remove(o)
obj = bpy.data.objects[J["asset"]]
me = obj.data
sc.render.engine = "BLENDER_WORKBENCH"
sh = sc.display.shading
sh.light = "STUDIO"
sh.show_cavity = True
sh.cavity_type = "BOTH"
sh.show_object_outline = False
sc.render.resolution_x, sc.render.resolution_y = J.get("res", (960, 720))
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = False
sc.world = sc.world or bpy.data.worlds.new("w")

co = np.empty(len(me.vertices) * 3)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
lo, hi = Vector(co.min(0)), Vector(co.max(0))
ctr, radius = (lo + hi) / 2, (hi - lo).length / 2
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.lens = 50
cam.data.clip_start = radius / 200
cam.data.clip_end = radius * 50
fov = cam.data.angle_y if sc.render.resolution_y < sc.render.resolution_x else cam.data.angle_x
VIEWS = {"front": (0.55, -1.0, 0.45), "back": (-0.55, 1.0, 0.45), "left": (-1.0, -0.35, 0.4),
         "right": (1.0, -0.35, 0.4), "top": (0.15, -0.35, 1.0), "low": (-0.4, -1.0, 0.08)}
VIEWS.update({k: tuple(v) for k, v in J.get("extra_views", {}).items()})


def look(name):
    v = VIEWS[name]
    if isinstance(v[0], (list, tuple)):                   # an explicit (eye, target) pair in the asset frame
        eye, target = Vector(v[0]), Vector(v[1])
    else:
        d = Vector(v).normalized()
        target = ctr
        eye = ctr + d * (radius / math.tan(fov / 2) * J.get("zoom", 0.78))
    cam.location = eye
    cam.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()


def palette(n):
    """n colours far apart: golden-ratio hues at two lightnesses."""
    out = []
    for i in range(n):
        h = (i * 0.618034) % 1.0
        r, g, b = colorsys.hls_to_rgb(h, 0.45 if i % 2 else 0.62, 0.75)
        out.append((r ** 2.2, g ** 2.2, b ** 2.2, 1.0))
    return out


def face_colours(values: np.ndarray, colours: list):
    """A face-corner colour attribute from per-face integer values."""
    tot = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_total", tot)
    per_loop = np.repeat(values, tot)
    a = me.color_attributes.get("review") or me.color_attributes.new("review", "FLOAT_COLOR", "CORNER")
    a.data.foreach_set("color", np.array(colours, np.float32)[per_loop].ravel())
    me.color_attributes.active_color = a


legend = {}
mats = [s.material for s in obj.material_slots]


def isolate(attr: str, names: list[str], views: list[str]):
    """One small picture per value of a face attribute (CAD material, link): it in magenta, the rest grey."""
    vals = np.empty(len(me.polygons), np.int32)
    me.attributes[attr].data.foreach_get("value", vals)
    sc.render.resolution_x, sc.render.resolution_y = 480, 360
    sh.color_type = "VERTEX"
    present = sorted(set(vals.tolist()))
    for v in present:
        face_colours((vals == v).astype(np.int32), [(0.5, 0.5, 0.5, 1.0), (1.0, 0.0, 0.8, 1.0)])
        for view in views:
            look(view)
            sc.render.filepath = str(OUT / f"iso_{names[v]}_{view}.png")
            bpy.ops.render.render(write_still=True)
    legend["iso"] = [names[v] for v in present]


for mode in J["modes"]:
    if mode == "iso":
        isolate("cad_idx", J["names"]["cads"], J.get("iso_views", ["front", "back"]))
        continue
    if mode in ("materials", "natural"):
        sh.color_type = "MATERIAL"
        cols = palette(len(mats)) if mode == "materials" else [tuple(J["natural"].get(m.name, (0.5, 0.5, 0.5))[:3]) + (1,)
                                                                 for m in mats]
        for m, c in zip(mats, cols):
            m.diffuse_color = c
        legend[mode] = {m.name: list(c[:3]) for m, c in zip(mats, cols)}
    else:
        attr = {"parts": "part_idx", "links": "link_idx", "cads": "cad_idx"}[mode]
        vals = np.empty(len(me.polygons), np.int32)
        me.attributes[attr].data.foreach_get("value", vals)
        n = int(vals.max()) + 1
        cols = palette(n)
        if mode == "parts":
            rng = np.random.default_rng(1)
            cols = [cols[i] for i in rng.permutation(n)]
        face_colours(vals, cols)
        sh.color_type = "VERTEX"
        names = J.get("names", {}).get(mode)
        legend[mode] = {(names[i] if names else str(i)): list(cols[i][:3]) for i in range(n)} if n <= 60 else {}
    for view in J["views"]:
        look(view)
        sc.render.filepath = str(OUT / f"{mode}_{view}.png")
        bpy.ops.render.render(write_still=True)
(OUT / "legend.json").write_text(json.dumps(legend, indent=1))
print("[look] wrote", OUT, flush=True)
