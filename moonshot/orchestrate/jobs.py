"""The production job kinds a worker runs (moonshot/orchestrate/worker.py), so the farm's work goes through the queue
and shows on the dashboard rather than being started by hand over SSH.

- `vise_take` (any worker with the data root): plans a vise take, runs its physics and every per-frame check, and
  sends the take's files to the hub. payload: {"take": folder name, "part": plan id, "setup": setup id}; part and
  setup are optional (the reference load).
- `bake_render` (the Mac with trainual's renderer): bakes the skin onto a take's physics run and renders the draft
  with trainual's scripts (`--trainual` on the worker), reporting its frame time. inputs: [the take's sim.npz].
  payload: {"take": folder name, "res": "960x540", "samples": 32}.

- `skin_bake`, `render_frames`, `encode_frames`: the same render split so every machine draws part of one take. A
  Mac bakes the skin once (inputs: [sim.npz]; uploads the bake as a tar); each GPU renders a frame range
  (inputs: [sim.npz, bake tar]; payload adds "frames": [lo, hi]; uploads its PNGs as a tar); the hub joins them
  (inputs: the PNG tars; payload {"take", "fps"}) with Blender's FFmpeg (moonshot/render/encode.py).

A render is only queued for a take whose checks all passed (moonshot/orchestrate/pipeline.py), so nothing renders
before it is checked (docs/moonshot/physics.md).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

TAKE_FILES = ("reference.npz", "take.json", "grips.json", "sim.npz", "checks.json", "sim-report.json", "take.npz",
              "scene.json")


def vise_take(worker, job: dict, inputs: list[Path]) -> dict:
    import json

    from moonshot.motion import setup_take as ST
    from moonshot.motion.loads import vise_load
    from moonshot.planning.validate import load_plan
    from moonshot.sim.vise_take import ViseTake
    from moonshot.validate.take import run as run_checks
    from moonshot.world.vise import REFERENCE

    p = job["payload"]
    out = ST.TAKES / p["take"]
    load = vise_load(load_plan(p["part"]), p["setup"]) if p.get("part") else REFERENCE
    t0 = time.perf_counter()
    worker.report(job["id"], "plan")
    ST.build(verbose=False, load=load, out=out)
    t1 = time.perf_counter()
    worker.report(job["id"], "physics")
    run = ViseTake(out)
    report = run.run(log=lambda *a: None)
    run.export_sim(out / "sim.npz")
    (out / "sim-report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    t2 = time.perf_counter()
    worker.report(job["id"], "checks")
    checks = {k: v if isinstance(v, str) else {"passed": v.passed, "worst": round(v.worst, 3), "detail": v.detail}
              for k, v in run_checks(out).items()}
    t3 = time.perf_counter()
    passed = all(isinstance(c, dict) and c["passed"] for c in checks.values())
    return {"take": p["take"], "passed": passed, "checks": checks,
            "files": {f: worker.upload(out / f) for f in TAKE_FILES},
            "outcomes": {k: report.get(k) for k in ("grab_hold", "place", "slide", "push", "rotate")},
            "plan_s": round(t1 - t0), "physics_s": round(t2 - t1), "checks_s": round(t3 - t2)}


def bake_render(worker, job: dict, inputs: list[Path]) -> dict:
    trainual, blender = worker.options.get("trainual"), worker.options.get("blender")
    if not trainual or not blender:
        raise RuntimeError("this worker has no --trainual or no --blender")
    p = job["payload"]
    rel = Path("renders") / p["take"]
    folder = Path(trainual) / rel
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    shutil.copyfile(inputs[0], folder / "sim.npz")

    def run(cmd, timeout):
        r = subprocess.run(cmd, cwd=trainual, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"{cmd[0]} exited {r.returncode}: {(r.stderr or r.stdout)[-1500:]}")
        return r

    import numpy as np
    total = len(np.load(folder / "sim.npz")["t"])
    t0 = time.perf_counter()
    worker.report(job["id"], "bake")
    run([sys.executable, "-I", "motion/skin_bake.py", str(rel / "sim.npz")], 3600)
    t1 = time.perf_counter()
    worker.report(job["id"], "render", 0, total)
    cmd = [blender, "-b", "--python", "blender/showcase_physics.py", "--", "--dir", str(rel), "--out", str(rel / "draft"),
           "--res", p.get("res", "960x540"), "--samples", str(p.get("samples", 32))]
    log = folder / "blender.log"                             # a file, not a pipe: a full pipe would stall Blender
    with open(log, "w") as out, subprocess.Popen(cmd, cwd=trainual, stdout=out, stderr=subprocess.STDOUT) as proc:
        while proc.poll() is None:                          # report frames drawn while it renders
            time.sleep(10)
            worker.report(job["id"], "render", len(list((folder / "draft").glob("*.png"))), total)
    if proc.returncode != 0:
        raise RuntimeError(f"blender exited {proc.returncode}: {log.read_text(errors='replace')[-1500:]}")
    t2 = time.perf_counter()
    video = folder / "draft.mp4"
    if not video.exists():
        raise RuntimeError("the render wrote no draft.mp4")
    frames = len(list((folder / "draft").glob("*.png")))
    return {"take": p["take"], "files": {"draft.mp4": worker.upload(video)}, "frames": frames,
            "bake_s": round(t1 - t0), "render_s": round(t2 - t1),
            "s_per_frame": round((t2 - t1) / max(frames, 1), 2)}


def _renderer(worker) -> tuple[Path, str]:
    trainual, blender = worker.options.get("trainual"), worker.options.get("blender")
    if not trainual or not blender:
        raise RuntimeError("this worker has no --trainual or no --blender")
    return Path(trainual), blender


def _fresh(folder: Path) -> Path:
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    return folder


def _tar(worker, folder: Path, names: list[str], out: Path) -> str:
    with tarfile.open(out, "w") as t:
        for n in names:
            t.add(folder / n, arcname=n)
    return worker.upload(out)


def skin_bake(worker, job: dict, inputs: list[Path]) -> dict:
    trainual, _ = _renderer(worker)
    p = job["payload"]
    rel = Path("renders") / p["take"]
    folder = _fresh(trainual / rel)
    shutil.copyfile(inputs[0], folder / "sim.npz")
    t0 = time.perf_counter()
    worker.report(job["id"], "bake")
    r = subprocess.run([sys.executable, "-I", "motion/skin_bake.py", str(rel / "sim.npz")], cwd=trainual,
                       capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise RuntimeError(f"skin_bake exited {r.returncode}: {(r.stderr or r.stdout)[-1500:]}")
    names = sorted(f.name for f in folder.iterdir() if f.name != "sim.npz")
    return {"take": p["take"], "bake": _tar(worker, folder, names, folder.with_suffix(".bake.tar")),
            "bake_s": round(time.perf_counter() - t0)}


def render_frames(worker, job: dict, inputs: list[Path]) -> dict:
    trainual, blender = _renderer(worker)
    p = job["payload"]
    lo, hi = p["frames"]
    rel = Path("renders") / f"{p['take']}-{lo:05d}"
    folder = _fresh(trainual / rel)
    shutil.copyfile(inputs[0], folder / "sim.npz")
    with tarfile.open(inputs[1]) as t:
        t.extractall(folder, filter="data")
    frames = folder / "frames"
    cmd = [blender, "-b", "--python", "blender/showcase_physics.py", "--", "--dir", str(rel), "--out", str(frames),
           "--res", p.get("res", "1920x1080"), "--samples", str(p.get("samples", 96)), "--frames", f"{lo}:{hi}",
           "--device", worker.options.get("device", "METAL")]
    t0 = time.perf_counter()
    log = folder / "blender.log"                             # a file, not a pipe: a full pipe would stall Blender
    with open(log, "w") as out, subprocess.Popen(cmd, cwd=trainual, stdout=out, stderr=subprocess.STDOUT) as proc:
        while proc.poll() is None:
            time.sleep(10)
            worker.report(job["id"], "render", len(list(frames.glob("*.png"))), hi - lo)
    pngs = sorted(f.name for f in frames.glob("*.png"))
    if proc.returncode != 0 or len(pngs) != hi - lo:
        raise RuntimeError(f"blender exited {proc.returncode} with {len(pngs)} of {hi - lo} frames: "
                           f"{log.read_text(errors='replace')[-1500:]}")
    render_s = time.perf_counter() - t0
    return {"take": p["take"], "frames": [lo, hi], "png": _tar(worker, frames, pngs, folder.with_suffix(".png.tar")),
            "render_s": round(render_s), "s_per_frame": round(render_s / (hi - lo), 2)}


def encode_frames(worker, job: dict, inputs: list[Path]) -> dict:
    blender = worker.options.get("blender")
    p = job["payload"]
    folder = _fresh(Path(worker.cache).parent / "encode" / p["take"])
    for tar in inputs:
        with tarfile.open(tar) as t:
            t.extractall(folder / "frames", filter="data")
    video = folder / f"{p.get('name', 'final')}.mp4"
    script = Path(__file__).resolve().parents[1] / "render" / "encode.py"
    r = subprocess.run([blender, "-b", "--python", str(script), "--", "--dir", str(folder / "frames"),
                        "--out", str(video), "--fps", str(p.get("fps", 24))], capture_output=True, text=True,
                       timeout=3600)
    if r.returncode != 0 or not video.exists():
        raise RuntimeError(f"encode exited {r.returncode}: {(r.stderr or r.stdout)[-1500:]}")
    return {"take": p["take"], "files": {video.name: worker.upload(video)},
            "frames": len(list((folder / "frames").glob("*.png")))}
