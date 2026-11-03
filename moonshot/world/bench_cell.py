"""The inspection bench as a cell for a body model's takes (plan §3.2): the station (moonshot/world/inspection_bench.py),
the finished part on it, and what the take picks up, set into the body model's MJCF the way moonshot/world/cell.py
sets in the VF-2.

World millimetres in the bench's frame (front at -Y, floor at z = 0). Each object's body frame is its own asset's,
so the render draws its GLB at the body's pose:
- the part: nist-ftc-10 as finished, its frame the STEP's (Y up from datum A, the pocket side, at Y = 0; X along it,
  Z across). Its colliders are boxes read off the STEP's planar faces (moonshot/world/bench_cell.py PART_BOXES): the
  pocket's walls and floor, the ears, and the 1 mm boss on the scalloped side it rests on with the slab's far edge.
  Stiff contact, as the station's surfaces have, so what rests on it sits at its true height.
- the deburring tool: the swivel-blade tool out of the deburring kit (library/hand_tools/deburr), its frame on the
  handle's axis at its back end, +X toward the blade.
- the bench mat: a rubber mat the part lies on, as parts are deburred and checked so they don't skate (mat_body).
  On the bare maple a steadying hand's drift, or a blade's push, slid the part 3 to 11 mm.
- the calipers (cal6, Mitutoyo 500-196-30): the station's single box replaced by the beam and, on a slide joint along
  the beam (+X opens), the slider with its jaw, thumb roller and depth rod. Closed, the rod is flush with the beam's
  end; opened by s, it stands s past it, which is how calipers read a depth.

A tool the right hand carries is held by a declared shortcut, `carry_<body>`: a stiff weld to the hand where the tool
sits when the hand closes on it, switched by the take (moonshot/sim/bench.py, which has the hand correct by sight for
where that differs from the planned grip). Capsule fingers can't conform round a 15 mm handle as flesh does (the vise's knob
needed `enclose` for the same reason). The skin's depth inside the tool and never touching its blade or rod are what
check it (moonshot/validate).
"""
from __future__ import annotations

import numpy as np

from moonshot.world import inspection_bench as IB

M = 0.001
FLOOR = '    <geom name="floor" type="plane" size="3 3 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'
# the bench's own frame as a body: its top and plate are world geoms, which a take record doesn't carry, so the
# render's bench and plate meshes ride on this (render_glbs)
STATIC = '    <body name="insp_bench"/>\n'

# --- the part, in its STEP's frame (mm) -----------------------------------------------------------------------------
PART_KG = 0.508                      # the STEP's 188,171 mm^3 of 6061-T6 (2,700 kg/m^3; the process plan's stock)
PART_COM = (4.79, 14.51, -0.30)      # the STEP's centre of mass
POCKET = {"x": (-58.0, 20.0), "z": (-25.0, 25.0), "depth": 17.0}   # the opening at datum A; the floor at Y = 17
PART_BOXES = {                       # (min, max): the STEP's planar faces, its fillets and holes left out
    "part_slab": ((-62.5, 17.0, -37.5), (62.5, 30.0, 37.5)),     # under the pocket's floor, to the scallops' crowns
    "part_wall_near": ((-62.5, 0.0, 25.0), (62.5, 17.0, 37.5)),  # +Z side of the pocket
    "part_wall_far": ((-62.5, 0.0, -37.5), (62.5, 17.0, -25.0)),
    "part_wall_end": ((-62.5, 0.0, -25.0), (-58.0, 17.0, 25.0)),  # -X end
    "part_wall_rim": ((20.0, 0.0, -25.0), (62.5, 17.0, 25.0)),    # +X end: the wide rim
    "part_ear_a": ((62.5, 0.0, -36.5), (79.0, 8.0, 36.5)),
    "part_ear_b": ((-79.0, 0.0, -36.5), (-62.5, 8.0, 36.5)),
    "part_boss": ((35.5, 30.0, 16.0), (59.5, 31.0, 31.0)),       # the one face at Y = 31
}
POCKET_UP = (0.0, 0.0, 0.70710678, -0.70710678)    # w x y z: the STEP's -Y up, its +X to the world's -X, +Z to -Y

