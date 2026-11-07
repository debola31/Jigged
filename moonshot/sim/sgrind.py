"""Takes at the surface grinder, run on the full body model (plan §5.4): the takes planned in moonshot/motion/sgrind.py,
their physics on the two-handed bench runner (moonshot/sim/bench.py, by way of the band saw's, moonshot/sim/bandsaw.py)
in the grinder's cell (moonshot/world/grind_cell.py). Each take starts from the grinder as the one before left it
(state.json, in the station's frame).

- The grinder's switchgear and its chuck's magnet (sgrind.Control) run every step. ON, OFF and the coolant switch have
  colliders on the control box but register at their sites: a press when the planned digit's pad comes within
  BUTTON_MM of the button during the plan's press. The handwheels and the chuck's lever are turned by contact, the hand
  pushing round them with the plan's force (`turn` events, as the band saw's handwheel).
- The grind's shortcut (declared `grind_cut`, the user's decision, 2026-11-06): while the wheel's rim is inside the
  part's uncut shape, they don't collide (the cell's exclusion), and each such frame reports "grind_cut" among its
  active constraints (CutFrames), for `shortcuts_declared` to time.

    (its takes run from moonshot/motion/sgrind.py's plans; the runner's command lands with them)
"""
from __future__ import annotations

import json
import math

from pathlib import Path

import mujoco
import numpy as np

from moonshot.sim.bandsaw import BUTTON_MM, TURN_N_MAX, TURN_N_PER_RAD, SawRun
from moonshot.sim.bench import BenchRun
from moonshot.sim.record import glbs_in_bodies
from moonshot.world import grind_cell as GC
from moonshot.world import saw_cell as SC
from moonshot.world import sgrind as SG

NEVER_HELD = ["sg_spindle"]                    # the wheel and its flanges: no hand goes there
DRIVEN = ["sgrind", "sg_base", "sg_saddle", "sg_table", "sg_chuck", "sg_chuck_lever", "sg_table_handwheel",
          "sg_cross_handwheel", "sg_wheelhead", "sg_spindle", "sg_downfeed_handwheel", "sg_downfeed_dial",
          "sg_controls"]
GRIND_CUT = "grind_cut"                        # the declared shortcut's name, as checks.json reports it


class CutFrames:
    """Which frames the wheel is inside the part's uncut shape (grind_cell.grind_cut_active), for the frame's record
    of the declared `grind_cut`: sampled every physics step, so a frame the wheel enters or leaves within counts."""

    def __init__(self, part: str = GC.PREFIX + "part"):
        self.part, self.now, self.frames = part, False, 0

    def step(self, model: mujoco.MjModel, data: mujoco.MjData) -> None:
        self.now = self.now or GC.grind_cut_active(model, data, self.part)

    def frame(self, active_constraints: list[str]) -> list[str]:
        """The frame's active constraints with the shortcut's name added if it was on during the frame."""
        out = list(active_constraints) + ([GRIND_CUT] if self.now else [])
        self.frames += int(self.now)
        self.now = False
        return out


def machine_axes(model: mujoco.MjModel, data: mujoco.MjData, ctl: SG.Control) -> dict[str, float]:
    m, d = model, data
    q = {j: d.qpos[m.jnt_qposadr[m.joint(f"sg_{j}").id]] for j in ("table", "saddle", "wheelhead")}
    return {"sg_table_mm": float(q["table"] * 1000), "sg_saddle_mm": float(q["saddle"] * 1000),
            "sg_wheelhead_mm": float(q["wheelhead"] * 1000), "sg_spindle_rpm": ctl.spindle_rpm(),
            "sg_chuck_field": ctl.field()}


