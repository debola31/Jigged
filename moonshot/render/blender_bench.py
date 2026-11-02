"""Render one frame of a scene pack and report how long Cycles took. Runs inside Blender:

    blender -b <pack.blend> --python moonshot/render/blender_bench.py -- --device METAL --samples 96 \
        --res 1920x1080 --out <frame.png> --report <report.json>

--device is METAL on the Macs and CUDA on the hub's GTX 1070. GPU only: the hub's CPU belongs to the agents
(plan §8), and trainual measured the Macs as faster on the GPU alone.
"""
import json
import platform
import sys
import time

import bpy


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def use_gpu(kind):
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = kind
    prefs.get_devices()
    used = []
    for d in prefs.devices:
        d.use = d.type == kind
        if d.use:
            used.append(d.name)
    if not used:
        raise SystemExit(f"no {kind} device found")
    return used


def main():
    kind = arg("--device", "METAL")
    w, h = (int(x) for x in arg("--res", "1920x1080").split("x"))
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    devices = use_gpu(kind)
    sc.cycles.device = "GPU"
    sc.cycles.samples = int(arg("--samples", "96"))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.filepath = arg("--out", "//bench.png")
    t0 = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    seconds = time.perf_counter() - t0
    report = {
        "seconds": round(seconds, 2), "device": kind, "devices": devices, "samples": sc.cycles.samples,
        "resolution": [w, h], "frame": sc.frame_current, "blender": bpy.app.version_string,
        "machine": platform.node(),
    }
    with open(arg("--report", "bench.json"), "w") as f:
        json.dump(report, f)
    print("[bench]", json.dumps(report))


main()
