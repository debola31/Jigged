"""The VF-2 cell (plan §3.2): the machine, with the vise bolted to its table, the floor, and the loose objects, set
into a body model's MJCF. The vise rides the table: when X or Y moves, the vise, its crank and its moving jaw move
with it; the blank and the parallels are free bodies and go where contact takes them.

The machine stands so that, with the table at mid-travel in X (where an operator loads, centred in the doorway), the
vise is where trainual's takes put it. At X = 0, the table's left end, the open left door would stand in the
operator's left shoulder. `start` puts the table there and opens the doors; `vf2.Control.apply` before each step
then holds the axes until a program runs.
"""
from __future__ import annotations

import mujoco
import numpy as np

from moonshot.world import vf2
from moonshot.world import vise as V

LOAD_X_MM = 381.0          # mid-travel of the VF-2's 762 mm X
FLOOR = '    <geom name="floor" type="plane" size="3 3 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'


def with_body(body_xml: str, blank_mm, parallels_mm: dict[str, np.ndarray], hand_body: str,
              load: V.Load = V.REFERENCE, stop_mm=None) -> str:
    """The body model's MJCF with the cell added: the steel default, the machine carrying the vise, the floor and the
    loose objects, their equalities, and the machine's actuators after the body's (so the body's keep their ids)."""
    on_table, loose, eq = V.worldbody(load, blank_mm, parallels_mm, hand_body, "vf2_table", stop_mm)
    machine, acts = vf2.worldbody(on_table)
    machine = f'    <body name="vf2" pos="{-LOAD_X_MM * vf2.M:.4f} 0 0">\n{machine}    </body>\n'
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + V.STEEL_DEFAULT + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + machine + loose, 1)
    xml = xml.replace("<equality>\n", "<equality>\n" + eq, 1)
    head, _, tail = xml.rpartition("  </actuator>")
    return head + acts + "  </actuator>" + tail


def start(model: mujoco.MjModel, data: mujoco.MjData) -> vf2.Control:
    """The machine as an operator finds it to load: table at the loading position, doors open, idle."""
    data.qpos[model.jnt_qposadr[model.joint("vf2_x").id]] = LOAD_X_MM * vf2.M
    ctl = vf2.Control(model, data)
    ctl.open_doors()
    mujoco.mj_forward(model, data)
    return ctl