class GrindRun(SawRun):
    """A take at the grinder: BenchRun's, with the grinder's control each step, its buttons at their sites, its
    handwheels and lever turned by the hand's push, and the grind's frames reported."""
    CARRIED_BITS = (2, 1)          # the grinder's colliders are contype 0: a carried body keeps meeting them

    def __init__(self, folder: Path, place: SC.Place, loose: str, assets: str, state: dict | None, carried=(),
                 grip_objects=None, lifted=None, wheel_id: str | None = None):
        self.loose, self.assets, self.wheel_id = loose, assets, wheel_id
        super().__init__(folder, place, loose, state, carried, grip_objects=grip_objects, lifted=lifted)
        self.moves_with = {k: v for k, v in self.moves_with.items() if k not in DRIVEN}
        self.log = {"axes": {k: [] for k in ("sg_table_mm", "sg_saddle_mm", "sg_wheelhead_mm", "sg_spindle_rpm",
                                             "sg_chuck_field")}, "controls": []}
        self.cut = CutFrames()

    def scene(self, loose, carried, skip):
        return GC.with_body(self.body.xml, self.place, loose, self.assets, carried, self.wheel_id)

    def start(self) -> None:
        self.settling = True
        self.data.qvel[self.body_dof] = 0.0
        self.ctl = GC.control(self.model, self.data, self.loose)
        if self.state is not None:
            GC.set_grinder(self.model, self.data, self.ctl, self.state, self.place)
        self.ctl.events.clear()

    def before_step(self, tt: float) -> None:
        for e in self.buttons:
            if not e["t0"] <= tt < e["t1"] or self.pad_mm(e["digit"], e["at"]) >= BUTTON_MM:
                continue
            b = e["button"]
            if b == "coolant_switch" and self.ctl.coolant_on != e.get("on", True):
                self.ctl.turn_coolant(e.get("on", True))
            elif b in ("start", "stop") and not (b == "start" and self.ctl.state == "running") and not (
                    b == "stop" and self.ctl.stop_in):
                self.ctl.press(b)
            else:
                continue
            self.log["controls"].append({"t": round(tt, 3), "button": b, "state": self.ctl.state,
                                         "coolant": self.ctl.coolant_on})
        self.ctl.apply()
        self.cut.step(self.model, self.data)

    def hand_forces(self, tt: float) -> np.ndarray:
        """BenchRun's, and the push that turns a handwheel or the lever: along the knob's way round, harder the
        further the joint is behind its plan, to TURN_N_MAX, as the band saw's handwheel."""
        tau = BenchRun.hand_forces(self, tt)
        m, d = self.model, self.data
        for e in self.turns:
            if not e["t0"] <= tt < e["t1"]:
                continue
            j = m.joint(e["joint"]).id
            axis, anchor = d.xaxis[j], d.xanchor[j]
            hand = m.body(f"{e['side']}_hand").id
            tangent = np.cross(axis, d.geom_xpos[m.geom(e["knob"]).id] - anchor)
            tangent /= np.linalg.norm(tangent) + 1e-12
            x = min(1.0, max(0.0, (tt - e["t0"]) / (e["t1"] - e["t0"])))
            planned = e["q0"] + e["turn_rad"] * x * x * x * (10 - 15 * x + 6 * x * x)
            behind = (planned - d.qpos[m.jnt_qposadr[j]]) * math.copysign(1.0, e["turn_rad"] or 1.0)
            ease = min(1.0, (tt - e["t0"]) / 0.25, (e["t1"] - tt) / 0.15)
            push = min(e.get("max_n", TURN_N_MAX), max(0.0, e["force"] + TURN_N_PER_RAD * behind)) * ease
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, d.xpos[hand], hand)
            tau += jacp[:, self.act_dof].T @ (tangent * push * math.copysign(1.0, e["turn_rad"] or 1.0))
        return tau

    def measure(self, _run, k: int) -> None:
        self.qpos.append(self.data.qpos.copy())
        self.rec["active_constraints"][-1] = self.cut.frame(self.rec["active_constraints"][-1])
        for a, v in machine_axes(self.model, self.data, self.ctl).items():
            self.log["axes"][a].append(round(v, 4))

    def finish(self, report: dict, station_extra: dict | None = None) -> dict:
        m, d = self.model, self.data
        state = GC.grinder_state(m, d, self.ctl, self.place)
        (self.folder / "state.json").write_text(json.dumps(state, indent=1), encoding="utf-8")
        (self.folder / "physics.xml").write_text(self.xml, encoding="utf-8")
        np.savez_compressed(self.folder / "physics.npz", qpos=np.array(self.qpos), fps=self.fps)
        report = report | {"events": list(self.ctl.events), "controls": self.log["controls"],
                           "grind_cut_frames": self.cut.frames, "grinder_end": state["control"]}
        coolant = state["control"]["coolant_on"]
        glbs = glbs_in_bodies(m, "sgrind", GC.render_links(self.ctl.wheel_id, coolant_flowing=coolant))
        self.export("sgrind", NEVER_HELD, list(self.ctl.held), glbs, report,
                    checks={"machine_axes": self.log["axes"], "driven": DRIVEN} | (station_extra or {}))
        return json.loads((self.folder / "report.json").read_text(encoding="utf-8"))
