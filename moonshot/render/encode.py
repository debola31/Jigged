"""PNG frames to an H.264 MP4 with Blender's own FFmpeg, so no machine needs another tool. Runs inside Blender:

    blender -b --python moonshot/render/encode.py -- --dir <frames> --out <video.mp4> --fps 24

The frames are <dir>/<k>.png, numbered from any start, in order.
"""
import sys
from pathlib import Path

import bpy


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def main():
    folder, out, fps = Path(arg("--dir")), arg("--out"), int(arg("--fps", "24"))
    files = sorted(folder.glob("*.png"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    w, h = bpy.data.images.load(str(files[0])).size
    sc.render.fps = fps
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.sequence_editor_create()
    strip = sc.sequence_editor.strips.new_image("frames", str(files[0]), 1, 1)
    for f in files[1:]:
        strip.elements.append(f.name)
    sc.frame_start, sc.frame_end = 1, len(files)
    im = sc.render.image_settings
    if "media_type" in type(im).bl_rna.properties:
        im.media_type = "VIDEO"
    im.file_format = "FFMPEG"
    ff = sc.render.ffmpeg
    ff.format, ff.codec, ff.constant_rate_factor, ff.audio_codec = "MPEG4", "H264", "HIGH", "NONE"
    sc.render.filepath = out
    sc.render.use_file_extension = False
    bpy.ops.render.render(animation=True)


main()
