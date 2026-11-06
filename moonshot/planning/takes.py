"""Which takes make each instruction step's video (plan §4, §8): a step's video is one or more takes, or spans of a
take, played one after another. The render track joins them into the step's own video at
<data root>/takes/<part>-<step id>/final.mp4 (or draft.mp4), where the web page looks for it.

A take is named by its folder under the data root's takes/. A span is (take, first clip, last clip) by the take's
clip names (take.json "clips"), or the whole take. Many steps share takes: every VF-2 setup closes its doors the same
way, so `door-close` and `cycle-start` serve them all (25-35% reuse, plan §8). A take a machine's setups share is
named for its machine (`hurco-door-close`); the VF-2's keep their bare names. The band saw's Start, coolant and feed
are the same for every bar (`saw-start`). Only nist-ftc-10, published so, plays the cell's shared takes for its clean,
start and unload: every other part's setup has its own run of them, its part or plate in the scene
(`<part>-<setup>-door-close`, ...: per_setup).

A machine-only (cycle) step is no take of people's work: the web shows it as its caption and a still, or in
three.js, from the cycle's own simulation in takes/<part>-<step id>.

    python -m moonshot.planning.takes nist-ftc-10         # prints each step's takes, and which aren't made yet
"""
from __future__ import annotations

import sys

from moonshot.config import data_root
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan

Span = tuple[str, str | None, str | None]           # (take, first clip, last clip); None: from the start / to the end


SPLIT_FROM_FORK = 3        # a holder this many forks or more right of the stand's first, whose stance (motion/
                           # tool_load.py door_lumbar) would stand the body past the table's right end, is taken in two
                           # takes (your decision, 2026-11-04): picked off the stand standing in front of it, then, as
                           # the operator steps over across the cut, pushed up into the spindle from the doorway. From
                           # one stance far enough right to reach the holder, the left index missed Tool Release by
                           # 20-23 mm


def split(fork: int) -> bool:
    """Is the holder in this fork (0 the stand's first, the stand filled from the right) taken in two takes?"""
    return fork >= SPLIT_FROM_FORK


# the parts whose clean, start and unload play the cell's shared takes (`shared`), each drawing nist-ftc-10's stock and
# parallels in the vise: nist-ftc-10's 61 steps are published so. Every other part's re-run per setup, with that setup's
# own part or plate in the scene (the user's decision, 2026-11-05; moonshot/motion/loads.py scene_spec): on the
# shared takes G1's parts showed the wrong part, and its plates a vise where their plate clamped to the table stands
SHARED_TAKES = {"nist-ftc-10"}


def shared(step: dict, take: str) -> Span:
    """A take every setup on the step's machine shares."""
    m = step.get("machine", "vf2")
    return (take if m == "vf2" else f"{m}-{take}", None, None)


# a plate setup's own takes (the plates' planners: moonshot/motion/plate_blow_off.py, plate_seat.py, ...), by the step
# that plays each, named per setup as the cell takes are, so that no take's folder is a step's video's folder
# (<part>-<step id>): an unload's joined video written there overwrote its own take's (the coordinator's report,
# 2026-11-05; moonshot/render/step_video.py now refuses it)
PLATE_TAKES = {"clean": "clean-blow-off", "load": "lay-plate", "seat": "set-clamps", "shift": "shift-plate"}
PLATE_UNLOAD = ("unload-blow-off", "lift-off-plate")      # the chips blown off the clamped plate; then the clamps
                                                          # loosened and the plate lifted off, unless it stays
# a plate too long for one stance to reach both ends' far clamps has its clamps set in two takes, one per end, each from
# its own stance in front of that end's clamps, joined across a cut as the operator steps over (the user's rule from
# the tool loads, 2026-11-04: the body doesn't walk, so one take per stance; the coordinator's decision for ll-1005337,
# 2026-11-05: from the doorway's middle, its far right nut's strokes turned the trunk 15 deg past people's range; and
# for nist-ftc-09, 2026-11-06: its right end's far nuts, stroked from pointing out to the right to clear the next nut,
# stood the hand 310-340 mm right of the doorway's middle, the right arm out of people's range)
SPLIT_SEAT = {"ll-1005337", "nist-ftc-09"}
SEAT_ENDS = ("left", "right")


def plate_take(part: str, setup: str, take: str) -> str:
    """A plate setup's own take's folder: takes/<part>-<setup>-<take> (take: PLATE_TAKES's or PLATE_UNLOAD's)."""
    return f"{part}-{setup}-{take}"


def seat_takes(part: str) -> list[str]:
    """A plate's set-clamps take, or its two, one per end (SPLIT_SEAT), in the order they play."""
    seat = PLATE_TAKES["seat"]
    return [f"{seat}-{end}" for end in SEAT_ENDS] if part in SPLIT_SEAT else [seat]


def plate_stays(part: str, setup: str) -> bool:
    """Does the setup's plate stay clamped for the next, which slides it along the table (moonshot/planning/steps.py)?"""
    setups = load_plan(part)["setups"]
    i = [s["id"] for s in setups].index(setup)
    return i + 1 < len(setups) and "shift" in setups[i + 1].get("workholding", {})


def per_setup(part: str, step: dict, take: str) -> Span:
    """The step's setup's own run of a cell take (`take`: door-close, cycle-start, door-open, clean-blow-off,
    unload-blow-off, set-parallels, set-stop, loosen), its part or plate on the table, in takes/<part>-<setup>-<take>;
    nist-ftc-10's the shared take it was published with (`shared`; a blow-off's step kind left off)."""
    if part in SHARED_TAKES:
        return shared(step, take.split("-", 1)[1] if take.endswith("-blow-off") else take)
    return (f"{part}-{step['setup']}-{take}", None, None)


