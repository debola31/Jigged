"""The Kurt D688 vise on the VF-2's table, with the 0.80 kg aluminium blank and two parallels: trainual's vise take
scene (its motion/showcase_motion.py constants and sim/build_scene.py), as MuJoCo fragments for moonshot/world/cell.py.

World millimetres in the VF-2 machine frame, +Z up. The lead screw is a joint equality between the crank and the
jaw slide (two-way, so the crank has damping and friction); while the hand isn't driving it the screw self-locks
(`screw_lock`, switched by the take runner), because MuJoCo's constant friction can't grow with clamping load.
"""
from __future__ import annotations

import math

import numpy as np

M = 0.001
BLANK = np.array([101.6, 76.2, 38.1])
HALF = BLANK / 2
TABLE_Z = 853.0
STAGE = np.array([-200.0, -470.0, TABLE_Z + HALF[2]])     # the blank starts on the table, right of the vise
VISE = dict(x=-381.5, fixed_face_y=-230.8, seat_z=926.2, jaw_top_z=970.3, half_width=76.2,
            screw_axis=np.array([-381.5, -636.4, 892.29]), lever=120.0, knob_r=13.5, knob_len=90.0, knob_grip=58.0,
            lead=6.35)
PARALLEL_H = 25.4
OPENING0 = 90.0
CRANK0_DEG = 55.0
BLANK_KG = 2700 * float(np.prod(BLANK)) * 1e-9          # 6061 aluminium

STEEL_DEFAULT = """    <default class="steel">
      <!-- metal on metal: as stiff as the 1 ms step allows (solref time constant = 2 steps) -->
      <geom contype="1" conaffinity="3" friction="0.25 0.004 0.0001" priority="1" solref="0.002 1"
            solimp="0.95 0.99 0.0005" rgba="0.3 0.35 0.6 1"/>
    </default>"""


def knob_center(phi_deg: float) -> np.ndarray:
    """Middle of the knob's grip (mm) at crank angle phi (0 = top, + = clockwise from the operator, closing)."""
    p = math.radians(phi_deg)
    a = VISE["screw_axis"]
    return np.array([a[0] + VISE["lever"] * math.sin(p), a[1] - VISE["knob_grip"], a[2] + VISE["lever"] * math.cos(p)])


def worldbody(blank_mm, parallels_mm: dict[str, np.ndarray], hand_body: str, table_body: str) -> tuple[str, str, str]:
    """(on-table XML, loose XML, equality XML). The on-table part is the vise, bolted to the machine's table: it goes
    inside table_body, whose origin is the world origin when the take starts. The loose part is the free objects.
    parallels_mm: {name: base centre}; each is a free steel body held to the table by a keeper weld until the take
    releases it (its pose on the table is given, as the table isn't at its start in the model's zero pose).
    hand_body: the body the knob enclosure attaches to."""
    V, fy, seat, top = VISE, VISE["fixed_face_y"], VISE["seat_z"], VISE["jaw_top_z"]
    ax = V["screw_axis"]
    phi0 = math.radians(CRANK0_DEG)
    lever = np.array([math.sin(phi0), 0, math.cos(phi0)]) * V["lever"]
    f = lambda v: " ".join(f"{float(x) * M:.5f}" for x in v)   # noqa: E731
    paras = "".join(
        f'''    <body name="{n}" pos="{f(p + np.array([0, 0, PARALLEL_H / 2]))}">
      <freejoint name="{n}"/>
      <geom name="{n}" class="steel" type="box" size="0.0762 0.00155 0.0127" mass="0.094"/>
    </body>
''' for n, p in parallels_mm.items())
    on_table = f"""    <geom name="vise_seat" class="steel" type="box" size="0.10 {30 * M + OPENING0 / 2 * M:.4f} {(seat - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy - OPENING0 / 2 - 30) * M:.4f} {(seat + TABLE_Z) / 2 * M:.4f}"/>
    <geom name="fixed_jaw" class="steel" type="box" size="{V['half_width'] * M:.4f} 0.02 {(top - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy + 20) * M:.4f} {(top + TABLE_Z) / 2 * M:.4f}"/>
    <body name="moving_jaw" pos="{V['x'] * M:.4f} {(fy - OPENING0 - 20) * M:.4f} {(top + seat) / 2 * M:.4f}">
      <joint name="jaw_slide" type="slide" axis="0 1 0" range="-0.002 {(OPENING0 - 50) * M:.4f}" damping="40" frictionloss="2"/>
      <joint name="jaw_drop" type="slide" axis="0 0 1" range="-0.0003 0.0001" stiffness="6e6" damping="3000"/>
      <geom name="moving_jaw" class="steel" type="box" size="{V['half_width'] * M:.4f} 0.02 {((top - seat) / 2 - 0.25) * M:.5f}"
            pos="0 0 {0.25 * M:.5f}" mass="4"/>
    </body>
    <body name="crank" pos="{f(ax)}">
      <joint name="crank" type="hinge" axis="0 1 0" limited="false" damping="0.05" frictionloss="0.6" armature="0.02"/>
      <geom name="lever" class="steel" type="capsule" size="0.008" contype="0" conaffinity="0"
            fromto="0 0.002 0 {lever[0] * M:.5f} 0.002 {lever[2] * M:.5f}" mass="0.08"/>
      <body name="knob" pos="{lever[0] * M:.5f} 0 {lever[2] * M:.5f}">
        <joint name="knob_spin" type="hinge" axis="0 1 0" limited="false" damping="0.0005"/>
        <geom name="knob" class="steel" type="cylinder" size="{V['knob_r'] * M:.4f} {V['knob_len'] / 2 * M:.4f}"
              pos="0 {-V['knob_len'] / 2 * M:.4f} 0" quat="0.7071068 0.7071068 0 0" friction="0.5 0.004 0.0001"
              mass="0.04" rgba="0.05 0.05 0.05 1"/>
      </body>
    </body>
"""
    loose = paras + f"""    <body name="blank" pos="{f(blank_mm)}">
      <freejoint name="blank"/>
      <geom name="blank" type="box" size="{f(HALF)}" mass="{BLANK_KG:.4f}" contype="1" conaffinity="3" priority="1"
            friction="0.25 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005" rgba="0.8 0.8 0.82 1"/>
    </body>
"""
    # anchored at the parallel itself: at the table's origin, a metre away, a slight twist became a large slide
    eq = "".join(f'    <weld name="keep_{n}" body1="{n}" body2="{table_body}" '
                 f'anchor="{f(p + np.array([0, 0, PARALLEL_H / 2]))}" relpose="0 0 0 1 0 0 0" solref="0.005 1"/>\n'
                 for n, p in parallels_mm.items())
    eq += f"""    <connect name="enclose" body1="knob" body2="{hand_body}" anchor="0 -0.045 0" active="false" solref="0.02 1"
             solimp="0.9 0.95 0.002"/>
    <joint name="screw_lock" joint1="crank" polycoef="0 0 0 0 0" active="false" solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
    <joint name="lead_screw" joint1="jaw_slide" joint2="crank" polycoef="0 {V['lead'] * M / (2 * math.pi):.7f} 0 0 0"
           solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
"""
    return on_table, loose, eq
