"""The band saw as a cell for a body model's takes (plan §3.2): the station (moonshot/world/bandsaw.py), the bar it
cuts, and a bench beside it for the cut pieces, set into the body model's MJCF the way moonshot/world/bench_cell.py
sets in the inspection bench.

Coordinates are the station's own (mm; floor at z = 0, the blade's plane at y = 0, the cut-off side and the work
stop at -Y), and a take places the whole cell in its world (`Place`): the body model always faces +Y and doesn't
walk, so a take at the saw's left end, where its handwheel and control box are, turns the saw a quarter turn under
it instead. Each take's world is its own; what carries over between takes (the bar, the vise, the bow) is passed in
the station's frame.

- The bar: 1 in square 4140, lying on the bed against the fixed jaw's face, along Y through the vise. Before the cut
  it is one body; the cut is the machine's own work and not modelled (the scope rule: only the person's work is
  rendered), so after it the bar is two bodies, the piece in front of the blade and the rest behind it, a kerf
  apart (KERF_MM): the blade's set teeth cut wider than the band.
- The head and the stock don't collide. The bow's collider spans its C-frame's open window, where the work passes
  (moonshot/world/bandsaw.py): lowered, its box would meet the bar 37 mm before the blade does. The head is driven by
  the feed cylinder, and the blade's way through the bar is the cut, the machine's work.
- The bench: a steel-topped bench to the right of the work stop for the cut pieces (layout furniture, as the shop's
  benches are; the station has none), at the shop benches' height.

A body the hand carries is held by the declared shortcut `carry_<body>`, a stiff weld to the hand, as at the
inspection bench (moonshot/world/bench_cell.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.world import bandsaw as BS

M = 0.001
FLOOR = '    <geom name="floor" type="plane" size="4 4 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'
STOCK_BODIES = ("bar", "piece", "rest")

# --- the bar (mm) ---------------------------------------------------------------------------------------------------
STOCK = {"w": 25.4, "h": 25.4, "density": 7850.0, "friction": 0.2,
         "material": "4140 alloy steel, 1 in square bar",
         # steel on the oiled bed, about 0.2 (the card's own figure for sliding a bar); stiff, as the saw's joints are
         # (bandsaw.SAW_DEFAULT), so a bar held to the work stop sits at its face, not a millimetre into it
         "solref": (0.002, 1.0), "solimp": (0.95, 0.99, 0.001), "rgba": (0.42, 0.42, 0.45, 1.0)}
KERF_MM = 1.4               # proposed: a 0.035 in band's set teeth cut about 0.055 in wide
REST_MM = 300.0             # the bar left behind the blade after the cut
OUT_MM = 250.0              # before the take the bar is pushed through from the infeed until it shows this far
                            # past the blade, 52 mm short of the stop (proposed): the hand pressing on it lies along it,
                            # its fingers short of the blade and its heel short of the stop when the bar meets it
SEAT_GAP_MM = 0.05          # the bar lies this far off the fixed jaw's face, not touching it before anything does

# --- the bench for the cut pieces (mm, the station's frame) ---------------------------------------------------------
BENCH = {"lo": (160.0, -1050.0), "hi": (860.0, -300.0), "height": 863.6, "top": 25.0, "friction": 0.4,
         "legs_hi_y": -480.0,     # its back legs stand in front of the saw's base (front at y = -450), its top over it
         "rgba": (0.35, 0.36, 0.38, 1.0)}


def _f(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.6f}" for x in v)


def _quat(R: np.ndarray) -> np.ndarray:
    x, y, z, w = Rotation.from_matrix(R).as_quat()
    return np.array([w, x, y, z])


def site_mm(name: str) -> np.ndarray:
    """A record site or affordance, at joint zero (the station's mm)."""
    r = BS.record()
    return np.array({**r["sites"], **r["affordances"]}[name]["at_mm"], float)


def stop_face_y() -> float:
    """Where the work stop's face is, along the bar (the record's collider)."""
    return float(BS.record()["colliders"]["work_stop"]["box_max_mm"][1])


def fixed_face_x() -> float:
    return float(site_mm("fixed_jaw_face")[0])


def bed_z() -> float:
    return float(site_mm("bed")[2])


def piece_mm() -> float:
    """The length the work stop cuts to: from its face to the near side of the kerf."""
    return -KERF_MM / 2 - stop_face_y()


def bar_mm() -> float:
    return piece_mm() + KERF_MM + REST_MM


def bar_x() -> tuple[float, float]:
    x1 = fixed_face_x() - SEAT_GAP_MM
    return x1 - STOCK["w"], x1


def stock_kg(length_mm: float) -> float:
    return STOCK["w"] * STOCK["h"] * length_mm * 1e-9 * STOCK["density"]


def bench_top_mm() -> float:
    return BENCH["height"]


@dataclass(frozen=True)
class Place:
    """Where a take puts the saw in its world: the station's frame turned yaw_deg about Z, its origin at at_mm."""
    at_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    yaw_deg: float = 0.0

    @property
    def R(self) -> np.ndarray:
        c, s = math.cos(math.radians(self.yaw_deg)), math.sin(math.radians(self.yaw_deg))
        return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])

    def world(self, p) -> np.ndarray:
        """A station point (mm), or points (n, 3), in the take's world."""
        return np.asarray(self.at_mm, float) + np.asarray(p, float) @ self.R.T

    def vec(self, v) -> np.ndarray:
        return np.asarray(v, float) @ self.R.T

    def station(self, p) -> np.ndarray:
        """A world point (mm) in the station's frame."""
        return (np.asarray(p, float) - np.asarray(self.at_mm, float)) @ self.R

    def quat(self) -> np.ndarray:
        h = math.radians(self.yaw_deg) / 2
        return np.array([math.cos(h), 0.0, 0.0, math.sin(h)])


