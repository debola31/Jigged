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

A take split from the one before it at a cut on the same camera (the saw's lift-out from its slide) continues that
take's camera: it starts on its last pose and eases into its own (moonshot/motion/bench.py continue_camera;
BenchPlan.camera_from, take.json "continues"), so the step's join shows no jump; a deliberate cut, from one place to
another (the saw's load to its handwheel), doesn't (moonshot/tests/gates/test_camera_continuity.py).

A machine-only (cycle) step is no take of people's work: the web shows it as its caption and a still, or in
three.js, from the cycle's own simulation in takes/<part>-<step id>.

A lathe's or a surface grinder's setup has its own takes, named per setup as the plates' are (LATHE_TAKES,
GRINDER_TAKES: takes/<part>-<setup>-<take>), its door and Cycle Start the setup's own runs (per_setup), its Z or touch-off
the setting session's (takes/<part>/<step id>), and a lathe's tools one take per tool bolted into its turret station and
touched off (lathe_tool_takes). An operation done by hand on the grinder is one take of its own, takes/<part>-<step id>,
the step's video, as the deburr's is. None of them plays the VF-2 cell's.

    python -m moonshot.planning.takes nist-ftc-10         # prints each step's takes, and which aren't made yet
"""
from __future__ import annotations

import sys

from moonshot.config import data_root
from moonshot.planning.steps import GRINDERS, LATHES, expand
from moonshot.planning.validate import load_plan
from moonshot.world import tooling as TL

Span = tuple[str, str | None, str | None]           # (take, first clip, last clip); None: from the start / to the end


SPLIT_FROM_FORK = 3        # a holder this many forks or more right of the stand's first, whose stance (motion/
                           # tool_load.py door_lumbar) would stand the body past the table's right end, is taken in two
                           # takes (your decision, 2026-11-04): picked off the stand standing in front of it, then, as
                           # the operator steps over across the cut, pushed up into the spindle from the doorway. From
                           # one stance far enough right to reach the holder, the left index missed Tool Release by
                           # 20-23 mm


def split(fork: int, layout: TL.Layout = TL.ONE_ROW) -> bool:
    """Is the holder in this fork (0 the stand's first, the stand filled from the right) taken in two takes? By the
    reach, not the fork's number (your decision, 2026-11-05): where the one stance in the doorway that reaches Tool
    Release can't also take the holder as people do, it is picked standing where the reach to it is the vise setups'
    first fork's, then inserted from the doorway. On the vise setups' stand that is a holder further right than their
    fork SPLIT_FROM_FORK - 1 (standing right of where the left index still reaches Tool Release), as before. On a plate's
    bracket (moonshot/world/tooling.py BRACKET), every holder: from the doorway it stands 245-270 mm in front of the
    body, low at its right, where the arm can't hold the grip level (the plan's hand missed it by 12 deg, the fingers
    in the tool) and, its holders lifted over the back row near the chest, the right arm's posture was unlike people's
    (a median negative log-likelihood of 30.5, against their 28.7)."""
    if layout.bracket:
        return True
    return bool(TL.stand_axis(fork, layout)[0] > TL.stand_axis(SPLIT_FROM_FORK - 1)[0] + 1e-6)


def stand(step: dict) -> TL.Layout:
    """The stand a Load the tools step's holders wait on (moonshot/world/tooling.py): a vise setup's, one row on the
    table right of the vise; a plate setup's, whose spoilboard covers the table, two rows on a bracket in front of it."""
    if "clamps" in step["facts"]:
        return TL.bracket_layout(step["facts"]["tool_ids"])
    return TL.ONE_ROW


def forks(step: dict) -> list[int]:
    """Each of the step's tools' fork on its stand, in the order they go in: the first in the front row's rightmost
    fork, the front row filled leftward with the next and emptied first, then the back row the same way."""
    n, layout = len(step["facts"]["tool_ids"]), stand(step)
    m = layout.per_row or n
    front, back = min(n, m), n - min(n, m)
    return [front - 1 - i for i in range(front)] + [m + back - 1 - j for j in range(back)]


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
    tools, layout = step["facts"]["tool_ids"], stand(step)
    out, k = ["00-change"], 1
    for t, fork in zip(tools, forks(step)):
        names = ["pick", "insert"] if split(fork, layout) else ["seat"]
        for name in names + ["atc"]:
            out.append(f"{k:02d}-{name}-{t}")
            k += 1
    return out


