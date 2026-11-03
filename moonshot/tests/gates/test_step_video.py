"""A step's video is its takes, or spans of them, played one after another (moonshot/planning/takes.py), cut from the
takes' rendered videos and joined frame for frame (moonshot/render/step_video.py).

cuts(part, step, name, takes) gives the step's cuts in order, (video, start s, end s or None for the take's end),
from each take's take.json clips, or None while any of its takes has no <name>.mp4 yet. make(cuts, out, blender)
writes the joined video at 24 fps: a span [start, end] keeps the frames from round(start * 24) to round(end * 24),
both included; a lone whole take is its own video, copied rather than encoded again.

Joining needs Blender, and the test reads frames back with imageio-ffmpeg. Protected (plan §6, rule 1)."""
import json
import os
import shutil
from pathlib import Path

import numpy as np
import pytest

from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan

PART = "nist-ftc-10"
BLENDER = next((p for p in (os.environ.get("MOONSHOT_BLENDER"), r"C:\blender\blender-5.2.3-windows-x64\blender.exe",
                            "/Applications/Blender.app/Contents/MacOS/Blender") if p and Path(p).exists()), None)
CLIPS = [{"verb": "grab", "t0": 0.0, "t1": 2.96}, {"verb": "hold", "t0": 2.36, "t1": 5.26},
         {"verb": "place", "t0": 4.96, "t1": 8.81}, {"verb": "slide", "t0": 8.41, "t1": 11.26}]


def step(sid):
    return next(s for s in expand(load_plan(PART)) if s["id"] == sid)


def take(takes: Path, name: str, clips, video="final.mp4"):
    (takes / name).mkdir(parents=True, exist_ok=True)
    (takes / name / "take.json").write_text(json.dumps({"clips": clips}), encoding="utf-8")
    if video:
        (takes / name / video).write_bytes(b"")


def test_a_step_is_its_spans_of_takes(tmp_path):
    from moonshot.render.step_video import cuts
    take(tmp_path, f"{PART}-op10", CLIPS)
    take(tmp_path, "door-close", [{"verb": "close_doors", "t0": 0.0, "t1": 3.8}])
    take(tmp_path, "cycle-start", [{"verb": "cycle_start", "t0": 0.0, "t1": 3.0}])
    assert cuts(PART, step("op10-load"), "final", tmp_path) == [(tmp_path / f"{PART}-op10" / "final.mp4", 0.0, 11.26)]
    assert cuts(PART, step("op10-start"), "final", tmp_path) == [
        (tmp_path / "door-close" / "final.mp4", 0.0, None), (tmp_path / "cycle-start" / "final.mp4", 0.0, None)]
    assert cuts(PART, step("op10-start"), "draft", tmp_path) is None, "a take with no draft yet"
    (tmp_path / "cycle-start" / "final.mp4").unlink()
    assert cuts(PART, step("op10-start"), "final", tmp_path) is None


def grey_video(path: Path, levels) -> None:
    """A 24 fps video whose frame k is one flat grey, levels[k]."""
    ff = pytest.importorskip("imageio_ffmpeg")
    w = ff.write_frames(str(path), (64, 48), fps=24, codec="libx264", quality=10, macro_block_size=16)
    w.send(None)
    for g in levels:
        w.send(np.full((48, 64, 3), g, np.uint8).tobytes())
    w.close()


def greys(path: Path) -> list[int]:
    ff = pytest.importorskip("imageio_ffmpeg")
    gen = ff.read_frames(str(path))
    meta = next(gen)
    assert round(meta["fps"]) == 24
    return [int(np.frombuffer(f, np.uint8).mean().round()) for f in gen]


def test_the_cuts_are_joined_frame_for_frame(tmp_path):
    if BLENDER is None:
        pytest.skip("no Blender")
    from moonshot.render.step_video import make
    a, b = [10 * k for k in range(24)], [250 - 10 * k for k in range(12)]
    grey_video(tmp_path / "a.mp4", a)
    grey_video(tmp_path / "b.mp4", b)
    out = make([(tmp_path / "a.mp4", 0.5, 0.75), (tmp_path / "b.mp4", 0.0, None)], tmp_path / "step" / "final.mp4",
               BLENDER)
    got, want = greys(out), a[12:19] + b
    assert len(got) == len(want) and np.max(np.abs(np.array(got) - want)) <= 4, (got, want)


def test_a_lone_whole_take_is_its_own_video(tmp_path):
    from moonshot.render.step_video import make
    grey_video(tmp_path / "a.mp4", [10 * k for k in range(24)])
    out = make([(tmp_path / "a.mp4", 0.0, None)], tmp_path / "step" / "final.mp4", BLENDER or "no-blender")
    assert out.read_bytes() == (tmp_path / "a.mp4").read_bytes()
    shutil.copyfile(out, tmp_path / "same.mp4")
    assert make([(tmp_path / "same.mp4", 0.0, None)], tmp_path / "same.mp4", "no-blender") == tmp_path / "same.mp4"