FRONT = Place()                     # the person at the front, by the work stop: the saw as it stands
END = Place(yaw_deg=90.0)           # at the left end, by the handwheel and the control box: the station's +X is the
                                    # world's +Y, the way the body faces


def defaults() -> str:
    c = STOCK
    return BS.SAW_DEFAULT + f"""
    <default class="stock">
      <geom contype="1" conaffinity="3" priority="1" friction="{c['friction']} 0.004 0.0001" solref="{_f(c['solref'], 1)}"
            solimp="{_f(c['solimp'], 1)}" rgba="{_f(c['rgba'], 1)}"/>
    </default>
    <default class="bench">
      <geom contype="1" conaffinity="3" priority="1" friction="{BENCH['friction']} 0.004 0.0001" solref="0.002 1"
            solimp="0.95 0.99 0.001" rgba="{_f(BENCH['rgba'], 1)}"/>
    </default>"""


def stock_body(name: str, place: Place, centre, R=None, length: float | None = None) -> str:
    """A length of the bar, its centre at centre and turned R (the station's mm and frame); its frame is its centre
    with its axes, its length along its y."""
    half = np.array([STOCK["w"], length, STOCK["h"]]) / 2
    q = _quat(place.R @ (np.eye(3) if R is None else np.asarray(R, float)))
    return (f'    <body name="{name}" pos="{_f(place.world(centre))}" quat="{_f(q, 1)}">\n'
            f'      <freejoint name="{name}"/>\n'
            f'      <geom name="{name}" class="stock" type="box" size="{_f(half)}" density="{STOCK["density"]}"/>\n'
            f'    </body>\n')


def bar_at(end_y: float) -> np.ndarray:
    """The whole bar's centre with its end at end_y, lying on the bed against the fixed jaw (station mm)."""
    x0, x1 = bar_x()
    return np.array([(x0 + x1) / 2, end_y + bar_mm() / 2, bed_z() + STOCK["h"] / 2])


