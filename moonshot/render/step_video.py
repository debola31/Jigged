"""A step's video: its takes, or spans of them (moonshot/planning/takes.py), cut from the takes' rendered videos and
joined in order with Blender's FFmpeg (moonshot/render/join.py), at <data root>/takes/<part>-<step id>/<name>.mp4,
where the web page looks for it (name: final, or draft).

    python -m moonshot.orchestrate.pipeline <part> --assemble [--final]     # every step whose takes have videos

A span keeps the frames from round(start * 24) to round(end * 24), both included, by its clips' times in the take's
take.json. A step that is one whole take is that take's video, copied rather than encoded again.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from moonshot.config import blender as blender_exe
from moonshot.config import data_root
from moonshot.planning.steps import expand
from moonshot.planning.takes import spans
from moonshot.planning.validate import load_plan

FPS = 24
JOIN = Path(__file__).resolve().parent / "join.py"
Cut = tuple[Path, float, "float | None"]                 # (video, start s, end s or None: to its end)


def cuts(part: str, step: dict, name: str = "final", takes: Path | None = None) -> list[Cut] | None:
    """The step's cuts, in order, or None while any of its takes has no <name>.mp4 rendered from its record as it
    is now: one older than the take's take.npz drew an earlier run (every take re-runs on the body fitted to the skin,
    2026-11-04, and yesterday's finals are 1080p where today's are 720p)."""
    takes = Path(takes or data_root() / "takes")
    out = []
    for take, first, last in spans(part, step):
        video = takes / take / f"{name}.mp4"
        record = takes / take / "take.npz"
        if not video.exists() or (record.exists() and video.stat().st_mtime < record.stat().st_mtime):
            return None
        clips = {}
        if first is not None or last is not None:
            clips = {c["verb"]: c for c in json.loads((takes / take / "take.json").read_text(encoding="utf-8"))["clips"]}
        out.append((video, float(clips[first]["t0"]) if first else 0.0, float(clips[last]["t1"]) if last else None))
    return out


def make(cuts: list[Cut], out: Path, blender: str) -> Path:
    """The cuts joined into one video at out."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if len(cuts) == 1 and cuts[0][1] == 0 and cuts[0][2] is None:          # a lone whole take: its own video
        if Path(cuts[0][0]).resolve() != out.resolve():
            shutil.copyfile(cuts[0][0], out)
        return out
    with tempfile.TemporaryDirectory() as tmp:
        spec, video = Path(tmp) / "cuts.json", Path(tmp) / "video.mp4"
        spec.write_text(json.dumps([[str(v), a, b] for v, a, b in cuts]), encoding="utf-8")
        r = subprocess.run([blender, "-b", "--factory-startup", "--python", str(JOIN), "--", "--cuts", str(spec),
                            "--out", str(video), "--fps", str(FPS)], capture_output=True, text=True, timeout=3600)
        if r.returncode != 0 or not video.exists():
            raise RuntimeError(f"the join exited {r.returncode}: {(r.stderr or r.stdout)[-1500:]}")
        shutil.move(video, out)                          # whole, so the page never reads a half-written video
    return out


def assemble(part: str, name: str = "final", blender: str | None = None, takes: Path | None = None) -> dict[str, str]:
    """Every step of the part whose takes all have videos, made again only when a take's video is newer than the
    step's. Returns each step's state: made, unchanged, or waiting (for a take's video)."""
    takes = Path(takes or data_root() / "takes")
    state = {}
    for s in expand(load_plan(part)):
        c = cuts(part, s, name, takes)
        out = takes / f"{part}-{s['id']}" / f"{name}.mp4"
        if c is None:
            state[s["id"]] = "waiting"
        elif out.exists() and all(out.stat().st_mtime >= v.stat().st_mtime for v, _, _ in c):
            state[s["id"]] = "unchanged"
        else:
            make(c, out, blender or blender_exe())
            state[s["id"]] = "made"
    return state
