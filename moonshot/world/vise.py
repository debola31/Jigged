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
PARALLEL_T, PARALLEL_L = 3.1, 152.4
RENDER_DIR = "library/workholding/d688/links"            # under the data root


@dataclass(frozen=True)
class Load:
    """What a vise take loads: the part as it sits in the vise (x along the jaws, y across them, z up; mm), the
    parallels under it (their height, and where across the jaws each stands), and the jaw opening the take starts
    from. The part starts on the table right of the vise."""
    size_mm: tuple[float, float, float] = (101.6, 76.2, 38.1)
    parallel_h: float = 25.4
    parallels_y: dict[str, float] = field(default_factory=lambda: {"para_a": -244.0, "para_b": -296.0})
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
    (one each, at frame 0, centred on its body): trainual's rig drew them as plain boxes too, and their sizes change
    with the load."""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    boxes = {"blank": (load.size, "aluminium_6061", [0.8, 0.81, 0.82, 1.0], 0.33)}
    boxes |= {n: ([PARALLEL_L, PARALLEL_T, load.parallel_h], "hardened_steel", [0.62, 0.63, 0.65, 1.0], 0.22)
              for n in load.parallels_y}
    for body, (size, name, colour, rough) in boxes.items():
        box = trimesh.creation.box(extents=np.asarray(size, float) * M)
        box.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
            name=name, baseColorFactor=colour, metallicFactor=1.0, roughnessFactor=rough))
        (Path(folder) / body).mkdir(parents=True, exist_ok=True)
        box.export(Path(folder) / body / "0.glb")
    return {body: {"dir": body, "frames": [0]} for body in boxes}


def knob_center(phi_deg: float) -> np.ndarray:
    """Middle of the knob's grip (mm) at crank angle phi (0 = top, + = clockwise from the operator, closing)."""
    p = math.radians(phi_deg)
    a = VISE["screw_axis"]
    return np.array([a[0] + VISE["lever"] * math.sin(p), a[1] - VISE["knob_grip"], a[2] + VISE["lever"] * math.cos(p)])


def worldbody(load: Load, blank_mm, parallels_mm: dict[str, np.ndarray], hand_body: str,
              table_body: str) -> tuple[str, str, str]:
    """(on-table XML, loose XML, equality XML). The on-table part is the vise, bolted to the machine's table: it goes
    inside table_body, whose origin is the world origin when the take starts. The loose part is the free objects:
    the parallels and the part, which starts at blank_mm (centre).
    parallels_mm: {name: base centre}; each is a free steel body held to the table by a keeper weld until the take
    releases it (its pose on the table is given, as the table isn't at its start in the model's zero pose).
    hand_body: the body the knob enclosure attaches to."""
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
    on_table = f"""    <geom name="vise_seat" class="steel" type="box" size="0.10 {30 * M + o0 / 2 * M:.4f} {(seat - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy - o0 / 2 - 30) * M:.4f} {(seat + TABLE_Z) / 2 * M:.4f}"/>
    <geom name="fixed_jaw" class="steel" type="box" size="{V['half_width'] * M:.4f} 0.02 {(top - TABLE_Z) / 2 * M:.4f}"
          pos="{V['x'] * M:.4f} {(fy + 20) * M:.4f} {(top + TABLE_Z) / 2 * M:.4f}"/>
    <body name="moving_jaw" pos="{V['x'] * M:.4f} {(fy - o0 - 20) * M:.4f} {(top + seat) / 2 * M:.4f}">
      <joint name="jaw_slide" type="slide" axis="0 1 0" range="-0.002 {(o0 - 50) * M:.4f}" damping="40" frictionloss="2"/>
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
    eq += f"""    <connect name="enclose" body1="knob" body2="{hand_body}" anchor="0 -0.045 0" active="false" solref="0.02 1"
             solimp="0.9 0.95 0.002"/>
    <joint name="screw_lock" joint1="crank" polycoef="0 0 0 0 0" active="false" solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
    <joint name="lead_screw" joint1="jaw_slide" joint2="crank" polycoef="0 {V['lead'] * M / (2 * math.pi):.7f} 0 0 0"
           solref="0.002 1" solimp="0.9999 0.9999 0.0001"/>
"""
    return on_table, loose, eq
