"""Cuts of videos joined into one H.264 MP4 with Blender's own FFmpeg, so no machine needs another tool
(moonshot/render/step_video.py). Runs inside Blender:

    blender -b --factory-startup --python moonshot/render/join.py -- --cuts <cuts.json> --out <video.mp4> [--fps 24]

cuts.json is [[video, start s, end s or null], ...]: each keeps its frames from round(start * fps) to round(end * fps),
both included, or to its last. The view transform is Standard, so the frames pass through as they were encoded.
"""
import json
import sys
from pathlib import Path

import bpy


def arg(name, default=None):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def main():
    cuts, out, fps = json.loads(Path(arg("--cuts")).read_text(encoding="utf-8")), arg("--out"), int(arg("--fps", "24"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = fps
    sc.view_settings.view_transform = "Standard"
    sc.render.resolution_x, sc.render.resolution_y = bpy.data.movieclips.load(cuts[0][0]).size
    sc.render.resolution_percentage = 100
    se = sc.sequence_editor_create()
    at = 1
    for i, (video, t0, t1) in enumerate(cuts):
        strip = se.strips.new_movie(f"cut{i}", video, i + 1, at)     # a channel each: they never overlap in time
        n = strip.frame_final_duration
        lo = min(n - 1, round(t0 * fps))
        hi = n - 1 if t1 is None else max(lo, min(n - 1, round(t1 * fps)))
        strip.frame_offset_start, strip.frame_offset_end = lo, n - 1 - hi
        strip.frame_start = at - lo                                  # its first kept frame lands at `at`
        at += hi - lo + 1
    sc.frame_start, sc.frame_end = 1, at - 1
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
