"""The picture of a step the page shows as its caption and a still (the user's decision, 2026-11-06: G1's vise loads and
lift-outs are deferred; its inspects and ct-slbeam's op10 and op40 clean stay caption and still): the step's setup as
the step starts, as a short take record that the render draws one frame of, from the operator's eyes looking at the
part (moonshot/orchestrate/pipeline.py --local-still). The record is takes/<part>-<step id>-still/, with still.json
naming the frame and the camera; the picture takes/<part>-<step id>/still.png, where the web looks for a step's still,
as for the cutting steps'.

- clean, load, seat, check: the VF-2 with its doors open, the operator in the doorway as the setup's Start finds him
  (the first fraction of a second of its door-close take's plan), and the setup's table as the step starts
  (moonshot/sim/setup_scene.py): the clean, the vise open, the parallels in their rack (or the stop on the table) and
  the part waiting on the table as it enters the setup; the load, the parallels (or the stop) set on the vise; the
  seat, the part set down on them, the jaw still open; the check, the part clamped.
- unload: the doors shut and the part clamped as the setup's last cycle leaves it, as its door-open take starts.
- inspect: the part on the inspection bench's mat, every instrument at its rest (the part's deburr take's record, its
  first frames), in its finish where an outside finish comes before the inspection: that finish's take's stock (black
  oxide, zinc), in the part's STEP frame as the bench's part is.

    python -m moonshot.sim.step_still ct-slbeam op10-load op10-seat inspect     # writes each step's record
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root
from moonshot.motion.loads import scene_spec
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan
from moonshot.world import vise as V

TAKES = data_root() / "takes"
SETTLE_S = 0.2                  # the scene's first fraction of a second: everything at rest where the step finds it
FRAMES = 6                      # an inspect's record cut to its first frames, the part at rest on the mat
STATE = {"clean": ("in", "open"), "load": ("in", "set"), "seat": ("in", "placed"), "check": ("in", "clamped"),
         "unload": ("out", "clamped")}
FINISHES = ("black-oxide", "zinc")


def folder(part: str, step_id: str) -> Path:
    return TAKES / f"{part}-{step_id}-still"


def _vise(part: str, step: dict) -> Path:
    from moonshot.sim.door_cycle import DoorClose, DoorOpen
    setup, kind = step["setup"], step["id"].split("-", 1)[1]
    stock, vise = STATE[kind]
    base = TAKES / f"{part}-{setup}-{'door-open' if kind == 'unload' else 'door-close'}"
    out = folder(part, step["id"])
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    shutil.copy(base / "reference.npz", out / "reference.npz")
    tk = json.loads((base / "take.json").read_text(encoding="utf-8")) | scene_spec(part, setup, stock, vise)
    (out / "take.json").write_text(json.dumps(tk, indent=1), encoding="utf-8")
    r = (DoorOpen if kind == "unload" else DoorClose)(out)
    r.run(seconds=SETTLE_S, log=None)
    r.export()
    rec = np.load(out / "take.npz")
    names = [str(b) for b in rec["bodies"]]
    part_at = rec["pos"][-1, names.index("blank")]
    load = r.table.load
    vise_at = np.array([V.VISE["x"], V.VISE["fixed_face_y"] - load.opening0 / 2, V.VISE["jaw_top_z"]])
    look = vise_at if kind == "clean" else (part_at + vise_at) / 2 if kind == "load" else part_at
    _camera(out, "last", rec["eye"][-1], look)
    return out


def _cut(rec_path: Path, out: Path, n: int) -> None:
    """The record's first n frames: every per-frame array cut, the rest as it is."""
    rec = np.load(rec_path)
    total = len(rec["t"])
    keep = {k: (rec[k][:n] if rec[k].ndim and rec[k].shape[0] == total and k not in ("bodies", "arms")
                and not k.endswith("_q_names") else rec[k]) for k in rec.files}
    np.savez(out / "take.npz", **keep)


def _inspect(part: str, step: dict) -> Path:
    base, out = TAKES / f"{part}-deburr", folder(part, step["id"])
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    _cut(base / "take.npz", out, FRAMES)
    scene = json.loads((base / "scene.json").read_text(encoding="utf-8"))
    ids = [s["id"] for s in expand(load_plan(part))]
    before = ids[:ids.index(step["id"])]
    finish = next((f for f in reversed(before) if f in FINISHES), None)
    if finish:                                    # the finished stock, in its look, in place of the bare part
        src = TAKES / f"{part}-{finish}" / "stock" / "0.glb"
        (out / "part_finish").mkdir()
        shutil.copy(src, out / "part_finish" / "0.glb")
        scene["bodies"]["part"]["meshes"] = {"dir": "part_finish", "frames": [0]}
    (out / "scene.json").write_text(json.dumps(scene), encoding="utf-8")
    rec = np.load(out / "take.npz")
    names = [str(b) for b in rec["bodies"]]
    i = names.index("part")
    from scipy.spatial.transform import Rotation
    R = Rotation.from_quat(rec["quat"][0, i][[1, 2, 3, 0]]).as_matrix()
    geoms = scene["bodies"]["part"]["geoms"]
    centre = np.mean([rec["pos"][0, i] + R @ np.asarray(g["pos"], float) for g in geoms], 0)
    _camera(out, "first", rec["eye"][0], centre)
    return out


def _camera(out: Path, at: str, eye, look) -> None:
    (out / "still.json").write_text(json.dumps({
        "at": at, "eye_mm": np.round(eye, 1).tolist(), "look_mm": np.round(look, 1).tolist(),
        "about": "the still's frame (the record's first or last) and camera, world mm: the operator's eyes on the "
                 "part (moonshot/sim/step_still.py; moonshot/orchestrate/pipeline.py --local-still)"}, indent=1),
        encoding="utf-8")


def build(part: str, step_id: str) -> Path:
    step = next(s for s in expand(load_plan(part)) if s["id"] == step_id)
    if step_id == "inspect" or step.get("station") == "inspection":
        return _inspect(part, step)
    return _vise(part, step)


def main(argv: list[str]) -> int:
    part = argv[0]
    for sid in argv[1:]:
        out = build(part, sid)
        print(f"{part} {sid}: {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