# --- the bench mat (mm) -------------------------------------------------------------------------------------------
MAT = {"size": (240.0, 140.0, 3.0), "friction": 0.9,     # rubber on aluminium and on maple, about 0.9 (proposed)
       "rgba": (0.08, 0.08, 0.09, 1.0)}

# --- the deburring tool, in its own frame (mm): out of the kit's GLB ----------------------------------------------------
DEBURR = {"handle_r": 7.62, "handle_len": 127.0, "blade_r": 1.52, "blade_len": 38.1, "kg": 0.05,
          "in_kit": (-114.3, 79.4, 17.8)}     # the handle's back end, in the kit asset's frame (mm)

# --- the calipers, in the cal6 asset's frame (mm), lying flat, closed -------------------------------------------------
CAL = {"beam": ((-116.6, 1.75, 2.5), (116.6, 17.75, 6.0)),       # 16 x 3.5 mm, as the model's end measures
       "jaw_out": ((-116.6, -38.2, 2.5), (-108.2, 1.75, 6.0)),      # the fixed jaws
       "jaw_in": ((-116.6, 17.75, 2.5), (-110.0, 38.2, 6.0)),
       "slider": ((-100.4, -3.0, 0.0), (-58.3, 24.0, 12.5)),        # round the beam, with the display
       "slider_bulge": ((-58.3, -17.8, 0.0), (-40.4, 24.0, 12.5)),  # ... and its buttons
       "mjaw_out": ((-108.2, -38.2, 2.5), (-100.4, -17.8, 6.0)),    # the moving jaw
       "rod": ((-40.4, 8.75, 1.4), (116.6, 10.75, 2.4)),            # the depth rod, behind the beam's back face
       "roller": {"at": (-68.6, 24.25, 6.25), "r": 4.4, "half": 5.5},     # the thumb roller, axis along +Y
       "beam_kg": 0.10, "slider_kg": 0.07, "travel": 150.0, "friction_N": 0.3}


def _f(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.6f}" for x in v)


def _box(name: str, lo, hi, extra: str = "") -> str:
    lo, hi = np.array(lo, float), np.array(hi, float)
    return f'<geom name="{name}" type="box" size="{_f((hi - lo) / 2)}" pos="{_f((lo + hi) / 2)}"{extra}/>'


def defaults() -> str:
    """The station's classes, and the part's and the tools'."""
    c = IB.record()["contact"]
    return IB.defaults() + f"""
    <default class="part">
      <!-- aluminium, as stiff as the station's surfaces: a caliper's rod and beam on it read true -->
      <geom contype="1" conaffinity="3" priority="1" friction="0.4 0.004 0.0001" solref="{_f(c['solref'], 1)}"
            solimp="{_f(c['solimp'], 1)}" rgba="0.78 0.79 0.8 1"/>
    </default>
    <default class="tool">
      <!-- rolling friction too: set down, a round handle otherwise rolls on forever -->
      <geom contype="1" conaffinity="3" condim="6" friction="0.4 0.004 0.002" rgba="0.2 0.3 0.6 1"/>
    </default>"""


def part_body(at_mm) -> str:
    """The finished part, pocket side up, its STEP origin (datum A's middle) at at_mm."""
    geoms = "".join(f'\n      {_box(n, lo, hi, " class=\"part\"")}' for n, (lo, hi) in PART_BOXES.items())
    return (f'    <body name="part" pos="{_f(at_mm)}" quat="{_f(POCKET_UP, 1)}">\n      <freejoint name="part"/>\n'
            f'      <inertial pos="{_f(PART_COM)}" mass="{PART_KG}" diaginertia="2.79e-4 1.295e-3 1.097e-3"/>{geoms}\n'
            f'    </body>\n')


