"""The Kurt D688 vise on the VF-2's table, with a part and two parallels: trainual's vise take scene (its
motion/showcase_motion.py constants and sim/build_scene.py), as MuJoCo fragments for moonshot/world/cell.py. What is
loaded is a `Load`; REFERENCE is trainual's accepted take (a 0.80 kg aluminium blank on 1 in parallels).

World millimetres in the VF-2 machine frame, +Z up. The lead screw is a joint equality between the crank and the
jaw slide (two-way, so the crank has damping and friction); while the hand isn't driving it the screw self-locks
(`screw_lock`, switched by the take runner), because MuJoCo's constant friction can't grow with clamping load.

What the render draws (moonshot/contracts/take_record.py): the D688's parts from trainual's rig, one GLB per body,
each authored in its body's own frame (moonshot/render/dress.py writes them), and the part and parallels as boxes at
the load's size, written into each take.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

M = 0.001
TABLE_Z = 853.0
VISE = dict(x=-381.5, fixed_face_y=-230.8, seat_z=926.2, jaw_top_z=970.3, half_width=76.2,
            screw_axis=np.array([-381.5, -636.4, 892.29]), lever=120.0, knob_r=13.5, knob_len=90.0, knob_grip=58.0,
            lead=6.35)
CRANK0_DEG = 55.0
ENCLOSE_SOLREF_S = 0.005    # the knob weld's time constant (s): how stiffly the fist holds the knob; at 0.02 the final
                            # pull's push moved the knob 2-3 mm in the fist, onto the index (skin 3.9 mm, op10)
PARALLEL_T, PARALLEL_L = 3.1, 152.4
# the stop a part stood on the vise's floor is set against (nist-ftc-10 op50): a steel block (x along the jaws, y
# across, z up; mm), tall enough to be pinched by its top over the jaws, narrower across than such a part, so the jaws
# close on the part and not on it
STOP_MM = (38.1, 19.05, 63.5)
STOP_KG = 7850 * math.prod(STOP_MM) * 1e-9
STOP_HOME = np.array([-600.0, -350.0, TABLE_Z])          # its base centre where it waits on the table, beyond the
                                                         # parallels' rack (moonshot/world/parallel_rack.py)
JAW_MIN_MM = 10.0          # the jaw closes down to this opening: a part on its side (nist-ftc-10 op30, 31 mm) needs it
RENDER_DIR = "library/workholding/d688/links"            # under the data root


@dataclass(frozen=True)
class Load:
    """What a vise take loads: the part as it sits in the vise (x along the jaws, y across them, z up; mm), the
    parallels under it (their height, and where across the jaws each stands), and the jaw opening the take starts
    from. The part starts on the table right of the vise."""
    size_mm: tuple[float, float, float] = (101.6, 76.2, 38.1)
    parallel_h: float = 25.4
    # parallel a 19 mm in from the fixed jaw (face at -230.8): at 13.2 the fingers setting it by its top edge (index
    # and middle 13-14.5 mm thick) didn't fit in the 11.65 mm beside the jaw; a machinist leaves a finger's width
    parallels_y: dict[str, float] = field(default_factory=lambda: {"para_a": -249.8, "para_b": -296.0})
    opening0: float = 90.0
    density: float = 2700.0                                  # 6061 aluminium (kg/m^3)

    @property
    def size(self) -> np.ndarray:
        return np.array(self.size_mm, float)

    @property
    def half(self) -> np.ndarray:
        return self.size / 2

    @property
    def mass_kg(self) -> float:
        return self.density * float(np.prod(self.size)) * 1e-9

    @property
    def stage(self) -> np.ndarray:
        return np.array([-200.0, -470.0, TABLE_Z + self.half[2]])

    def parallels(self) -> dict[str, np.ndarray]:
        """Each parallel's base centre (mm), on the vise's seat."""
        return {n: np.array([VISE["x"], y, VISE["seat_z"]]) for n, y in self.parallels_y.items()}

    def stop(self) -> np.ndarray | None:
        """The stop's base centre (mm), on the vise's floor against the part's -x end, when the part stands on the floor
        (no parallels); None otherwise. Centred across the part, so the fingers that set it fit beside it."""
        if self.parallels_y:
            return None
        return np.array([VISE["x"] - self.size[0] / 2 - STOP_MM[0] / 2, VISE["fixed_face_y"] - self.size[1] / 2,
                         VISE["seat_z"]])

    def to_json(self) -> dict:
        return {"size_mm": list(self.size_mm), "parallel_h": self.parallel_h, "parallels_y": dict(self.parallels_y),
                "opening0": self.opening0, "density": self.density}

    @classmethod
    def from_json(cls, d: dict) -> "Load":
        return cls(tuple(d["size_mm"]), d["parallel_h"], dict(d["parallels_y"]), d["opening0"], d["density"])


REFERENCE = Load()
# the reference load's values under the names trainual's take and the gates use
BLANK, HALF, STAGE = REFERENCE.size, REFERENCE.half, REFERENCE.stage
PARALLEL_H, OPENING0, BLANK_KG = REFERENCE.parallel_h, REFERENCE.opening0, REFERENCE.mass_kg


def crank_for_opening(opening: float, opening0: float = OPENING0) -> float:
    """The crank angle (deg) at which the jaws stand this far apart (mm), from opening0 at CRANK0_DEG."""
    return CRANK0_DEG + (opening0 - opening) / VISE["lead"] * 360.0


STEEL_DEFAULT = """    <default class="steel">
      <!-- metal on metal: as stiff as the 1 ms step allows (solref time constant = 2 steps) -->
      <geom contype="1" conaffinity="3" friction="0.25 0.004 0.0001" priority="1" solref="0.002 1"
            solimp="0.95 0.99 0.0005" rgba="0.3 0.35 0.6 1"/>
    </default>"""


def render_glbs(table_body: str = "vf2_table") -> dict[str, list[dict]]:
    """The D688's GLBs for a take record, by the body that carries each. Each is authored in its body's own frame,
    so it stays right whatever opening a load starts the jaw at."""
    bodies = {"base": table_body, "jaw": "moving_jaw", "handle": "crank", "knob": "knob"}
    return {body: [{"path": f"{RENDER_DIR}/{link}.glb", "in_body": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], "link": link}]
            for link, body in bodies.items()}


def render_meshes(load: Load, folder: Path) -> dict[str, dict]:
    """The part and the parallels as boxes at the load's size, written into a take's folder for its record's "meshes"
    (one each, at frame 0, centred on its body, in mm as meshes are): trainual's rig drew them as plain boxes too, and
    their sizes change with the load."""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    boxes = {"blank": (load.size, "aluminium_6061", [0.8, 0.81, 0.82, 1.0], 0.33)}
    boxes |= {n: ([PARALLEL_L, PARALLEL_T, load.parallel_h], "hardened_steel", [0.62, 0.63, 0.65, 1.0], 0.22)
              for n in load.parallels_y}
    if load.stop() is not None:
        boxes["stop"] = (STOP_MM, "hardened_steel", [0.62, 0.63, 0.65, 1.0], 0.22)
    for body, (size, name, colour, rough) in boxes.items():
        box = trimesh.creation.box(extents=np.asarray(size, float))
        box.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
            name=name, baseColorFactor=colour, metallicFactor=1.0, roughnessFactor=rough))
        (Path(folder) / body).mkdir(parents=True, exist_ok=True)
        box.export(Path(folder) / body / "0.glb")
    return {body: {"dir": body, "frames": [0]} for body in boxes}


TIP_SHARE_MM = 16.0     # a parallel this near another (a fingertip's width) is pressed on its far side from it
TIP_OUT_MM = 2.5        # ... this far off its centre line (the pad's middle; a 14 mm pad there still covers its
                        # 3.1 mm end, and its side stands clear of the neighbour's)


def tip_y(parallels: dict, name: str, share: float = TIP_SHARE_MM, out: float = TIP_OUT_MM) -> float:
    """Where across the vise a fingertip check on parallel `name` presses (parallels: name -> centre; share and out in
    their unit): its centre line, or, with a neighbour nearer than a fingertip is wide, off it away from the
    neighbour. op30's and op40's parallels stand 6.8 mm apart under their 31 mm part: the 14 mm pad aimed at para_b's
    centre pressed para_a, 4 mm into its end, and para_b read 0 N; aimed between them it nosed into the gap and
    pressed neither."""
    y = float(parallels[name][1])
    near = [float(p[1]) for n, p in parallels.items() if n != name and abs(float(p[1]) - y) < share]
    return y + float(np.sign(y - near[0])) * out if near else y


def knob_center(phi_deg: float) -> np.ndarray:
    """Middle of the knob's grip (mm) at crank angle phi (0 = top, + = clockwise from the operator, closing)."""
    p = math.radians(phi_deg)
    a = VISE["screw_axis"]
    return np.array([a[0] + VISE["lever"] * math.sin(p), a[1] - VISE["knob_grip"], a[2] + VISE["lever"] * math.cos(p)])


