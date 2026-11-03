"""Nothing moves without a cause (plan §5.1): every loose object's motion is explained by the hand on it, the vise's
jaw closing on it, or gravity; no frame of the run is non-finite; nothing recorded accelerates like a solver
blowing up.

Judged from the run's recorded poses (sim.npz) and what the hand touches (checks.json), never from MuJoCo's contact
forces, which would offer a solver's spurious contact as the cause of the launch it produces (plan §6, rule 2).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check
from moonshot.world import vise as V

LOOSE = ("blank", "para_a", "para_b")
G = 9.81


def measure(take: Path) -> dict:
    """What the check reads, from a vise take's physics run."""
    sim = np.load(take / "sim.npz")
    touching = json.loads((take / "checks.json").read_text(encoding="utf-8"))["touching"]
    finite = np.ones(len(sim["t"]), bool)
    for k in sim.files:
        if sim[k].dtype.kind == "f" and sim[k].ndim and len(sim[k]) == len(finite):
            finite &= np.isfinite(sim[k].reshape(len(finite), -1)).all(1)
    return {"fps": float(sim["fps"]), "touching": touching, "finite": finite.tolist(),
            "opening_mm": sim["opening"].tolist(),
            "bodies_mm": {"blank": sim["blank"].tolist(), "para_a": sim["para"][:, 0].tolist(),
                          "para_b": sim["para"][:, 1].tolist(), "hand": sim["W"].tolist()}}


def _between_the_jaws(p: np.ndarray, opening: np.ndarray) -> np.ndarray:
    """Per frame, is a point inside the vise's jaws (within a parallel's thickness of the space between them)?"""
    pad = V.PARALLEL_T
    return ((np.abs(p[:, 0] - V.VISE["x"]) < V.VISE["half_width"] + pad)
            & (p[:, 1] < V.VISE["fixed_face_y"] + pad) & (p[:, 1] > V.VISE["fixed_face_y"] - opening - pad))


def _since_last(p: np.ndarray, fps: float) -> np.ndarray:
    """Velocity over each frame's own interval, from the frame before: what the hand touches is recorded at the end
    of that interval, so frame k's motion is judged against frame k's contacts."""
    return np.vstack([np.zeros((1, p.shape[1])), np.diff(p, axis=0)]) * fps


def _held(cause: np.ndarray, frames: int) -> np.ndarray:
    """A cause carries on for `frames` frames after it ends: a body comes to rest after it's let go."""
    out = cause.copy()
    for k in np.flatnonzero(cause):
        out[k:k + frames + 1] = True
    return out


@check("nothing_moves_without_a_cause",
       good=["good/nothing_moves_vise_take.json"],
       bad=["bad/nothing_moves_drift.json", "bad/nothing_moves_launch.json", "bad/nothing_moves_nan.json"])
def nothing_moves_without_a_cause(take: dict) -> Result:
    """take: {"fps", "bodies_mm": {"blank", "para_a", "para_b", "hand": per-frame [x, y, z]}, "touching": per-frame
    names the hand touches, "opening_mm": the vise's jaw opening per frame, "finite": per-frame bool}."""
    fps, finite = float(take["fps"]), np.asarray(take["finite"], bool)
    if not len(finite):
        raise ValueError("a take with no frames can't pass a per-frame check")
    still = threshold("physics.still_mm_s").value
    settle = int(round(threshold("physics.settle_s").value * fps))
    spike = threshold("physics.acceleration_spike_m_s2").value
    fall = threshold("physics.free_fall_frac").value
    opening = np.asarray(take["opening_mm"], float)
    jaw = _held(np.abs(_since_last(opening[:, None], fps))[:, 0] > still, settle)
    uncaused, spikes = {}, {}
    for name, p in take["bodies_mm"].items():
        p = np.nan_to_num(np.asarray(p, float))
        v = _since_last(p, fps)                                              # mm/s
        a = _since_last(v, fps) / 1000              # m/s^2: a central difference would halve a jump within a frame
        over = np.flatnonzero(np.linalg.norm(a, axis=1) > spike)
        if over.size:
            spikes[name] = int(over[0])
        if name not in LOOSE:
            continue
        moving = np.linalg.norm(v, axis=1) > still
        touched = _held(np.array([name in t for t in take["touching"]]), settle)
        falling = (np.abs(a[:, 2] + G) < fall * G) & (np.linalg.norm(a[:, :2], axis=1) < fall * G)
        bad = moving & ~touched & ~(jaw & _between_the_jaws(p, opening)) & ~falling
        if bad.any():
            uncaused[name] = int(np.flatnonzero(bad)[0])
    nonfinite = np.flatnonzero(~finite)
    passed = not uncaused and not spikes and not nonfinite.size
    return Result(passed=passed, worst=float(len(uncaused) + len(spikes) + nonfinite.size),
                  detail={"first_uncaused_motion": uncaused, "first_acceleration_spike": spikes,
                          "first_nonfinite": int(nonfinite[0]) if nonfinite.size else None})