def bar_body(place: Place, centre=None, R=None) -> str:
    """The whole bar: where it lies before the take (pushed through OUT_MM past the blade) or at centre, R."""
    return stock_body("bar", place, bar_at(-OUT_MM) if centre is None else centre, R, bar_mm())


def cut_bodies(place: Place, bar_centre, bar_R) -> str:
    """The bar as the cut leaves it, where it lay clamped (its centre and rotation, the station's frame): the piece
    from its end to the kerf and the rest beyond it. The kerf is where the blade's plane crosses the bar's axis."""
    c, R = np.asarray(bar_centre, float), np.asarray(bar_R, float)
    axis = R[:, 1]
    s_kerf = -c[1] / axis[1]                         # along the bar's axis from its centre to the blade's plane
    end, far = -bar_mm() / 2, bar_mm() / 2
    out = ""
    for name, a, b in (("piece", end, s_kerf - KERF_MM / 2), ("rest", s_kerf + KERF_MM / 2, far)):
        out += stock_body(name, place, c + axis * (a + b) / 2, R, b - a)
    return out


def bench_body(place: Place) -> str:
    """The bench: a static body, so the take record carries it. Its frame: on the floor under its top's middle."""
    lo, hi = np.array(BENCH["lo"], float), np.array(BENCH["hi"], float)
    c, half = (lo + hi) / 2, (hi - lo) / 2
    H, T = BENCH["height"], BENCH["top"]
    ys = (lo[1] + 40 - c[1], BENCH["legs_hi_y"] - c[1])
    legs = "".join(
        f'\n      <geom name="saw_bench_leg{i}" class="bench" type="box" size="{_f([20, 20, (H - T) / 2])}" '
        f'pos="{_f([sx * (half[0] - 40), ys[j], (H - T) / 2])}"/>'
        for i, (sx, j) in enumerate(((-1, 0), (1, 0), (-1, 1), (1, 1))))
    return (f'    <body name="saw_bench" pos="{_f(place.world([c[0], c[1], 0.0]))}" quat="{_f(place.quat(), 1)}">\n'
            f'      <geom name="saw_bench_top" class="bench" type="box" size="{_f([half[0], half[1], T / 2])}" '
            f'pos="{_f([0.0, 0.0, H - T / 2])}"/>{legs}\n'
            f'    </body>\n')


def _saw(place: Place) -> tuple[str, str, str]:
    body, acts, eq = BS.worldbody()
    body = (f'    <body name="saw" pos="{_f(place.at_mm)}" quat="{_f(place.quat(), 1)}">\n{body}    </body>\n')
    return body, acts, eq


def _contacts(loose: str) -> str:
    """The head never meets the stock (above)."""
    rows = [f'    <exclude body1="saw_head" body2="{b}"/>' for b in STOCK_BODIES if f'name="{b}"' in loose]
    return "  <contact>\n" + "\n".join(rows) + "\n  </contact>\n" if rows else ""


def with_body(body_xml: str, place: Place, loose: str, carried: tuple = ()) -> str:
    """The body model's MJCF with the saw cell added: the saw's and the stock's classes, the floor, the saw where place
    puts it, the bench, the loose stock (stock_body, bar_body, cut_bodies), a carry weld to each carried body from
    the hand that carries it (a body, the right hand's, or a (side, body) pair), the saw's vise screw, and its
    actuators after the body's, so the body's keep their ids."""
    saw, acts, eq = _saw(place)
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + defaults() + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + saw + bench_body(place) + loose, 1)
    pairs = [c if isinstance(c, tuple) else ("R", c) for c in carried]
    welds = "".join(f'    <weld name="carry_{b}" body1="{side}_hand" body2="{b}" active="false" solref="0.004 1" '
                    f'solimp="0.95 0.99 0.001" torquescale="1"/>\n' for side, b in pairs)
    xml = xml.replace("<equality>\n", "<equality>\n" + welds + eq, 1)
    xml = xml.replace("  <equality>\n", _contacts(loose) + "  <equality>\n", 1)
    head, _, tail = xml.rpartition("  </actuator>")
    return head + acts + "  </actuator>" + tail


