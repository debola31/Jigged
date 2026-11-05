"""The physics of lifting the plate off (moonshot/motion/plate_lift_off.py): the seat's scene (moonshot/sim/
plate_clamps.py) with the clamps clamped and their nuts snug, the wrench lying on the plate, and the plate a free body
the hands then carry out by its ends, each hand holding it by a declared soft constraint (carry_blank_R and
carry_blank_L, as the load's: moonshot/sim/plate_load.py), the arms fed half its weight each, out at its middle, the eye
steering it along its planned path.

    python -m moonshot.sim.plate_lift_off ll-1005337-op20-lift-off-plate     # runs the take in the data root's takes/
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.sim.plate_clamps import PlateClamps
from moonshot.sim.plate_load import TORQUESCALE, WELD_SOLIMP, WELD_SOLREF

TAKES = data_root() / "takes"


class PlateLiftOff(PlateClamps):
    def more_encloses(self) -> dict:
        """The hands' holds on the plate: each taken up by its edge (plate_), and a sheet's fingers pressed flat on it
        to slide it first (press_), each hand's one weld on it (eq_name)."""
        return {f"{g}_{s}": "blank" for g in ("plate", "press") for s in ("R", "L")}

    def eq_name(self, grip: str) -> str:
        """Each hand's weld on the one plate, whichever hold: carry_blank_R and carry_blank_L, as the load's."""
        return f"carry_blank_{grip[-1]}" if grip.startswith(("plate_", "press_")) else super().eq_name(grip)

    def __init__(self, folder):
        super().__init__(folder)
        self.plate_carries = [e for e in self.tk["events"] if e["kind"] == "carry" and e["obj"] == "blank"]
        self.plate_force_at = np.asarray(self.tk["plate_force_at"], float)
        k = np.load(self.folder / "clamp_keys.npz")
        self.keys["blank"] = list(zip(k["blank_t"], k["blank_R"], k["blank_p"]))
        self.plate_track: list[np.ndarray] = []

    def carry_of(self, grip_event: dict) -> dict:
        if grip_event["on"] == "blank":
            return next(e for e in self.plate_carries if e["side"] == grip_event["side"]
                        and grip_event["t0"] <= e["t0"] <= grip_event["t1"])
        return super().carry_of(grip_event)

    def plate_carry(self, side: str, t: float) -> dict | None:
        """The side's hold on the plate at t, if any: a slide (its drag_N) or the carry out."""
        return next((e for e in self.plate_carries if e["side"] == side and e["t0"] <= t < e["t1"]), None)

    def plate_held(self, side: str, t: float) -> bool:
        return self.plate_carry(side, t) is not None

    def touching(self, side: str) -> bool:
        """While the hand holds the plate the eye steers it whatever the hand brushes, as the load's."""
        if self.plate_held(side, self._now):
            return False
        return super().touching(side)

    @property
    def HAND_FORCE_AT(self):                                    # noqa: N802  (the runner's name)
        """The plate's weight's half acts out at its middle while it's carried (as the load's); a strap's or the
        wrench's at the wrist, and a sheet's drag while it's slid."""
        e = next((self.plate_carry(s, self._now) for s in ("R", "L") if self.plate_held(s, self._now)), None)
        return self.plate_force_at if e is not None and "drag_N" not in e else None

    def held_error(self, side: str, t: float):
        if not self.plate_held(side, t):
            return super().held_error(side, t)
        self._now = t
        m, d = self.model, self.data
        _, p = self.planned("blank", t)
        b = m.body("blank").id
        R = d.xmat[b].reshape(3, 3)
        return np.r_[p * 0.001 - d.xpos[b], Rotation.from_matrix(R.T).as_rotvec()]    # it is carried level

    def hand_force(self, side, t):
        """Half the plate's weight while it's carried, taken up over people's loading time; while a sheet is slid,
        each hand's half of its drag on the board, toward the operator."""
        e = self.plate_carry(side, t)
        if e is not None:
            from moonshot.motion import set_parallels as SP
            up = min(1.0, (t - e["t0"]) / SP.LOADING_S)
            if "drag_N" in e:
                return np.array([0.0, -e["drag_N"] * up, 0.0])
            return np.array([0.0, 0.0, self.plate.mass_kg / 2 * 9.81 * up])
        return super().hand_force(side, t)

    def enclose(self, t: float) -> None:
        super().enclose(t)
        m = self.model
        for s in ("R", "L"):                                    # held stiffly in turn, as the load's
            eq = m.equality(f"carry_blank_{s}").id
            m.eq_data[eq, 10] = TORQUESCALE
            m.eq_solref[eq] = WELD_SOLREF
            m.eq_solimp[eq, :3] = WELD_SOLIMP

    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        self.plate_track.append(self.data.body("blank").xpos * 1000)

    def outcome(self) -> dict:
        """The seat's (each clamp against its clamped pose, each nut's run), and each clamp against its parked pose,
        and where the plate ends against its planned path's end."""
        out = super().outcome()
        for c in self.clamps:
            p_end, yaw_end, tilt = self.pose_at[c.name][-1]
            want, R = c.pose("parked")
            out[c.name]["parked_off_mm"] = [round(float(v), 2) for v in p_end - want]
            out[c.name]["parked_tilt_off_deg"] = round(tilt - float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))), 2)
        P = np.array(self.plate_track)
        _, p_end = self.planned("blank", 1e9)
        out["plate_end_off_mm"] = [round(float(v), 2) for v in P[-1] - p_end]
        out["plate_lifted_mm"] = round(float(P[-1][2] - self.plate.centre[2]), 2)
        b = self.model.body("blank").id
        out["plate_tilt_deg"] = round(float(np.degrees(np.arccos(np.clip(self.data.xmat[b].reshape(3, 3)[2, 2], -1,
                                                                            1)))), 2)
        return out


def main(argv: list[str]) -> int:
    r = PlateLiftOff(TAKES / argv[0])
    r.run(log=print)
    r.export()
    out = r.outcome()
    (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(argv[0], json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
