"""The inspection bench as a MuJoCo station (plan §3.2, track C6): built from
moonshot/library/stations/inspection_bench.json.

The bench top and the granite plate are static; each instrument is a free body that rests where it is only by
contact. The two surfaces take priority in every contact with them, with stiff contact, so a part on the plate sits at
its true height to well under the height gauge's resolution, and their friction holds what rests on them. An
instrument's colliders are boxes in its own asset frame, underside at z = 0, and its body stands at its rest with that
frame, so the render draws its GLB at the body's pose. Each rest is also a site, for a take to put the instrument
back.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "inspection_bench.json"
M = 0.001
IN = 25.4


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def _xyz(v, scale=M) -> str:
    return " ".join(f"{x * scale:.6f}" for x in v)


def _box(name: str, lo, hi, extra: str = "") -> str:
    lo, hi = np.array(lo, float), np.array(hi, float)
    return f'<geom name="{name}" type="box" size="{_xyz((hi - lo) / 2)}" pos="{_xyz((lo + hi) / 2)}"{extra}/>'


def tops_mm() -> dict[str, float]:
    """The height of each surface an instrument can rest on."""
    r = record()
    bench = r["bench"]["top_mm"]["box_max_mm"][2]
    return {"bench": bench, "plate": bench + r["plate"]["size_in"][2] * IN}


def defaults() -> str:
    """The station's geom classes, for any scene that holds it."""
    c = record()["contact"]
    return f"""    <default class="surface">
      <geom contype="1" conaffinity="3" priority="2" solref="{_xyz(c['solref'], 1)}" solimp="{_xyz(c['solimp'], 1)}"
            rgba="0.55 0.4 0.25 1"/>
    </default>
    <default class="instrument">
      <geom contype="1" conaffinity="3" priority="1" friction="0.25 0.004 0.0001" rgba="0.7 0.7 0.72 1"/>
    </default>"""


def worldbody(instruments: bool = True, skip: tuple[str, ...] = ()) -> str:
    """The bench, the plate, a site at each instrument's rest and, unless left out, the instruments resting there;
    skip leaves out those a take brings its own model of (the calipers, with their slider)."""
    r = record()
    B, P = r["bench"], r["plate"]
    tops = tops_mm()
    (px, py), (lx, wy, hz) = P["at_mm"], (v * IN for v in P["size_in"])
    xml = (f'    {_box("insp_bench_top", B["top_mm"]["box_min_mm"], B["top_mm"]["box_max_mm"], f' class="surface" friction="{B["friction"]} 0.004 0.0001"')}\n'
           f'    {_box("insp_plate", [px - lx / 2, py - wy / 2, tops["bench"]], [px + lx / 2, py + wy / 2, tops["plate"]], f' class="surface" friction="{P["friction"]} 0.004 0.0001" rgba="0.12 0.12 0.13 1"')}\n')
    for k, rest in r["rests"].items():
        x, y = rest["at_mm"]
        at = [x, y, tops[rest["on"]]]
        xml += f'    <site name="insp_rest_{k}" pos="{_xyz(at)}" size="0.005"/>\n'
        if not instruments or k in skip:
            continue
        boxes = [(np.array(lo), np.array(hi)) for lo, hi in rest["boxes_mm"]]
        density = rest["mass_kg"] / sum(np.prod(hi - lo) for lo, hi in boxes) / 1e-9       # kg/m^3, by volume
        geoms = "".join(f'\n      {_box(f"insp_{k}_{i}", lo, hi, f" class=\"instrument\" density=\"{density:.1f}\"")}'
                        for i, (lo, hi) in enumerate(boxes))
        xml += (f'    <body name="insp_{k}" pos="{_xyz(at)}" euler="0 0 {math.radians(rest["yaw_deg"]):.6f}">\n'
                f'      <freejoint name="insp_{k}"/>{geoms}\n    </body>\n')
    return xml


def standalone_xml(loose: str = "", instruments: bool = True) -> str:
    """The station alone, for its conformance tests; loose is XML for more free bodies (a part to set down)."""
    return f"""<mujoco model="inspection_bench">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
{defaults()}
  </default>
  <worldbody>
{worldbody(instruments)}{loose}  </worldbody>
</mujoco>
"""
