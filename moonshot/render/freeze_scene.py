"""Freeze a scene at one frame and pack it into a single self-contained .blend: a scene pack a worker can render
without any other file. Runs inside Blender:

    blender -b <scene.blend> --python moonshot/render/freeze_scene.py -- --frame 480 --out <pack.blend>

Point caches (hand.pc2, sleeve.pc2) can't be packed, so every object with a modifier stack is replaced by its
evaluated mesh at that frame, which bakes the skin's pose into plain geometry. Images, HDRIs and fonts are packed.
"""
import sys

import bpy


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def main():
    frame, out = int(arg("--frame", "0")), arg("--out")
    if not out:
        raise SystemExit("--out is required")
    sc = bpy.context.scene
    sc.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    baked = 0
    for ob in list(bpy.data.objects):
        if ob.type != "MESH" or not ob.modifiers:
            continue
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        for i, mat in enumerate(ob.data.materials):
            if i < len(me.materials):
                me.materials[i] = mat
        ob.modifiers.clear()
        ob.data = me
        baked += 1
    sc.frame_start = sc.frame_end = frame
    bpy.ops.file.make_paths_absolute()
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
    print(f"[freeze] frame {frame}: baked {baked} objects, packed, saved {out}")


main()