def tool_takes(step: dict) -> list[str]:
    """A Load the tools step's takes, in order, by their folders under the step's own (moonshot/motion/tool_load.py):
    the change at the pendant that empties the spindle, then for each tool its seat in the doorway (or, from a far fork,
    its pick at the stand and its insert in the doorway) and its ATC FWD at the pendant, cut together as the body doesn't
    walk. The first tool waits in the stand's rightmost fork."""
    tools = step["facts"]["tool_ids"]
    out, k = ["00-change"], 1
    for i, t in enumerate(tools):
        names = ["pick", "insert"] if split(len(tools) - 1 - i) else ["seat"]
        for name in names + ["atc"]:
            out.append(f"{k:02d}-{name}-{t}")
            k += 1
    return out


def spans(part: str, step: dict) -> list[Span]:
    """The takes, in order, that make one step of a part's plan."""
    sid, setup = step["id"], step.get("setup")
    vise = f"{part}-{setup}"
    kind = sid[len(setup) + 1:] if setup else sid
    facts = step.get("facts", {})
    if step["kind"] == "cycle":
        return [(f"{part}-{sid}", None, None)]              # the cycle's own simulation, one per operation
    if step.get("machine") == "bandsaw":                    # per part's bar: its load (the slide to the stop, then
        # the vise's handwheel, at the saw's other end: moonshot/motion/bandsaw.py) and its lift-out
        return {"load": [(vise, None, None), (f"{vise}-clamp", None, None)], "start": [("saw-start", None, None)],
                "unload": [(f"lift-out-{vise}", None, None)]}[kind]
    own = [(f"{part}-{sid}", None, None)]                   # a take of this step alone
    setting = [(f"{part}/{sid}", None, None)]               # the setting session's takes, per setup, in takes/<part>/
    if not setup:
        return own                                           # finishing: the bench's and inspection's takes
    cell = lambda take: per_setup(part, step, take)          # noqa: E731  the setup's run of a cell take
    start = [cell("door-close"), cell("cycle-start")]
    tools = [(f"{part}/{sid}/{t}", None, None) for t in tool_takes(step)] if kind == "tools" else []
    if "clamps" in facts:                                   # a plate clamped to the table: its own takes
        plate = lambda take: (plate_take(part, setup, take), None, None)       # noqa: E731
        if kind == "seat":
            return [plate(t) for t in seat_takes(part)]
        if kind in PLATE_TAKES:
            return [plate(PLATE_TAKES[kind])]
        if kind == "unload":
            return [cell("door-open"), *[plate(t) for t in PLATE_UNLOAD[:1 if plate_stays(part, setup) else 2]]]
        return {"check": setting, "xy": setting, "z": setting, "tools": tools, "start": start}[kind]
    if "stop" in facts.get("parallels", ""):                # on the vise floor against a stop (op50)
        if kind == "clean":
            return [cell("clean-blow-off"), cell("set-stop")]
        if kind == "check":                                  # squared by indicator: the setting session's take
            return setting
    return {
        "clean": [cell("clean-blow-off"), cell("set-parallels")],
        "load": [(vise, "grab", "slide")],
        "seat": [(vise, "rotate", "push")],
        "check": [(vise, "measure", "measure")],
        "xy": setting,
        "z": setting,
        "tools": tools,
        "start": start,
        "unload": [cell("door-open"), cell("unload-blow-off"), cell("loosen"), (f"lift-out-{vise}", None, None)],
    }.get(kind, own)


def played(kind: str) -> list[str]:
    """Every take of a cell take's kind (door-close, cycle-start, door-open, clean-blow-off, unload-blow-off,
    set-parallels, set-stop, loosen) the plans' steps play, in plan order: the shared take nist-ftc-10 plays, and each
    other part's setups' own runs (per_setup). A blow-off's shared take is both step kinds' (`blow-off`). A plate's own
    takes (plate_take: its blow-offs too) aren't the cell's, and aren't listed."""
    from moonshot.planning.validate import PLANS
    shared_name = kind.split("-", 1)[1] if kind.endswith("-blow-off") else kind
    plate_own = (*PLATE_TAKES.values(), *PLATE_UNLOAD, *(f"{PLATE_TAKES['seat']}-{e}" for e in SEAT_ENDS))
    out: list[str] = []
    for f in sorted(PLANS.glob("*.json")):
        for s in expand(load_plan(f.stem)):
            for t, _, _ in spans(f.stem, s):
                if "clamps" in s.get("facts", {}) and any(t.endswith(f"-{p}") for p in plate_own):
                    continue
                if (t == shared_name or t.endswith(f"-{kind}")) and t not in out:
                    out.append(t)
    return out


def main(argv: list[str]) -> None:
    part = argv[0]
    takes = data_root() / "takes"
    missing, machine_only = set(), set()
    for i, s in enumerate(expand(load_plan(part)), 1):
        sp = spans(part, s)
        for take, _, _ in sp:
            if not (takes / take / "take.npz").exists() and not (takes / take / "still.png").exists():
                (machine_only if s["kind"] == "cycle" else missing).add(take)
        tag = "  [machine-only]" if s["kind"] == "cycle" else ""
        print(f"{i:3d}. {s['id']:<14} " + " + ".join(t if a is None else f"{t}[{a}..{b}]" for t, a, b in sp) + tag)
    print(f"\nnot made yet ({len(missing)}): " + ", ".join(sorted(missing)))
    print(f"machine-only, no take of people's work: their stills or three.js not made yet ({len(machine_only)}): "
          + ", ".join(sorted(machine_only)))


if __name__ == "__main__":
    main(sys.argv[1:])
