"""Shortcuts are declared (plan §5.1): every constraint and every applied force the physics run uses is either a
declared shortcut or part of the model's own structure (moonshot/contracts/schemas/declared-shortcuts.json), and
each shortcut is reported with how long it was on. A grip assist's seconds count toward the deformable-pad trigger
(plan §3.1).

Reads, per frame, the equality constraints active and the bodies with a force applied from outside the physics
(checks.json active_constraints and applied_forces), which the vise take's physics run doesn't record yet.
"""
from __future__ import annotations

import json
from fnmatch import fnmatch
from pathlib import Path

from moonshot.validate.registry import Result, check

DECLARED = Path(__file__).resolve().parents[1] / "contracts" / "schemas" / "declared-shortcuts.json"


def declared() -> dict:
    return json.loads(DECLARED.read_text(encoding="utf-8"))


@check("shortcuts_declared",
       good=["good/shortcuts_vise_take_declared.json"],
       bad=["bad/shortcuts_hidden_weld.json", "bad/shortcuts_hidden_push.json"])
def shortcuts_declared(take: dict) -> Result:
    """take: {"fps", "active_constraints": per-frame names of active equality constraints, "applied_forces": per-frame
    names of bodies pushed by a force applied from outside the physics}."""
    fps = float(take["fps"])
    frames = list(zip(take["active_constraints"], take["applied_forces"]))
    if not frames:
        raise ValueError("a take with no frames can't pass a per-frame check")
    d = declared()
    on: dict[str, int] = {}
    undeclared: dict[str, int] = {}
    for k, (constraints, forces) in enumerate(frames):
        for name in constraints:
            if any(fnmatch(name, p) for p in d["mechanisms"]):
                continue
            match = next((p for p in d["shortcuts"] if fnmatch(name, p)), None)
            if match is None:
                undeclared.setdefault(name, k)
            else:
                on[match] = on.get(match, 0) + 1
        for body in forces:
            undeclared.setdefault(f"force on {body}", k)
    seconds = {s: round(n / fps, 2) for s, n in on.items()}
    assist = round(sum(n for s, n in on.items() if d["shortcuts"][s]["grip_assist"]) / fps, 2)
    return Result(passed=not undeclared, worst=float(len(undeclared)),
                  detail={"undeclared_first_frame": undeclared, "shortcut_seconds": seconds, "grip_assist_s": assist})
