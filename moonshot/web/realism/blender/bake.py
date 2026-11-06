"""Bake a prepared asset's ambient occlusion into its UV1 atlas (Cycles), from <work>/asset.blend:

    blender -b --python bake.py -- <job.json>      (job: blend, ao_png, res, samples, distance_m, device)

The asset alone plus the floor it stands on (prepare.py's `_ao_ground`, an occluder never exported): AO per asset,
not shop-wide lightmaps, so a model doesn't need re-baking whenever the layout moves (spike REPORT.md). The page
adds one realtime key light; three.js applies the aoMap to indirect light only. Writes an 8-bit linear PNG and
<work>/bake.json (seconds, device). GPU jobs wait on <data>/web/gpu-hold before they start (pipeline.py).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import bpy

J = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())


def log(*a):
    print("[bake]", *a, flush=True)


def device(kind: str) -> list[str]:
    sc = bpy.context.scene
    if kind == "CPU":
        sc.cycles.device = "CPU"
        return ["CPU"]
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = kind
    prefs.get_devices()
    used = []
    for d in prefs.devices:
        d.use = d.type == kind
        if d.use:
            used.append(d.name)
    if not used and kind == "OPTIX":
        return device("CUDA")
    if not used:
        raise SystemExit(f"no {kind} device")
    sc.cycles.device = "GPU"
    return used


def main():
    bpy.ops.wm.open_mainfile(filepath=J["blend"])
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    used = device(J.get("device", "OPTIX"))
    log("devices", used)
    sc.cycles.samples = J["samples"]
    sc.cycles.use_denoising = False
    sc.world = sc.world or bpy.data.worlds.new("w")
    sc.world.light_settings.distance = J["distance_m"]
    obj = bpy.data.objects[J["asset"]]
    res = J["res"]
    img = bpy.data.images.new("ao", res, res, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    for s in obj.material_slots:
        nt = s.material.node_tree
        n = nt.nodes.get("bake_target") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "bake_target"
        n.image = img
        for x in nt.nodes:
            x.select = False
        n.select = True
        nt.nodes.active = n
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    obj.data.uv_layers.active = obj.data.uv_layers["UV1"]
    sc.render.bake.margin = J.get("margin_px", 16)
    sc.render.bake.margin_type = "EXTEND"
    sc.render.bake.use_clear = True
    t = time.perf_counter()
    bpy.ops.object.bake(type="AO")
    secs = time.perf_counter() - t
    img.filepath_raw = J["ao_png"]
    img.file_format = "PNG"
    img.save()
    Path(J["report"]).write_text(json.dumps({"seconds": round(secs, 1), "device": used, "res": res,
                                             "samples": J["samples"], "distance_m": J["distance_m"]}, indent=1))
    log(f"{J['asset']}: {res} px AO in {secs:.0f} s on {used} at {J['samples']} samples, {J['distance_m']} m")


main()
