"""A take's objects as its take record has them (take.npz, scene.json; moonshot/contracts/take_record.py), for the
checks a vise take's run feeds from its own sim.npz keys (blank, para, opening), which no other run writes.

The record has where each object is, frame by frame, and its colliders by name; checks.json's touching names the
colliders the hands touch. What the record can't tell, the run writes into checks.json (moonshot/sim/bench.py): which
objects ride on which (moves_with: the calipers' slider on their beam), and the right hand's own touches (touching_R).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def is_vise(sim) -> bool:
    """Is this a vise take's run, its objects in sim.npz's own keys?"""
    return "blank" in sim.files


def _scene(take: Path) -> dict:
    return json.loads((take / "scene.json").read_text(encoding="utf-8"))["bodies"]


def positions(take: Path) -> dict[str, np.ndarray]:
    """Each object's position per frame (mm, world)."""
    rec, scene = np.load(take / "take.npz"), _scene(take)
    names = [str(b) for b in rec["bodies"]]
    return {n: rec["pos"][:, names.index(n)] for n, b in scene.items() if b["role"] == "object"}


def touched(take: Path, touching: list[list[str]], carried: list[list[str]] | None = None) -> list[list[str]]:
    """Per frame, the objects whose colliders are touched (and those carried), with what rides on each."""
    owner = {g["name"]: n for n, b in _scene(take).items() if b["role"] == "object" for g in b["geoms"]}
    moves_with = json.loads((take / "checks.json").read_text(encoding="utf-8")).get("moves_with", {})
    out = []
    for k, t in enumerate(touching):
        s = {owner[g] for g in t if g in owner} | set(carried[k] if carried else ())
        out.append(sorted(s | {x for b in s for x in moves_with.get(b, ())}))
    return out


def carried(active_constraints: list[list[str]]) -> list[list[str]]:
    """Per frame, the objects welded to a hand by its carry (moonshot/world/bench_cell.py carry_<object>)."""
    return [[c[len("carry_"):] for c in frame if c.startswith("carry_")] for frame in active_constraints]


def _quat_R(q) -> np.ndarray:
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def thinnest_mm(take: Path, obj: str) -> float:
    """An object's least extent (mm): the narrowest side of its colliders' box in its own frame, what a grip closes
    across."""
    corners = []
    for g in _scene(take)[obj]["geoms"]:
        s = np.asarray(g["size"], float)
        half = {"box": s[:3], "capsule": [s[0], s[0], s[1] + s[0]], "cylinder": [s[0], s[0], s[1]],
                "sphere": [s[0]] * 3}[g["type"]]
        box = np.array([[i, j, k] for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)]) * half
        corners.append(np.asarray(g["pos"], float) + box @ _quat_R(g["quat"]).T)
    c = np.vstack(corners)
    return float((c.max(0) - c.min(0)).min())