def mat_body(centre_mm) -> str:
    """The rubber mat lying on the bench, centred on centre_mm (x, y): a static body, so the take record carries it."""
    sx, sy, sz = MAT["size"]
    at = [centre_mm[0], centre_mm[1], IB.tops_mm()["bench"] + sz / 2]
    return f"""    <body name="bench_mat" pos="{_f(at)}">
      <geom name="bench_mat" type="box" size="{_f([sx / 2, sy / 2, sz / 2])}" class="surface"
            friction="{MAT['friction']} 0.004 0.0001" rgba="{_f(MAT['rgba'], 1)}"/>
    </body>
"""


def deburr_body(at_mm, yaw_deg: float) -> str:
    """The deburring tool lying on its handle: at_mm is its frame's origin, the handle's back end on its axis."""
    D = DEBURR
    r, L, br = D["handle_r"], D["handle_len"], D["blade_r"]
    tip = L + D["blade_len"]
    return f"""    <body name="deburr_tool" pos="{_f(at_mm)}" euler="0 0 {np.radians(yaw_deg):.6f}">
      <freejoint name="deburr_tool"/>
      <geom name="deburr_handle" class="tool" type="capsule" size="{r * M:.5f}" fromto="{_f([r, 0, 0])} {_f([L - r, 0, 0])}"
            mass="{D['kg'] * 0.9:.4f}"/>
      <geom name="deburr_blade" class="tool" type="capsule" size="{br * M:.5f}" fromto="{_f([L + br, 0, 0])} {_f([tip - br, 0, 0])}"
            mass="{D['kg'] * 0.1:.4f}" rgba="0.85 0.85 0.85 1"/>
    </body>
"""


def caliper_body(at_mm, yaw_deg: float, face_down: bool = False) -> str:
    """The calipers lying flat and closed, their asset frame at at_mm turned yaw_deg: the beam, and the slider on it.
    face_down lays them on their display, turned over about the beam, at_mm still where their face-up underside was."""
    C = CAL
    ro = C["roller"]
    vol = lambda *ks: sum(float(np.prod(np.subtract(C[k][1], C[k][0]))) for k in ks)   # noqa: E731
    beam_d = C["beam_kg"] / vol("beam", "jaw_out", "jaw_in") / 1e-9
    slider_d = C["slider_kg"] / vol("slider", "slider_bulge", "mjaw_out", "rod") / 1e-9
    h = np.radians(yaw_deg) / 2
    pose = (f'pos="{_f(np.asarray(at_mm, float) + [0, 0, C["slider"][1][2]])}" quat="0 {np.cos(h):.7f} {np.sin(h):.7f} 0"'
            if face_down else f'pos="{_f(at_mm)}" euler="0 0 {2 * h:.6f}"')
    return f"""    <body name="insp_cal6" {pose}>
      <freejoint name="insp_cal6"/>
      {_box("cal6_beam", *C["beam"], f' class="tool" density="{beam_d:.1f}" rgba="0.75 0.75 0.78 1"')}
      {_box("cal6_jaw_out", *C["jaw_out"], f' class="tool" density="{beam_d:.1f}" rgba="0.75 0.75 0.78 1"')}
      {_box("cal6_jaw_in", *C["jaw_in"], f' class="tool" density="{beam_d:.1f}" rgba="0.75 0.75 0.78 1"')}
      <body name="insp_cal6_slider">
        <joint name="cal6_slide" type="slide" axis="1 0 0" range="0 {C['travel'] * M:.4f}" damping="0.5"
               frictionloss="{C['friction_N']}" armature="0.001"/>
        {_box("cal6_slider", *C["slider"], f' class="tool" density="{slider_d:.1f}" rgba="0.15 0.15 0.15 1"')}
        {_box("cal6_slider_bulge", *C["slider_bulge"], f' class="tool" density="{slider_d:.1f}" rgba="0.15 0.15 0.15 1"')}
        {_box("cal6_mjaw_out", *C["mjaw_out"], f' class="tool" density="{slider_d:.1f}" rgba="0.75 0.75 0.78 1"')}
        {_box("cal6_rod", *C["rod"], f' class="tool" density="{slider_d:.1f}" rgba="0.75 0.75 0.78 1"')}
        <geom name="cal6_roller" class="tool" type="cylinder" size="{ro['r'] * M:.5f} {ro['half'] * M:.5f}"
              pos="{_f(ro['at'])}" quat="0.7071068 0.7071068 0 0" mass="0.002" friction="0.8 0.004 0.0001"
              rgba="0.3 0.3 0.3 1"/>
      </body>
    </body>
"""


