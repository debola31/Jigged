"""The physics of closing the doors and starting the cycle (moonshot/motion/door_cycle.py): the VF-2 cell with the
part in the vise; the doors are passive slides with friction, so only the hands' pull shuts them, and Cycle Start
registers from the index's force on the button (vf2.Control.touch).

    python -m moonshot.sim.door_cycle           # runs both takes in the data root and writes their take records
"""
from __future__ import annotations

import json
import sys

import mujoco
import numpy as np

from moonshot.motion import door_cycle as DC
from moonshot.sim.record import glbs_in_bodies
from moonshot.sim.runner import SIDES, TakeRunner
from moonshot.world import cell, vf2
from moonshot.world import vise as V

PROGRAM = [(cell.LOAD_X_MM, y, 0.0, 1000.0) for y in (60.0, 0.0) * 6]   # the first moves, slow to show it runs
DOORS = ("door_left", "door_right")


def clamped_home(load: V.Load) -> np.ndarray:
    return np.array([V.VISE["x"], V.VISE["fixed_face_y"] - load.half[1],
                     V.VISE["seat_z"] + load.parallel_h + load.half[2]])


class _Cell(TakeRunner):
    station = "vf2"
    doors_open_mm = 0.0

    def scene(self, body_xml: str) -> str:
        load = V.REFERENCE
        return cell.with_body(body_xml, clamped_home(load), load.parallels(), "R_hand", load)

    def start(self) -> None:
        """The table at the loading spot, the doors as the step finds them, the jaw closed on the part and locked."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001
        load = V.REFERENCE
        jaw = (load.opening0 - load.size[1] - 0.1) * 0.001
        lead = m.eq_data[m.equality("lead_screw").id, 1]
        crank = jaw / lead
        d.qpos[m.jnt_qposadr[m.joint("jaw_slide").id]] = jaw
        d.qpos[m.jnt_qposadr[m.joint("crank").id]] = crank
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0] = crank
        d.eq_active[lock] = 1

    def before_step(self, t: float) -> None:
        self.ctl.apply()

    def glbs(self):
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def force_on(self, geom: str) -> dict[str, float]:
        """Each hand's normal force on a geom now (N)."""
        m, d = self.model, self.data
        g, f, c6 = m.geom(geom).id, {s: 0.0 for s in SIDES}, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            if g in (c.geom1, c.geom2):
                other = m.body(m.geom_bodyid[c.geom2 if c.geom1 == g else c.geom1]).name
                if other[:2] in ("R_", "L_"):
                    mujoco.mj_contactForce(m, d, i, c6)
                    f[other[0]] += abs(c6[0])
        return f


class DoorClose(_Cell):
    doors_open_mm = DC.OPEN_MM
    closing = True
    grip_geoms = {"door_left": "vf2_door_left_pull", "door_right": "vf2_door_right_pull",
                  "open_left": "vf2_door_left_pull", "open_right": "vf2_door_right_pull"}
    encloses = {"door_left": "vf2_door_left", "door_right": "vf2_door_right",
                "open_left": "vf2_door_left", "open_right": "vf2_door_right"}

    def __init__(self, folder=DC.TAKES / "door-close"):
        super().__init__(folder)
        self.door_mm = {k: [] for k in DOORS}
        self.force = {k: {s: [] for s in SIDES} for k in DOORS}
        self.pulls = {e["side"]: e for e in self.tk["events"] if e["kind"] == "pull_door"}
        rec = vf2.record()
        self.door_kg = {k: rec["links"][k]["mass_kg"] for k in DOORS}
        self.door_friction = {k: rec["joints"][k]["friction_n"] for k in DOORS}
        self.door_dir = {k: np.array(rec["affordances"][f"{k}_handle"]["pull"], float) * (-1 if self.closing else 1)
                         for k in DOORS}

    def hand_force(self, side, t):
        """The door's friction and the force that accelerates it along its planned path (minimum jerk); a door is
        slowed by its friction, so the hand never pulls it back."""
        e = self.pulls.get(side)
        if e is None or not e["t0"] <= t < e["t1"]:
            return None
        T = e["t1"] - e["t0"]
        x = (t - e["t0"]) / T
        acc = DC.OPEN_MM * 0.001 * (60 * x - 180 * x ** 2 + 120 * x ** 3) / T ** 2
        door = e["door"]
        return self.door_dir[door] * max(0.0, self.door_friction[door] + self.door_kg[door] * acc)

    def on_frame(self, k: int) -> None:
        for door in DOORS:
            self.door_mm[door].append(float(self.data.qpos[self.ctl.q[door]] * 1000))
            for s, f in self.force_on(f"vf2_{door}_pull").items():
                self.force[door][s].append(f)

    def outcome(self) -> dict:
        return {"door_open_mm_start": {k: round(v[0], 1) for k, v in self.door_mm.items()},
                "door_open_mm_end": {k: round(v[-1], 1) for k, v in self.door_mm.items()},
                "pulled_by": {k: max(SIDES, key=lambda s: sum(f[s])) for k, f in self.force.items()},
                "hand_force_N_max": {k: round(max(max(f[s]) for s in SIDES), 1) for k, f in self.force.items()}}


class DoorOpen(DoorClose):
    doors_open_mm = 0.0
    closing = False

    def __init__(self, folder=DC.TAKES / "door-open"):
        super().__init__(folder)


class CycleStart(_Cell):
    grip_geoms = {"cycle_start": "vf2_cycle_start_button"}
    RELEASE_N = 0.5                 # a button lets go below this, well under its actuation force,
    DEBOUNCE_S = 0.05               # and only once it has stayed below it this long, as controls debounce a switch

    def __init__(self, folder=DC.TAKES / "cycle-start"):
        super().__init__(folder)
        self.press_N: list[float] = []
        self.held, self.light_since = False, None

    def start(self) -> None:
        super().start()
        self.ctl.program = list(PROGRAM)

    def before_step(self, t: float) -> None:
        f = self.force_on("vf2_cycle_start_button")["R"]
        act = self.ctl.actuation
        if f >= act:
            self.held, self.light_since = True, None
        elif self.held and f <= self.RELEASE_N:
            self.light_since = t if self.light_since is None else self.light_since
            self.held = t - self.light_since < self.DEBOUNCE_S
        elif self.held:
            self.light_since = None
        self.ctl.touch({"cycle_start": max(f, act) if self.held else min(f, act * 0.99)})
        self.press_N.append(f)
        super().before_step(t)

    def outcome(self) -> dict:
        return {"events": list(self.ctl.events), "state": self.ctl.state, "press_N_max": round(max(self.press_N), 1)}


def main(argv: list[str]) -> int:
    for cls, name in ((DoorClose, "door-close"), (CycleStart, "cycle-start"), (DoorOpen, "door-open")):
        r = cls(DC.TAKES / name)
        r.run(log=print)
        r.export()
        out = r.outcome()
        (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