# a lathe setup's own takes, by the step that plays each (takes/<part>-<setup>-<take>): the stock set in the chuck or
# collet, the chuck closed on it; and its unload's after the door and the blow-off, the part lifted out of the opened
# chuck, or after a part-off, picked out of the chip tray and then the bar's end taken out of the collet
LATHE_TAKES = {"load": "load-chuck", "seat": "close-chuck"}
LATHE_UNLOAD = ("unload-chuck",)
LATHE_PARTED = ("pick-part", "unload-chuck")
# a surface grinder setup's own takes: the chuck and the keepers wiped, the part set down and the keepers set tight
# round it, the magnet switched on, and the part and the keepers taken off
GRINDER_TAKES = {"clean": "wipe-chuck", "load": "block-in", "seat": "magnet-on", "unload": "unload-part"}


def setup_take(part: str, setup: str, take: str) -> str:
    """A lathe's or a grinder's setup's own take's folder: takes/<part>-<setup>-<take>."""
    return f"{part}-{setup}-{take}"


def lathe_tool_takes(step: dict) -> list[str]:
    """A lathe's Set up the turret step's takes, by their folders under the step's own: one per new tool, bolted into
    its turret station and touched off for its offsets, in the order the plan first uses them."""
    return [f"{k:02d}-mount-{t}" for k, t in enumerate(step["facts"]["tool_ids"], 1)]


def lathe_parted(part: str, setup: str) -> bool:
    """Does the lathe setup part its part off the bar (an operation of kind part_off)?"""
    s = next(x for x in load_plan(part)["setups"] if x["id"] == setup)
    return any(op["kind"] == "part_off" for op in s["operations"])


def spans(part: str, step: dict) -> list[Span]:
    """The takes, in order, that make one step of a part's plan."""
    sid, setup = step["id"], step.get("setup")
    vise = f"{part}-{setup}"
    kind = sid[len(setup) + 1:] if setup else sid
    facts = step.get("facts", {})
    if step["kind"] == "cycle":
        return [(f"{part}-{sid}", None, None)]              # the cycle's own simulation, one per operation
    if step.get("machine") == "bandsaw":                    # per part's bar: its load (the slide to the stop, then
        # the vise's handwheel, at the saw's other end: moonshot/motion/bandsaw.py) and its unload (the cut piece slid
        # clear, then lifted out, planned from where the slide left it). A round bar has its own start (the shared
        # one has G1's flat bar in the vise), and its cut piece, a disc, is lifted out where it lies
        round_bar = "bar_dia_mm" in load_plan(part)["stock"]
        return {"load": [(vise, None, None), (f"{vise}-clamp", None, None)],
                "start": [(f"{vise}-start" if round_bar else "saw-start", None, None)],
                "unload": ([] if round_bar else [(f"{vise}-slide", None, None)]) + [(f"lift-out-{vise}", None, None)],
                }[kind]
    own = [(f"{part}-{sid}", None, None)]                   # a take of this step alone
    setting = [(f"{part}/{sid}", None, None)]               # the setting session's takes, per setup, in takes/<part>/
    if not setup:
        return own                                           # finishing: the bench's and inspection's takes
    cell = lambda take: per_setup(part, step, take)          # noqa: E731  the setup's run of a cell take
    start = [cell("door-close"), cell("cycle-start")]
    own_setup = lambda take: (setup_take(part, setup, take), None, None)       # noqa: E731
    if step.get("machine") in LATHES:                       # the ST-25: its chuck's own takes and its turret's
        if kind == "tools":
            return [(f"{part}/{sid}/{t}", None, None) for t in lathe_tool_takes(step)]
        if kind == "unload":
            after = LATHE_PARTED if lathe_parted(part, setup) else LATHE_UNLOAD
            return [cell("door-open"), cell("unload-blow-off"), *[own_setup(t) for t in after]]
        if kind in LATHE_TAKES:
            return [own_setup(LATHE_TAKES[kind])]
        return {"clean": [cell("clean-blow-off")], "z": setting, "start": start}[kind]
    if step.get("machine") in GRINDERS:                     # the surface grinder: by hand, no door, no cycle
        if kind in GRINDER_TAKES:
            return [own_setup(GRINDER_TAKES[kind])]
        return setting if kind == "touch" else own        # the touch-off; an operation done by hand, its own take
    tools = [(f"{part}/{sid}/{t}", None, None) for t in tool_takes(step)] if kind == "tools" else []
    if "clamps" in facts:                                 # a plate clamped to the table: its own takes
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
    takes (plate_take: its blow-offs too) aren't the cell's, and aren't listed; nor is another machine's run of a door
    or a blow-off (the ST-25's), which is its station's, not the VF-2 cell's."""
    from moonshot.planning.validate import PLANS
    shared_name = kind.split("-", 1)[1] if kind.endswith("-blow-off") else kind
    plate_own = (*PLATE_TAKES.values(), *PLATE_UNLOAD, *(f"{PLATE_TAKES['seat']}-{e}" for e in SEAT_ENDS))
    out: list[str] = []
    for f in sorted(PLANS.glob("*.json")):
        for s in expand(load_plan(f.stem)):
            if s.get("machine", "vf2") != "vf2":
                continue
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
