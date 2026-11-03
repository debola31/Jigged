"""Which takes make each instruction step's video (plan §4, §8): a step's video is one or more takes, or spans of a
take, played one after another. The render track joins them into the step's own video at
<data root>/takes/<part>-<step id>/final.mp4 (or draft.mp4), where the web page looks for it.

A take is named by its folder under the data root's takes/. A span is (take, first clip, last clip) by the take's
clip names (take.json "clips"), or the whole take. Many steps share takes: every VF-2 setup closes its doors the same
way, so `door-close` and `cycle-start` serve them all (25-35% reuse, plan §8).

    python -m moonshot.planning.takes nist-ftc-10         # prints each step's takes, and which aren't made yet
"""
from __future__ import annotations

import sys

from moonshot.config import data_root
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan

Span = tuple[str, str | None, str | None]           # (take, first clip, last clip); None: from the start / to the end


def tool_takes(step: dict) -> list[str]:
    """A Load the tools step's takes, in order, by their folders under the step's own (moonshot/motion/tool_load.py):
    the change at the pendant that empties the spindle, then for each tool its seat in the doorway and its ATC FWD at
    the pendant, cut together as the body doesn't walk."""
    out = ["00-change"]
    for i, t in enumerate(step["facts"]["tool_ids"]):
        out += [f"{2 * i + 1:02d}-seat-{t}", f"{2 * i + 2:02d}-atc-{t}"]
    return out


def spans(part: str, step: dict) -> list[Span]:
    """The takes, in order, that make one step of a part's plan."""
    sid, setup = step["id"], step.get("setup")
    vise = f"{part}-{setup}"
    kind = sid[len(setup) + 1:] if setup else sid
    if step["kind"] == "cycle":
        return [(f"{part}-{sid}", None, None)]              # the cycle session's take, one per operation
    if "stop" in step.get("facts", {}).get("parallels", ""):     # on the vise floor against a stop (op50)
        if kind == "clean":
            return [("blow-off", None, None), ("set-stop", None, None)]
        if kind == "check":                                  # squared by indicator: the setting session's take
            return [(f"{part}/{sid}", None, None)]
    return {
        "clean": [("blow-off", None, None), ("set-parallels", None, None)],
        "load": [(vise, "grab", "slide")],
        "seat": [(vise, "rotate", "push")],
        "check": [(vise, "measure", "measure")],
        "xy": [(f"{part}/{sid}", None, None)],               # the setting session's takes, per setup, in takes/<part>/
        "z": [(f"{part}/{sid}", None, None)],
        "tools": [(f"{part}/{sid}/{t}", None, None) for t in tool_takes(step)] if kind == "tools" else [],
        "start": [("door-close", None, None), ("cycle-start", None, None)],
        "unload": [("door-open", None, None), ("blow-off", None, None), ("loosen", None, None), (f"lift-out-{vise}", None, None)],
    }.get(kind, [(f"{part}-{sid}", None, None)])           # finishing: the inspection session's takes


def main(argv: list[str]) -> None:
    part = argv[0]
    takes = data_root() / "takes"
    missing = set()
    for i, s in enumerate(expand(load_plan(part)), 1):
        sp = spans(part, s)
        for take, _, _ in sp:
            if not (takes / take / "take.npz").exists():
                missing.add(take)
        print(f"{i:3d}. {s['id']:<14} " + " + ".join(t if a is None else f"{t}[{a}..{b}]" for t, a, b in sp))
    print(f"\nnot made yet ({len(missing)}): " + ", ".join(sorted(missing)))


if __name__ == "__main__":
    main(sys.argv[1:])
