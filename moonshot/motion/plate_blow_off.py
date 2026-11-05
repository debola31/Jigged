"""Blow the chips off a plate's table with the air gun: a plate setup's "Clean the table" step ("Blow the chips off
the spoilboard..."), before the plate goes on, its clamps parked; and a setup's unload whose plate stays clamped for
the next ("Open the door and blow the chips off; the plate stays clamped", ll-1005337 op10). Planned as every VF-2
setup's blow-off (moonshot/motion/blow_off.py, the same stance, holster, grip and route in through the doorway), the
nozzle swept along the middle of the spoilboard, or of the plate on it, instead of along the vise's jaws.

take.json gets, beside the events, "table": what the physics run builds (moonshot/sim/plate_blow_off.py): the part,
the setup whose table it is, the clamps' state and whether the plate is on it.

    python -m moonshot.motion.plate_blow_off nist-ftc-09 op10-clean     # plans <data root>/takes/
                                                                        # nist-ftc-09-op10-clean-blow-off
"""
from __future__ import annotations

import json
import shutil
import sys

import numpy as np

from moonshot.motion import blow_off as BO
from moonshot.motion import plates
from moonshot.planning.takes import plate_take
from moonshot.world import spoilboard as SB

OVER_MM = 110.0              # the nozzle's tip this high over what it blows, as over the vise's jaws
NEAR_MM = 40.0               # ... and this much nearer the operator than the spoilboard's middle
RIGHT_MM = 20.0              # ... and right of it, toward the gun's hand
SWEEP_MM = 130.0             # either side: the middle 260 mm of the table, where the cut's chips lie
SWEEP_S = 1.0                # a pass


def table(part: str, step_id: str) -> dict:
    """The table a blow-off step blows: the setup, the clamps' state and whether the plate is on it."""
    setup, kind = step_id.split("-", 1)
    if kind == "clean":
        return {"part": part, "setup": setup, "state": "parked", "plate": False}
    if kind == "unload":
        return {"part": part, "setup": setup, "state": "clamped", "plate": True}
    raise ValueError(f"{step_id}: not a plate blow-off step")


def folder(part: str, step_id: str) -> str:
    """The take's folder under the data root's takes/: the setup's clean-blow-off or unload-blow-off
    (moonshot/planning/takes.py plate_take), apart from the step's own video's folder (<part>-<step id>)."""
    setup, kind = step_id.split("-", 1)
    return plate_take(part, setup, f"{kind}-blow-off")


class PlateBlowOff(BO.BlowOff):
    SWEEP, SWEEP_S = SWEEP_MM, SWEEP_S

    def __init__(self, part: str, step_id: str, verbose=True):
        self.table = table(part, step_id)
        p = plates.plate(part, self.table["setup"])
        surface = p.top if self.table["plate"] else p.bottom          # the plate, or the spoilboard it will lie on
        self.TIP_OVER = np.array([SB.TABLE_MID[0] + RIGHT_MM, SB.TABLE_MID[1] - NEAR_MM, surface + OVER_MM])
        out = BO.TAKES / folder(part, step_id)
        out.mkdir(parents=True, exist_ok=True)
        shared = BO.TAKES / "blow-off" / "grips.json"     # the same grip on the same gun from the same stance: its
        if not (out / "grips.json").exists() and shared.exists():   # cache key holds, so it isn't solved again
            shutil.copy(shared, out / "grips.json")
        super().__init__(out, verbose)

    def plan(self):
        super().plan()
        self.clips = [dict(c, verb="blow_off_table", caption="Blow the chips off the table") for c in self.clips]

    def save(self):
        super().save()
        f = self.out / "take.json"
        tk = json.loads(f.read_text(encoding="utf-8"))
        f.write_text(json.dumps(tk | {"table": self.table}, indent=1), encoding="utf-8")


def build(part: str, step_id: str, verbose=True) -> PlateBlowOff:
    take = PlateBlowOff(part, step_id, verbose=verbose)
    take.plan()
    take.solve()
    take.save()
    path = take.gun_path()
    np.savez(take.out / "gun_keys.npz", t=[k[0] for k in path], R=[k[1] for k in path], p=[k[2] for k in path])
    if verbose:
        print(f"PlateBlowOff {part} {step_id}: {take.T:.1f} s, {take.n} frames -> {take.out}")
    return take


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], "--quiet" not in sys.argv)