def standalone_xml(place: Place, loose: str) -> str:
    """The cell without a body: the saw, the bench and the stock, to let the stock come to rest, and for the cut."""
    saw, acts, eq = _saw(place)
    # the body model's solver settings (moonshot/body/skeleton.py), so the cut holds the bar as the takes do: on
    # MuJoCo's defaults the clamped rest crept 0.1 mm along the bed over a 3 minute cut
    return f"""<mujoco model="saw_cell">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" solver="Newton" cone="elliptic" impratio="10" tolerance="1e-10"
          iterations="60" ls_iterations="20" noslip_iterations="10" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
{defaults()}
  </default>
  <worldbody>
{FLOOR}{saw}{bench_body(place)}{loose}  </worldbody>
{_contacts(loose)}  <equality>
{eq}  </equality>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


# --- the saw's state, carried from take to take, in the station's frame -----------------------------------------------
SAW_JOINTS = ("head", "jaw", "handwheel", "feed_valve", "cover_idler", "cover_drive")


def saw_state(model: mujoco.MjModel, data: mujoco.MjData, ctl: BS.Control, place: Place) -> dict:
    """What the next take starts from: the saw's joints and its vise screw's engagement and offset, the control's
    state and feed, and each stock body's pose (centre mm, rotation, the station's frame)."""
    m, d = model, data
    out = {"q": {j: float(d.qpos[m.jnt_qposadr[m.joint(f"saw_{j}").id]]) for j in SAW_JOINTS},
           "screw": {"active": int(d.eq_active[ctl.screw]), "offset": float(m.eq_data[ctl.screw][0])},
           "control": {"state": ctl.state, "feed_mm_s": ctl.feed_mm_s, "speed_sfpm": ctl.speed_sfpm},
           "blade_rad_s": float(d.qvel[m.jnt_dofadr[m.joint("saw_blade").id]]), "stock": {}}
    for b in STOCK_BODIES:
        try:
            i = m.body(b).id
        except KeyError:
            continue
        g = next(g for g in range(m.ngeom) if m.geom_bodyid[g] == i)
        out["stock"][b] = {"centre": place.station(d.xpos[i] * 1000).tolist(),
                           "R": (place.R.T @ d.xmat[i].reshape(3, 3)).tolist(),
                           "length": round(float(m.geom_size[g][1]) * 2000, 4)}
    return out


def set_saw(model: mujoco.MjModel, data: mujoco.MjData, ctl: BS.Control, state: dict) -> None:
    """Put the saw as state has it (saw_state's), before the take's first step."""
    m, d = model, data
    for j, v in state["q"].items():
        d.qpos[m.jnt_qposadr[m.joint(f"saw_{j}").id]] = v
    m.eq_data[ctl.screw][0] = state["screw"]["offset"]
    d.eq_active[ctl.screw] = state["screw"]["active"]
    d.qvel[m.jnt_dofadr[m.joint("saw_blade").id]] = state.get("blade_rad_s", 0.0)
    c = state["control"]
    ctl.state, ctl.feed_mm_s, ctl.speed_sfpm = c["state"], c["feed_mm_s"], c["speed_sfpm"]


def render_links() -> dict[str, tuple[str, str]]:
    """Each link's GLB (moonshot/library/stations/extract.py) and the body that carries it. The band is drawn on the
    head: its loop runs round both wheels, so it can't turn with the drive wheel's body."""
    body = {"base": "saw_base", "head": "saw_head", "blade": "saw_head", "jaw": "saw_jaw", "handwheel": "saw_handwheel",
            "cover_idler": "saw_cover_idler", "cover_drive": "saw_cover_drive"}
    return {k: (b, f"library/machines/bandsaw/links/{k}.glb") for k, b in body.items()}