def _excludes(loose: str) -> str:
    """The calipers' beam and slider don't collide: the slider rides round the beam."""
    if "insp_cal6_slider" not in loose:
        return ""
    return '  <contact>\n    <exclude body1="insp_cal6" body2="insp_cal6_slider"/>\n  </contact>\n'


def with_body(body_xml: str, loose: str, carried: tuple[str, ...] = (), skip: tuple[str, ...] = ()) -> str:
    """The body model's MJCF with the bench cell added: the station (less skip), the floor, the loose objects (XML from
    part_body, deburr_body, caliper_body) and a carry weld from the right hand to each carried body."""
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + defaults() + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + STATIC + IB.worldbody(skip=skip) + loose, 1)
    eq = "".join(f'    <weld name="carry_{b}" body1="R_hand" body2="{b}" active="false" solref="0.004 1" '
                 f'solimp="0.95 0.99 0.001" torquescale="1"/>\n' for b in carried)
    xml = xml.replace("<equality>\n", "<equality>\n" + eq, 1)
    return xml.replace("  <equality>\n", _excludes(loose) + "  <equality>\n", 1)


def standalone_xml(loose: str, skip: tuple[str, ...] = ()) -> str:
    """The cell without a body: the station and the loose objects, to let them come to rest."""
    return f"""<mujoco model="bench_cell">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
{defaults()}
  </default>
  <worldbody>
{FLOOR}{IB.worldbody(skip=skip)}{loose}  </worldbody>
{_excludes(loose)}</mujoco>
"""


def rest_mm(name: str) -> np.ndarray:
    """Where the station keeps an instrument: its rest site on its surface (mm)."""
    r = IB.record()["rests"][name]
    return np.array([*r["at_mm"], IB.tops_mm()[r["on"]]])


IDENTITY = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
ASSET = [0.0, 0.0, 0.0, 0.7071068, 0.7071068, 0.0, 0.0]   # an asset's GLB, glTF's Y up, in its Z-up asset frame
LINKS = {"part": "parts/nist-ftc-10/finished.glb",          # moonshot/library/bench_links.py writes these
         "deburr_tool": "library/hand_tools/deburr/links/tool.glb",
         "insp_cal6": "library/inspection/cal6/links/beam.glb",
         "insp_cal6_slider": "library/inspection/cal6/links/slider.glb",
         "insp_hgauge": "library/inspection/hgauge/links/height_gauge.glb"}


def render_glbs(model) -> dict[str, list[dict]]:
    """Each body's render meshes for the take record (moonshot/contracts/take_record.py): the moving bodies' links,
    each in its body's frame; the instruments' own asset GLBs, each in its asset frame; and, on the static body
    `insp_bench`, the bench (the world frame is its asset's) and the granite plate (its underside centred)."""
    names = {model.body(b).name for b in range(1, model.nbody)}
    out = {b: [{"path": p, "in_body": IDENTITY}] for b, p in LINKS.items() if b in names}
    for k in IB.record()["rests"]:
        if f"insp_{k}" in names and f"insp_{k}" not in out:
            out[f"insp_{k}"] = [{"path": f"library/inspection/{k}/{k}.glb", "in_body": ASSET}]
    if "insp_bench" in names:
        P = IB.record()["plate"]
        out["insp_bench"] = [{"path": "library/support/bench/bench.glb", "in_body": ASSET},
                             {"path": "library/inspection/hgauge/links/plate.glb",
                              "in_body": [*P["at_mm"], IB.tops_mm()["bench"], 1.0, 0.0, 0.0, 0.0]}]
    return out
