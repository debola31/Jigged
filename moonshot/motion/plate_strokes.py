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


def learn(folder: Path) -> dict:
    """From a take's physics run (take.json's turn_nut and work_nut events, take.npz's nut bodies): each nut's
    strokes' planned turn (deg) to where it came snug, or ran back up, by direction and clamp name; and the pass."""
    tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
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
        if turn is None:                          # never got there: the strokes' turn scaled to the run it made
            made = abs(zz[int(round(mine[-1]["t1"] * fps))] - zz[int(round(mine[0]["t0"] * fps))])
            need = run
            turn = done * need / max(made, 1e-3)
        if d == "tighten":
            turn += PW.SNUG                       # the snug past it
        out.setdefault(d, {})[c.name] = round(math.degrees(turn), 2)
    prev = folder / PW.STROKES_FILE
    k = json.loads(prev.read_text(encoding="utf-8"))["pass"] + 1 if prev.exists() else 1
    return {"pass": tk.get("strokes", {}).get("pass", k), "turn_deg": out}


def main(argv: list[str]) -> int:
    folder = TAKES / argv[0]
    s = learn(folder)
    (folder / PW.STROKES_FILE).write_text(json.dumps(s, indent=1), encoding="utf-8")
    print(argv[0], json.dumps(s))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
