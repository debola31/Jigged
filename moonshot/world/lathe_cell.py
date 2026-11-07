"""The ST-25 cell (plan §3.2): the lathe (moonshot/world/st25.py) at the world's origin in its own frame, the floor,
the shop air gun in its holster, and the loose stock, set into a body model's MJCF as the VF-2's cell is
(moonshot/world/cell.py).

The body model faces +Y and doesn't walk, so a take stands it where its work is: at the chuck (LOAD_PELVIS_MM),
in front of the door's opening a little right of the chuck, to load, clamp and unload; or at the pendant
(PENDANT_PELVIS_MM) for the keys, the jog handle and Cycle Start. Both are proposed: no source gives where a lathe
operator stands; each is the nearest the body's front comes to the machine's sill and pendant without touching, the
chuck's jaws and the pendant's buttons then inside the arm's reach (moonshot/tests/gates/test_lathe_cell_conformance.py).

The stock is a free round body: a bar or blank, its axis along X, held only by contact (stock_xml). in_jaws_mm and
in_collet_mm give where a plan's stock sits in the chuck: in the BR10's bored soft jaws its end on their step, in
the collet so far out of its nose. A body the hand carries is held by the declared shortcut carry_<body>, a stiff
weld to the hand, as at the other cells.

The air gun is the VF-2's (moonshot/world/air_gun.py), its holster on the enclosure's front right of the door's
opening (HOLSTER_ORIGIN_MM, proposed): the panel's face is at y = -330 there; the holster's top stands 70 mm proud
of it at hip height, the gun's handle out to the right toward the operator, as on the VF-2.
"""
from __future__ import annotations

import math

import mujoco
import numpy as np

from moonshot.world import air_gun as AG
from moonshot.world import st25

M = 0.001
FLOOR = '    <geom name="floor" type="plane" size="4 4 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'
LOAD_PELVIS_MM = (230.0, -540.0, 955.0)        # at the chuck [proposed]
PENDANT_PELVIS_MM = (1000.0, -800.0, 955.0)    # at the pendant [proposed]
HOLSTER_TOP_MM = np.array([820.0, -400.0, 870.0])
HOLSTER_ORIGIN_MM = HOLSTER_TOP_MM - AG.HOLSTER_TOP   # the frame air_gun.py places its holster from
DENSITY = {"6061": 2700.0,                     # aluminium 6061-T6 (Aluminum Association), kg/m^3
           "ampco18": 7450.0}                  # AMPCO 18 [proposed: aluminium bronzes run 7.4-7.6 g/cm3]
METAL = ' priority="1" friction="0.3 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005"'


def _f(v, s=M) -> str:
    return " ".join(f"{x * s:.5f}" for x in np.asarray(v, float))


def in_jaws_mm(dia_mm: float, length_mm: float, depth_mm: float = 8.0) -> np.ndarray:
    """Round stock's centre in the BR10's soft jaws bored to its diameter: its end 0.2 mm off their step, resting on
    the two lower jaws (the open bore 2.2 mm clear of it all round)."""
    front = st25.record()["workholding"]["br10"]["soft_jaw"]["front_x_mm"]
    x0 = front - depth_mm + 0.2
    sag = 2.2 / math.sin(math.radians(30.0 + 26.0))           # down onto the lower jaws' lowest bore faces
    return np.array([x0 + length_mm / 2, 0.0, st25.AXIS[2] - sag * 0.98])


def in_collet_mm(length_mm: float, out_mm: float) -> np.ndarray:
    """A bar's centre in the open collet, out_mm out of its nose, resting on its lower fingers."""
    w = st25.record()["workholding"]["c5"]
    gap = (w["collet"]["bore_open_mm"] - 0.625 * 25.4) / 2
    sag = gap / math.sin(math.radians(30.0 + 40.0))           # onto the lower fingers' lowest faces
    return np.array([w["nose_x_mm"] + out_mm - length_mm / 2, 0.0, st25.AXIS[2] - sag * 0.98])


def stock_xml(name: str, dia_mm: float, length_mm: float, centre_mm, kg_m3: float) -> str:
    """A free round bar or blank, its axis along X, metal on the machine's metal."""
    kg = math.pi * (dia_mm / 2000) ** 2 * (length_mm / 1000) * kg_m3
    return f"""    <body name="{name}" pos="{_f(centre_mm)}">
      <freejoint name="{name}"/>
      <geom name="{name}" type="cylinder" size="{dia_mm / 2 * M:.5f} {length_mm / 2 * M:.5f}" quat="0.7071068 0 0.7071068 0" mass="{kg:.5f}" contype="1" conaffinity="3" condim="4"{METAL} rgba="0.8 0.8 0.82 1"/>
    </body>
"""


def with_body(body_xml: str, workholding: str = "br10", loose: str = "", carried: tuple = (),
              bore_mm: float | None = None, depth_mm: float = 8.0, air_gun: bool = False) -> str:
    """The body model's MJCF with the cell added: the lathe's class, the floor, the lathe, the air gun if asked, the
    loose stock, a carry weld to each carried body from the hand that carries it (a body, the right hand's, or a
    (side, body) pair), the lathe's equalities and contact exclusions, and its actuators after the body's, so the
    body's keep their ids."""
    machine, eq, acts = st25.worldbody(workholding, bore_mm, depth_mm)
    gun = (AG.holster_xml(HOLSTER_ORIGIN_MM) + AG.gun_xml(HOLSTER_ORIGIN_MM)) if air_gun else ""
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + st25.DEFAULT.rstrip("\n") + "\n" + _steel() + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + machine + gun + loose, 1)
    pairs = [c if isinstance(c, tuple) else ("R", c) for c in carried]
    welds = "".join(f'    <weld name="carry_{b}" body1="{side}_hand" body2="{b}" active="false" solref="0.004 1" '
                    f'solimp="0.95 0.99 0.001" torquescale="1"/>\n' for side, b in pairs)
    xml = xml.replace("<equality>\n", "<equality>\n" + welds + eq, 1)
    xml = xml.replace("  <equality>\n", "  <contact>\n" + st25.EXCLUDE + "  </contact>\n  <equality>\n", 1)
    head, _, tail = xml.rpartition("  </actuator>")
    return head + acts + "  </actuator>" + tail


def _steel() -> str:
    """The air gun's holster is drawn in class steel, as on the VF-2 (moonshot/world/vise.py's default)."""
    return ('    <default class="steel"><geom contype="1" conaffinity="3" friction="0.25 0.004 0.0001" '
            'rgba="0.3 0.35 0.6 1"/></default>')


def start(model: mujoco.MjModel, data: mujoco.MjData, door_open: bool = True, clamp_n: float | None = None,
          setup_mode: bool = False) -> st25.Control:
    """The lathe as an operator finds it to load: the door open (or shut, at the pendant), the chuck open, idle, X
    and Z at home."""
    ctl = st25.Control(model, data, clamp_n=clamp_n, setup_mode=setup_mode)
    if door_open:
        data.qpos[ctl.q["door"]] = model.jnt_range[model.joint("st25_door").id][1]
    mujoco.mj_forward(model, data)
    return ctl


def render_links(workholding: str = "br10") -> dict[str, tuple[str, str]]:
    """The lathe's link GLBs and the bodies that carry them (moonshot/world/st25.py)."""
    return st25.render_links(workholding)
