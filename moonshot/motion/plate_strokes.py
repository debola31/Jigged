"""Each nut's strokes learned from a physics run of its take, as the operator's feel (the user's decision, 2026-11-06):
a plate take's wrench strokes are planned with no feedback, and on each nut they run a consistent 7-13 deg a stroke
short of their plan or past it (by where the ring's flats set the box end down, and the arm at its reach), so a count
fixed to the thread's run left a far nut a millimetre off its strap, or seated it early and slipped its thread. So a
take is planned first with strokes enough for SNUG_MARGIN times each nut's run (moonshot/motion/plate_wrench.py
strokes), run in physics, and for each nut the planned turn at which it came snug on its strap (tightening; or ran
back up its gap, loosening) is read from the run: the strokes up to the one it seated on, and that one's share as
the nut ran. The take is planned again with each nut's strokes stopping there (the snug past it), its record noting
the pass the counts came from; and run again, the final. No new physics and no check changes: the operator stops
when the nut is snug.

    python -m moonshot.motion.plate_strokes ll-1005337-op10-set-clamps-left    # writes its strokes.json
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root
from moonshot.motion import plate_wrench as PW
from moonshot.motion import plates

TAKES = data_root() / "takes"
SEATED_MM = 0.02             # a nut tightened is snug on its strap with its flange this close to the strap's top
TAKEN_FRAC = 0.25            # a nut its strokes ran less than this share of its run, the box end never took


def learn(folder: Path, keep: set[str] = frozenset()) -> dict:
    """From a take's physics run (take.json's turn_nut and work_nut events, take.npz's nut bodies): each nut's
    strokes' planned turn (deg) to where it came snug, or ran back up, by direction and clamp name; and the pass. A
    nut in keep (by its body's name) keeps the turn this run planned it: a nut where it goes stays as it was, so the
    others' learned turns are learned as it will be (learned again, the settled first nut's turn changed by a few
    degrees, and the second nut's strokes, re-timed, came out 40-50 deg past it)."""
    tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
    planned = tk.get("strokes", {}).get("turn_deg", {})
    z = np.load(folder / "take.npz", allow_pickle=True)
    fps = float(z["fps"])
    bodies = [str(b) for b in z["bodies"]]
    table = tk["table"]
    clamps = {c.name: c for c in plates.clamps(table["part"], table["setup"])}
    gap = table.get("gap_mm", {})                 # a take's own run of the nuts (the shift's), by direction
    out: dict[str, dict[str, float]] = {}
    for w in (e for e in tk["events"] if e["kind"] == "work_nut"):
        nut, d = w["obj"], w["direction"]
        c = clamps[nut[:-len("_nut")]]
        if nut in keep and c.name in planned.get(d, {}):
            out.setdefault(d, {})[c.name] = planned[d][c.name]
            continue
        zz = z["pos"][:, bodies.index(nut), 2]
        run = gap.get(d, PW.SB.PARK_NUT_GAP_MM)
        z0 = c.nut_z("clamped")
        target = z0 + SEATED_MM if d == "tighten" else z0 + run
        mine = [e for e in tk["events"] if e["kind"] == "turn_nut" and e["obj"] == nut and w["t0"] <= e["t0"] < w["t1"]]
        done, turn = 0.0, None
        for e in mine:
            a = zz[min(len(zz) - 1, int(round(e["t0"] * fps)))]
            b = zz[min(len(zz) - 1, int(round(e["t1"] * fps)))]
            reached = b <= target if d == "tighten" else b >= target
            if reached:
                frac = float(np.clip((a - target) / (a - b), 0.0, 1.0)) if abs(a - b) > 1e-9 else 1.0
                turn = done + abs(e["rad"]) * frac
                break
            done += abs(e["rad"])
        if turn is None:
            made = abs(zz[int(round(mine[-1]["t1"] * fps))] - zz[int(round(mine[0]["t0"] * fps))])
            # the box end never took it: nothing to learn, its strokes as planned (scaled half again, as a nut that
            # ran short, ll-1005337's far left nut was planned 2103 deg, 1000 past snug)
            if made < run * TAKEN_FRAC:
                out.setdefault(d, {})[c.name] = round(math.degrees(done), 2)
                continue
            turn = done * min(run / made, 1.5)    # never got there: the strokes' turn scaled to the run it made
        if d == "tighten":
            turn += PW.SNUG                       # the snug past it
        out.setdefault(d, {})[c.name] = round(math.degrees(turn), 2)
    prev = folder / PW.STROKES_FILE
    k = json.loads(prev.read_text(encoding="utf-8"))["pass"] + 1 if prev.exists() else 1
    return {"pass": tk.get("strokes", {}).get("pass", k), "turn_deg": out}


SNUG_OK_MM, TURN_OK_DEG, RUN_OK_MM = 0.15, 20.0, 0.5   # a pass's nuts where its strokes stopped them well inside the
                                                        # gates' limits (0.2 mm, 25 deg; the lift-off's 0.8 mm)


def settled(folder: Path) -> list[str]:
    """The nuts a take's last physics run (sim-report.json) left short of where they go: a tightened nut not snug on
    its strap, or turned past its run (its thread slipped, the strokes past snug); a loosened one not run back up its
    gap. Each nut by its last work's direction; a nut both loosened and tightened (the shift's) held to the snug alone.
    Its strokes learned again from this run, the take planned and run again, they stop where it goes."""
    tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
    out = json.loads((folder / "sim-report.json").read_text(encoding="utf-8"))
    gap = tk["table"].get("gap_mm", {})
    works: dict[str, list[str]] = {}
    for w in (e for e in tk["events"] if e["kind"] == "work_nut"):
        works.setdefault(w["obj"], []).append(w["direction"])
    off = []
    for nut, dirs in works.items():
        o = out[nut]
        if dirs[-1] == "tighten":
            whole = gap.get("tighten", PW.SB.PARK_NUT_GAP_MM) / PW.SB.LEAD_MM * 360.0
            if abs(o["over_strap_mm"]) > SNUG_OK_MM or (len(dirs) == 1 and abs(-o["turn_deg"] - whole) > TURN_OK_DEG):
                off.append(nut)
        elif abs(o["over_strap_mm"] - gap.get("loosen", PW.SB.PARK_NUT_GAP_MM)) > RUN_OK_MM:
            off.append(nut)
    return off


def main(argv: list[str]) -> int:
    """Writes the take's strokes learned from its last run; with --if-unsettled, only if a nut isn't where it goes
    (exit 0 settled, nothing written; 3 written, to be planned and run again)."""
    folder = TAKES / argv[0]
    keep: set[str] = set()
    if "--if-unsettled" in argv:
        off = settled(folder)
        if not off:
            print(argv[0], "settled")
            return 0
        print(argv[0], "unsettled:", off)
        tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        keep = {e["obj"] for e in tk["events"] if e["kind"] == "work_nut"} - set(off)
    s = learn(folder, keep)
    (folder / PW.STROKES_FILE).write_text(json.dumps(s, indent=1), encoding="utf-8")
    print(argv[0], json.dumps(s))
    return 3 if "--if-unsettled" in argv else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