def worldbody(load: Load, blank_mm, parallels_mm: dict[str, np.ndarray], hand_body: str,
              table_body: str, stop_mm=None) -> tuple[str, str, str]:
    """(on-table XML, loose XML, equality XML). The on-table part is the vise, bolted to the machine's table: it goes
    inside table_body, whose origin is the world origin when the take starts. The loose part is the free objects:
    the parallels and the part, which starts at blank_mm (centre).
    parallels_mm: {name: base centre}; each is a free steel body held to the table by a keeper weld until the take
    releases it (its pose on the table is given, as the table isn't at its start in the model's zero pose).
    hand_body: the body the knob enclosure attaches to. stop_mm: the stop's base centre, if the load has one (Load.stop),
    a free steel body held by a keeper weld as the parallels are."""
    V, fy, seat, top = VISE, VISE["fixed_face_y"], VISE["seat_z"], VISE["jaw_top_z"]
    ax = V["screw_axis"]
    phi0 = math.radians(CRANK0_DEG)
    lever = np.array([math.sin(phi0), 0, math.cos(phi0)]) * V["lever"]
    f = lambda v: " ".join(f"{float(x) * M:.5f}" for x in v)   # noqa: E731
    o0, ph = load.opening0, load.parallel_h
    para_size = f([PARALLEL_L / 2, PARALLEL_T / 2, ph / 2])
    para_kg = 7850 * PARALLEL_L * PARALLEL_T * ph * 1e-9      # hardened steel
    paras = "".join(
        f'''    <body name="{n}" pos="{f(p + np.array([0, 0, ph / 2]))}">
      <freejoint name="{n}"/>
      <geom name="{n}" class="steel" type="box" size="{para_size}" mass="{para_kg:.4f}"/>
    </body>
''' for n, p in parallels_mm.items())
    if stop_mm is not None:
        paras += f'''    <body name="stop" pos="{f(np.asarray(stop_mm) + [0, 0, STOP_MM[2] / 2])}">
      <freejoint name="stop"/>
      <geom name="stop" class="steel" type="box" size="{f(np.array(STOP_MM) / 2)}" mass="{STOP_KG:.4f}"/>
    </body>
'''
    on_table = f"""    <geom name="vise_seat" class="steel" type="box" size="0.10 {30 * M + o0 / 2 * M:.4f} {(seat - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy - o0 / 2 - 30) * M:.4f} {(seat + TABLE_Z) / 2 * M:.4f}"/>
    <geom name="fixed_jaw" class="steel" type="box" size="{V['half_width'] * M:.4f} 0.02 {(top - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy + 20) * M:.4f} {(top + TABLE_Z) / 2 * M:.4f}"/>
    <body name="moving_jaw" pos="{V['x'] * M:.4f} {(fy - o0 - 20) * M:.4f} {(top + seat) / 2 * M:.4f}">
      <joint name="jaw_slide" type="slide" axis="0 1 0" range="-0.002 {(o0 - JAW_MIN_MM) * M:.4f}" damping="40" frictionloss="2"/>
      <joint name="jaw_drop" type="slide" axis="0 0 1" range="-0.0003 0.0001" stiffness="6e6" damping="3000"/>
      <geom name="moving_jaw" class="steel" type="box" size="{V['half_width'] * M:.4f} 0.02 {((top - seat) / 2 - 0.25) * M:.5f}"
            pos="0 0 {0.25 * M:.5f}" mass="4"/>
    </body>
    <body name="crank" pos="{f(ax)}">
      <joint name="crank" type="hinge" axis="0 1 0" limited="false" damping="0.05" frictionloss="0.6" armature="0.02"/>
      <!-- the lever collides with the hand only (conaffinity 2, the skin's contype): it turns 2 mm off the vise's
           end, where steel-on-steel contact would be spurious -->
      <geom name="lever" class="steel" type="capsule" size="0.008" contype="0" conaffinity="2"
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
      <geom name="blank" type="box" size="{f(load.half)}" mass="{load.mass_kg:.4f}" contype="1" conaffinity="3" priority="1"
            friction="0.25 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005" rgba="0.8 0.8 0.82 1"/>
    </body>
"""
    # anchored at the parallel itself: at the table's origin, a metre away, a slight twist became a large slide
    eq = "".join(f'    <weld name="keep_{n}" body1="{n}" body2="{table_body}" '
                 f'anchor="{f(p + np.array([0, 0, ph / 2]))}" relpose="0 0 0 1 0 0 0" solref="0.005 1"/>\n'
                 for n, p in parallels_mm.items())
    if stop_mm is not None:
        eq += (f'    <weld name="keep_stop" body1="stop" body2="{table_body}" '
               f'anchor="{f(np.asarray(stop_mm) + [0, 0, STOP_MM[2] / 2])}" relpose="0 0 0 1 0 0 0" solref="0.005 1"/>\n')
    # the knob held in the fist by its middle and its axis (a weld; the knob spins on the lever as the fist turns): held by a
    # point only, the fist's tilt off the knob's axis under the final pull went into the fingers, 155 N on the little
    # finger's tip and 2.7 mm into the knob. Its pose in the hand is set by the take runner as the fist closes
    eq += f"""    <weld name="enclose" body1="knob" body2="{hand_body}" active="false" solref="{ENCLOSE_SOLREF_S} 1"
             solimp="0.9 0.95 0.002"/>
    <joint name="screw_lock" joint1="crank" polycoef="0 0 0 0 0" active="false" solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
    <joint name="lead_screw" joint1="jaw_slide" joint2="crank" polycoef="0 {V['lead'] * M / (2 * math.pi):.7f} 0 0 0"
           solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
"""
    return on_table, loose, eq
