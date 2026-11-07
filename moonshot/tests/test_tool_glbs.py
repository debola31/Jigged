"""A take draws each CAT40 holder and its cutter standing along the holder body's axis, where its colliders are: the
library's tool GLBs are stored Y up, so their placement turns them up (moonshot/world/tooling.py Y_UP), and a take
drawn before the fix is drawn again so without running it (moonshot/sim/tool_redraw.py)."""
import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.sim.tool_redraw import redraw
from moonshot.world import tooling as TL


def placed_extent(vertices: np.ndarray, in_body) -> np.ndarray:
    """A GLB's vertices placed by an in_body ([x, y, z, qw, qx, qy, qz]): its box's size along the body's x, y, z."""
    w, qx, qy, qz = in_body[3:]
    p = vertices @ Rotation.from_quat([qx, qy, qz, w]).as_matrix().T
    return p.max(0) - p.min(0)


def library_vertices(path: str) -> np.ndarray:
    import trimesh
    f = data_root() / path
    if not f.is_file():
        pytest.skip(f"no {path} in the data root")
    return trimesh.load(f, force="mesh").vertices


def test_a_holder_bodys_colliders_run_along_its_z():
    """The axis the GLBs are stood along: every holder collider is a z-aligned solid of revolution on the body's axis."""
    import mujoco
    m = mujoco.MjModel.from_xml_string('<mujoco><default><default class="steel"/></default><worldbody><body>'
                                       f"{TL.holder_geoms('h', 'em12')}</body></worldbody></mujoco>")
    for g in range(m.ngeom):
        assert np.allclose(m.geom_quat[g], [1, 0, 0, 0]) and np.allclose(m.geom_pos[g][:2], 0.0)


@pytest.mark.data_root
@pytest.mark.parametrize("tool", ["em12", "spot", "chamf", "drill-5p5", "drill-6p5", "ream-8", "tap-m4"])
def test_a_placed_holders_glbs_lie_along_its_colliders_axis(tool):
    """The holder and the cutter each placed longest along the body's z (unturned, the holder's 112.7 mm and the
    cutter's length ran along y, across the colliders)."""
    for entry in TL.render_glbs(tool):
        ext = placed_extent(library_vertices(entry["path"]), entry["in_body"])
        assert ext[2] > ext[0] and ext[2] > ext[1], (entry["path"], ext)


def test_a_takes_own_stand_in_cutter_is_built_along_z_and_placed_unturned():
    """moonshot/sim/cycle_take.py write_cutter_glb builds a cutter without a 3D model along z: it is placed as it is."""
    import trimesh
    body = trimesh.creation.cylinder(radius=0.004, height=0.06, sections=24)
    body.apply_translation([0, 0, 0.03])
    entry = TL.glb_entry("takes/nist-ftc-10-op10-face/cutter_em12.glb", -93.98)
    assert entry["in_body"][3:] == [1.0, 0.0, 0.0, 0.0]
    ext = placed_extent(body.vertices, entry["in_body"])
    assert ext[2] > ext[0] and ext[2] > ext[1]


def test_a_take_drawn_before_the_fix_is_drawn_again_its_record_noting_it(tmp_path):
    """Only the tool entries' in_body change, each keeping its place along the axis; take.json notes the redraw; a
    second redraw finds nothing to change."""
    old = [{"path": TL.HOLDER_GLB, "in_body": [0, 0, -44.45, 1, 0, 0, 0]},
           {"path": "library/tooling/em12/em12.glb", "in_body": [0, 0, -93.98, 1, 0, 0, 0]}]
    other = [{"path": "library/workholding/d688/links/base.glb", "in_body": [0, 0, 0, 1, 0, 0, 0]}]
    scene = {"bodies": {"holder": {"glbs": old}, "pocket_1": {"glbs": [dict(e) for e in old]},
                        "vf2_table": {"glbs": other}}}
    (tmp_path / "scene.json").write_text(json.dumps(scene), encoding="utf-8")
    (tmp_path / "take.json").write_text(json.dumps({"kind": "seat"}), encoding="utf-8")
    assert redraw(tmp_path) == ["holder", "pocket_1"]
    after = json.loads((tmp_path / "scene.json").read_text(encoding="utf-8"))["bodies"]
    assert after["holder"]["glbs"] == TL.render_glbs("em12")
    assert after["pocket_1"]["glbs"] == TL.render_glbs("em12")
    assert after["vf2_table"]["glbs"] == other
    tk = json.loads((tmp_path / "take.json").read_text(encoding="utf-8"))
    assert tk["kind"] == "seat" and tk["redrawn"][0]["what"] == "tool GLBs"
    assert redraw(tmp_path) == []
    assert len(json.loads((tmp_path / "take.json").read_text(encoding="utf-8"))["redrawn"]) == 1
