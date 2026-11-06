"""The shop air gun and its holster on the VF-2's front panel (plan §3.2): the blow gun a machinist clears chips with.
A generic pistol-grip blow gun, built from the common form (no maker's CAD): a 90 mm handle, a neck and a valve body
on top, a 115 mm nozzle and a trigger under the body; its 0.18 kg is proposed.

The holster is an open-topped box on a bracket off the enclosure's front panel right of the door opening (the
panel's face is at y = -794.5 there, in the enclosure's GLB). The gun stands in it nozzle down, resting on the rim
by its valve body, its handle out to the right and toward the operator (HOLSTER_YAW_DEG). It is a free body, held only
by contact. Its trigger is a geom the index presses; no air flows (declared: the chips it would clear aren't simulated
either).

Where it hangs is proposed, not measured. Moved 2026-11-04 (station change, stated in the hand-back): from 1120 mm
high with the handle out to the left, toward the opening, to hip height with the handle out to the right at 45 deg
toward the operator, on the same panel, the same bracket's distance off it. The pistol grip has the palm on the
handle's top, so a handle out to the left put the fingers pointing back at the operator, and from the vise take's
stance the right arm took it with the wrist bent past people's range (inside it on 9-14% of frames); handle out to the
right and toward the operator, the hand comes over it pointing forward and right, as it reaches there, and at hip
height the arm hangs to it instead of lifting the elbow.

Frames: the gun's own frame has the handle along +z, the nozzle along +x and its origin mid-handle; the holster
is given in the VF-2's station frame (mm).
"""
from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation

M = 0.001
GUN_KG = 0.18
HANDLE_R, HANDLE_HALF = 13.0, 45.0                  # mm
BODY_C, BODY_HALF = np.array([25.0, 0.0, 75.0]), np.array([35.0, 16.0, 16.0])
NOZZLE_R, NOZZLE_FROM, NOZZLE_TO = 4.0, np.array([60.0, 0.0, 75.0]), np.array([175.0, 0.0, 75.0])
TRIGGER_C, TRIGGER_HALF = np.array([20.0, 0.0, 30.0]), np.array([5.0, 4.0, 12.0])
HOLSTER_TOP = np.array([520.0, -870.0, 870.0])      # station frame: the middle of the holster's open top, on a bracket
# standing 95 mm proud of the right door, so the door's pull bar (out to y -845) passes behind the holstered gun as
# the door slides; at -812 the pull swept into the gun, and the fingers round its handle met the door's panel
HOLSTER_IN, HOLSTER_DEPTH, WALL = 14.0, 125.0, 3.0  # a 14 mm square bore: the 8 mm nozzle drops in, the 32 mm body can't;
# at 24 the hung gun leant 8 degrees under its handle's weight, one way or the other
# holstered: the nozzle points down, the handle out to the right at 45 deg toward the operator (turned 135 deg about
# the nozzle from out to the left); the holster's square bore is turned with it, its walls square to the gun's valve
# body, which rests across them: square to the room, the body pivoted on the bore's corners and the hung gun turned
# 17 deg in it of its own accord
HOLSTER_YAW_DEG = 135.0
HOLSTER_R = Rotation.from_euler("z", HOLSTER_YAW_DEG, degrees=True).as_matrix()
HOLSTERED = HOLSTER_R @ Rotation.from_euler("y", 90, degrees=True).as_matrix()


def _f(v, s=M) -> str:
    return " ".join(f"{x * s:.5f}" for x in np.asarray(v, float))


# as it hangs: the handle's weight leans it in the bore until the nozzle meets the bore's wall, 3.0 deg about the
# holster's own y, and it settles 6.0 mm toward the handle and 4.6 down (measured in the physics, 2026-11-04). Planned
# on it stood square, the grip closed 8-10 mm off the hung gun, the skin 5-8 mm into its handle
HOLSTER_LEAN_DEG = -3.0
HOLSTER_SETTLE_MM = np.array([-6.05, 0.0, -4.64])


