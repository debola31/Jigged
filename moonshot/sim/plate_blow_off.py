"""The physics of blowing the chips off a plate's table (moonshot/motion/plate_blow_off.py): the VF-2 cell set up for
the plate (moonshot/world/spoilboard.py, no vise), its doors open, the clamps parked or clamped on the plate as the
step finds them, the holster on the front panel and the gun a free body in it, held as every blow-off holds it
(moonshot/sim/blow_off.py). No air flows.

    python -m moonshot.sim.plate_blow_off nist-ftc-09 op10-clean     # runs takes/nist-ftc-09-op10-clean-blow-off and
                                                                     # writes its take record
"""
from __future__ import annotations

import json
import sys

import numpy as np

from moonshot.motion import blow_off as BO
from moonshot.motion import plate_blow_off as PBO
from moonshot.motion import plates
from moonshot.sim import blow_off as SBO
from moonshot.sim.record import glbs_in_bodies
from moonshot.world import air_gun as AG
from moonshot.world import cell, vf2
from moonshot.world import spoilboard as SB

DOORS = ("door_left", "door_right")


class PlateBlowOff(SBO.BlowOff):
    def __init__(self, folder):
        tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.table = tk["table"]
        self.plate = plates.plate(self.table["part"], self.table["setup"])
        self.clamps = plates.clamps(self.table["part"], self.table["setup"])
        super().__init__(folder)
        self.plate_at: list[np.ndarray] = []

    def scene(self, body_xml: str) -> str:
        xml = SB.with_body(body_xml, self.plate if self.table["plate"] else None, self.clamps, self.table["state"])
        return xml.replace("<worldbody>\n", "<worldbody>\n" + AG.holster_xml(BO.ORIGIN) + AG.gun_xml(BO.ORIGIN), 1)

    def start(self) -> None:
        """The table at the loading spot and the doors open."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001

    def glbs(self):
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def meshes(self, folder):
        return {}

    def over_table(self, tip: np.ndarray) -> np.ndarray:
        """Is the nozzle's tip (mm, per frame) over the spoilboard, within the reach of what it blows?"""
        lo = np.r_[SB.TABLE_MID - SB.SPOILBOARD_MM[:2] / 2, self.plate.bottom]
        hi = np.r_[SB.TABLE_MID + SB.SPOILBOARD_MM[:2] / 2, self.plate.bottom + 250.0]
        return np.all((tip >= lo) & (tip <= hi), axis=1)

    def outcome(self) -> dict:
        out = super().outcome()
        tip, trig = np.array(self.tip), np.array(self.trigger_N)
        out.pop("blowing_over_vise_s")
        out["blowing_over_table_s"] = round(float(((trig > SBO.TRIGGER_N) & self.over_table(tip)).sum() / self.fps), 2)
        if self.table["plate"]:
            b = np.array(self.plate_at)
            out["plate_moved_mm"] = round(float(np.linalg.norm(b - b[0], axis=1).max()), 3)
        return out

    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        if self.table["plate"]:
            self.plate_at.append(self.data.body("blank").xpos * 1000)


def main(argv: list[str]) -> int:
    folder = BO.TAKES / PBO.folder(argv[0], argv[1])
    r = PlateBlowOff(folder)
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(folder.name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