def holstered_pose(origin_mm) -> tuple[np.ndarray, np.ndarray]:
    """The gun's world frame and origin (mm) hanging in its holster, as it settles there; origin_mm is the station
    frame's in the world."""
    tip_in_gun = NOZZLE_FROM                          # the valve body's nozzle end sits on the rim
    rim = np.asarray(origin_mm, float) + HOLSTER_TOP
    p = rim - HOLSTERED @ tip_in_gun + np.array([0.0, 0.0, 1.0]) + HOLSTER_R @ HOLSTER_SETTLE_MM
    R = HOLSTER_R @ Rotation.from_euler("y", HOLSTER_LEAN_DEG, degrees=True).as_matrix() @ HOLSTER_R.T @ HOLSTERED
    return R, p


def holster_xml(origin_mm) -> str:
    """The holster's four walls and floor, fixed to the world."""
    c = np.asarray(origin_mm, float) + HOLSTER_TOP - np.array([0.0, 0.0, HOLSTER_DEPTH / 2])
    a, h = HOLSTER_IN / 2 + WALL / 2, HOLSTER_DEPTH / 2
    walls = [((a, 0, 0), (WALL / 2, a + WALL / 2, h)), ((-a, 0, 0), (WALL / 2, a + WALL / 2, h)),
             ((0, a, 0), (a + WALL / 2, WALL / 2, h)), ((0, -a, 0), (a + WALL / 2, WALL / 2, h)),
             ((0, 0, -h), (a + WALL / 2, a + WALL / 2, WALL / 2))]
    q = Rotation.from_matrix(HOLSTER_R).as_quat()                   # x y z w
    quat = f"{q[3]:.6f} {q[0]:.6f} {q[1]:.6f} {q[2]:.6f}"
    return "".join(f'    <geom name="holster_{i}" class="steel" type="box" size="{_f(s)}" '
                   f'pos="{_f(c + HOLSTER_R @ np.array(o))}" quat="{quat}" rgba="0.15 0.15 0.15 1"/>\n'
                   for i, (o, s) in enumerate(walls))


def gun_xml(origin_mm) -> str:
    """The gun as a free body standing in its holster."""
    R, p = holstered_pose(origin_mm)
    q = Rotation.from_matrix(R).as_quat()                   # x y z w
    return f"""    <body name="air_gun" pos="{_f(p)}" quat="{q[3]:.6f} {q[0]:.6f} {q[1]:.6f} {q[2]:.6f}">
      <freejoint name="air_gun"/>
      <geom name="air_gun_neck" type="capsule" size="0.0100" fromto="0 0 {HANDLE_HALF * M:.4f} 0 0 {(BODY_C[2] - BODY_HALF[2]) * M:.4f}"
            mass="{GUN_KG * 0.05:.4f}" contype="1" conaffinity="3" rgba="0.6 0.6 0.62 1"/>
      <geom name="air_gun_handle" type="capsule" size="{HANDLE_R * M:.4f}" fromto="0 0 {-HANDLE_HALF * M:.4f} 0 0 {HANDLE_HALF * M:.4f}"
            mass="{GUN_KG * 0.45:.4f}" friction="0.8 0.004 0.0001" contype="1" conaffinity="3" rgba="0.75 0.1 0.08 1"/>
      <geom name="air_gun_body" type="box" size="{_f(BODY_HALF)}" pos="{_f(BODY_C)}" mass="{GUN_KG * 0.35:.4f}"
            contype="1" conaffinity="3" rgba="0.6 0.6 0.62 1"/>
      <geom name="air_gun_nozzle" type="capsule" size="{NOZZLE_R * M:.4f}" fromto="{_f(NOZZLE_FROM)} {_f(NOZZLE_TO)}"
            mass="{GUN_KG * 0.15:.4f}" contype="1" conaffinity="3" rgba="0.7 0.7 0.72 1"/>
      <geom name="air_gun_trigger" type="box" size="{_f(TRIGGER_HALF)}" pos="{_f(TRIGGER_C)}" mass="{GUN_KG * 0.05:.4f}"
            contype="1" conaffinity="3" rgba="0.1 0.1 0.1 1"/>
      <site name="air_gun_tip" pos="{_f(NOZZLE_TO)}" size="0.004"/>
    </body>
"""
