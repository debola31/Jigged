"""The renderer draws any take record (moonshot/contracts/take_record.py) as the take says, at 1080p and 24 fps:
the skin bake (moonshot/render/bake.py) and the Blender scene (moonshot/render/render_take.py), on a small take made
here.

The take, 7 frames at 30 fps, so the render resamples it: a body carrying a GLB slides along x; a body with geoms
only turns about z; the stock swaps its mesh at frame 4; a plate rises into the right hand from frame 3; both arms
work, the left given as the right in the mirrored world, so it draws as the right's reflection; and a person's body
is never drawn as an object.

`render_take.py --inspect` writes what Blender would draw at each frame instead of rendering it: the render
settings, the camera, and each drawn mesh's world bounds (mm) with the body it belongs to:
    {"render": {"engine", "res": [w, h], "fps", "frames": [first, last]},
     "frames": {"<k>": {"camera": {"eye", "forward", "up"},
                        "drawn": [{"body", "kind": "glb" | "geom" | "mesh" | "hand" | "sleeve", "min", "max"}]}}}
Hands and sleeves are drawn as bodies "hand_<arm>" and "sleeve_<arm>".

Needs the data root (NIMBLE's hand) and, for the scene, Blender. Protected (plan §6, rule 1)."""
import json
import os
import struct
import subprocess
from pathlib import Path

import mujoco
import numpy as np
import pytest

import moonshot
from moonshot.config import data_root

pytestmark = pytest.mark.data_root
NIMBLE = data_root() / "hand-model" / "nimble"
BLENDER = next((p for p in (os.environ.get("MOONSHOT_BLENDER"), r"C:\blender\blender-5.2.3-windows-x64\blender.exe",
                            "/Applications/Blender.app/Contents/MacOS/Blender") if p and Path(p).exists()), None)
SCRIPT = Path(moonshot.__file__).parent / "render" / "render_take.py"

SRC_FPS, N_SRC, N_OUT = 30, 7, 5            # 0.2 s: output frames at 0, 1/24 ... 4/24 s
MIRROR_X = 0.0
W = np.array([150.0, -100.0, 1000.0])
H = np.array([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]])      # palm down, fingers +y, thumb toward -x
E = W + [0.0, -260, -20]
S = E + [0.0, -40, 290]
PLATE_HALF = np.array([100.0, 160.0, 20.0])
PLATE_UP = np.array([150.0, -30.0, 1000.0 - 8 - 20])     # its top 8 mm under the wrist joint
SLIDER_GLB = np.array([100.0, 60.0, 20.0])               # mm, a box centred on its own origin
SLIDER_IN_BODY = [0.0, 0.0, 30.0, np.cos(np.pi / 4), 0.0, 0.0, np.sin(np.pi / 4)]   # turned 90° about z
BLOCK_HALF = np.array([20.0, 30.0, 40.0])
STOCK = {0: np.array([40.0, 40.0, 40.0]), 4: np.array([30.0, 20.0, 10.0])}

XML = f"""<mujoco><worldbody>
  <body name="slider" pos="0 0.3 0.6"><joint name="slide" type="slide" axis="1 0 0"/>
    <geom name="slider" type="box" size="0.05 0.03 0.01"/></body>
  <body name="block" pos="0.3 0.3 0.6"><joint name="turn" type="hinge" axis="0 0 1"/>
    <geom name="block" type="box" size="{' '.join(str(v / 1000) for v in BLOCK_HALF)}" rgba="0.8 0.2 0.2 1"/></body>
  <body name="stock" pos="-0.3 0.3 0.6"><geom name="stock" type="box" size="0.02 0.02 0.02"/></body>
  <body name="plate" pos="{' '.join(str(v / 1000) for v in PLATE_UP - [0, 0, 500])}">
    <joint name="lift" type="slide" axis="0 0 1"/>
    <geom name="plate" type="box" size="{' '.join(str(v / 1000) for v in PLATE_HALF)}"/></body>
  <body name="R_hand" pos="0.15 -0.1 1"><geom name="R_hand" type="sphere" size="0.01"/></body>
</worldbody></mujoco>"""


def _glb(path: Path, extents_mm) -> None:
    import trimesh
    path.parent.mkdir(parents=True, exist_ok=True)
    trimesh.creation.box(extents=np.asarray(extents_mm) / 1000).export(path)     # raw coordinates, as extract.py


def eye(k):
    return np.array([0.0, -700 + 10 * k, 1500])


LOOK, UP = np.array([0.0, 0, 1000]), np.array([0.0, 0, 1])


def read_pc2(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    _, v, _, _, n = struct.unpack("<iiffi", raw[12:32])
    return np.frombuffer(raw[32:], "<f4").reshape(n, v, 3) * 1000.0


def outward(v, f) -> float:
    """Mean of each vertex normal along the vertex's offset from the centroid: positive when faces point out."""
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for c in range(f.shape[1]):
        np.add.at(n, f[:, c], fn)
    used = np.unique(f)
    n = n[used] / np.maximum(np.linalg.norm(n[used], axis=1, keepdims=True), 1e-12)
    return float(np.mean(np.sum(n * (v[used] - v[used].mean(0)), axis=1)))


def reflect(p):
    p = np.array(p, float)
    p[..., 0] = 2 * MIRROR_X - p[..., 0]
    return p


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    if not NIMBLE.exists():
        pytest.skip(f"no NIMBLE model at {NIMBLE}")
    from moonshot.body.hand import AnatomicalHand
    from moonshot.body.nimble import Nimble
    from moonshot.contracts.take_record import check
    from moonshot.render.bake import bake
    from moonshot.sim.record import Recorder

    root = tmp_path_factory.mktemp("render")
    take, data, out = root / "take", root / "data", root / "bake"
    take.mkdir()
    hand_model = AnatomicalHand(Nimble(NIMBLE))
    names = list(hand_model.names)
    q = hand_model.vector(hand_model.neutral())
    m = mujoco.MjModel.from_xml_string(XML)
    d = mujoco.MjData(m)
    rec = Recorder(m, {"R_hand"}, ("R", "L"))
    hand = {"q": q, "W": W, "S": S, "E": E, "H": H, "forearm": H}
    for k in range(N_SRC):
        d.qpos[:] = [0.1 * k, np.radians(15 * k), 0.5 if k >= 3 else 0.0]
        mujoco.mj_kinematics(m, d)
        rec.frame(d, {"R": hand, "L": hand}, eye(k), LOOK, UP)
    rec.write(take, SRC_FPS, MIRROR_X, {"R": names, "L": names}, "test",
              {"slider": [{"path": "test/slider.glb", "in_body": SLIDER_IN_BODY}]})
    scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
    scene["bodies"]["stock"]["meshes"] = {"dir": "stock", "frames": sorted(STOCK)}
    (take / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
    _glb(data / "test" / "slider.glb", SLIDER_GLB)
    for k, size in STOCK.items():
        _glb(take / "stock" / f"{k}.glb", size)
    assert check(take) == []
    bake(take, out, fps=24, workers=1)
    return {"take": take, "data": data, "bake": out, "b": np.load(out / "bake.npz")}


# --- the bake -----------------------------------------------------------------------------------------------------

def test_the_take_is_resampled_to_24_fps(made):
    b = made["b"]
    assert int(b["fps"]) == 24 and int(b["n"]) == N_OUT
    assert np.allclose(b["t"], np.arange(N_OUT) / 24)


def test_bodies_and_camera_follow_the_take_between_its_frames(made):
    b = made["b"]
    bodies = [str(x) for x in b["bodies"]]
    i = np.arange(N_OUT)
    k = i * SRC_FPS / 24                                                     # the take's frame, fractional
    assert np.allclose(b["pos"][:, bodies.index("slider")], np.stack([100 * k, 300 + 0 * k, 600 + 0 * k], 1), atol=1e-3)
    turn = np.radians(15 * k) / 2
    want = np.stack([np.cos(turn), 0 * k, 0 * k, np.sin(turn)], 1)
    got = b["quat"][:, bodies.index("block")]
    assert np.allclose(np.abs(np.sum(got * want, 1)), 1, atol=1e-4)
    assert np.allclose(b["eye"], np.array([eye(x) for x in k]), atol=1e-3)


def test_both_hands_and_sleeves_are_baked_for_every_frame(made):
    for name in ("hand_R", "hand_L", "sleeve_R", "sleeve_L"):
        assert read_pc2(made["bake"] / f"{name}.pc2").shape[0] == N_OUT, name


def test_the_left_arm_is_the_right_reflected_with_its_faces_flipped(made):
    b = made["b"]
    for part in ("hand", "sleeve"):
        r, left = (read_pc2(made["bake"] / f"{part}_{s}.pc2")[0] for s in ("R", "L"))
        assert np.allclose(left, reflect(r), atol=0.01), f"the left {part} is not the right's reflection"
        assert outward(r, b[f"{part}_faces_R"]) > 0 and outward(left, b[f"{part}_faces_L"]) > 0, \
            f"a {part}'s faces point inward"


def test_skin_is_pressed_out_of_object_geoms(made):
    b = made["b"]
    skin = read_pc2(made["bake"] / "hand_R.pc2")
    used = np.unique(b["hand_faces_R"])
    assert float(b["depth_R"][0]) == 0.0
    for i in (3, 4):
        assert float(b["depth_R"][i]) > 1.0, "the plate reached into the hand and the bake saw nothing"
        p = skin[i][used] - PLATE_UP
        inside = np.min(PLATE_HALF - np.abs(p), axis=1)
        assert inside.max() < 0.05, f"frame {i}: skin {inside.max():.2f} mm inside the plate"


# --- the scene ----------------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def drawn(made, tmp_path_factory):
    if BLENDER is None:
        pytest.skip("no Blender")
    report = tmp_path_factory.mktemp("inspect") / "report.json"
    r = subprocess.run([BLENDER, "-b", "--factory-startup", "--python", str(SCRIPT), "--", "--take", str(made["take"]),
                        "--bake", str(made["bake"]), "--data", str(made["data"]), "--look", str(data_root() / "cc0"),
                        "--frames", f"0:{N_OUT}", "--inspect", str(report)], capture_output=True, text=True, timeout=600)
    assert r.returncode == 0 and report.exists(), (r.stderr or r.stdout)[-3000:]
    return json.loads(report.read_text(encoding="utf-8"))


def bounds(frame: dict, body: str, kind: str | None = None):
    items = [x for x in frame["drawn"] if x["body"] == body and (kind is None or x["kind"] == kind)]
    if not items:
        return None
    return np.min([x["min"] for x in items], 0), np.max([x["max"] for x in items], 0)


def test_it_renders_at_1080p_and_24_fps(drawn):
    r = drawn["render"]
    assert r["engine"] == "CYCLES" and r["res"] == [1920, 1080] and r["fps"] == 24
    assert r["frames"] == [0, N_OUT - 1]


def test_a_body_with_glbs_draws_them_where_the_body_is(drawn, made):
    pos = made["b"]["pos"][:, [str(x) for x in made["b"]["bodies"]].index("slider")]
    for i in range(N_OUT):
        lo, hi = bounds(drawn["frames"][str(i)], "slider", "glb")
        assert np.allclose(hi - lo, SLIDER_GLB[[1, 0, 2]], atol=0.5), "the GLB isn't in its raw frame, turned by in_body"
        assert np.allclose((lo + hi) / 2, pos[i] + [0, 0, 30], atol=0.5)
        assert bounds(drawn["frames"][str(i)], "slider", "geom") is None, "a body with GLBs draws its geoms too"


def test_a_body_without_glbs_draws_its_geoms(drawn):
    for i in range(N_OUT):
        th = np.radians(15 * i * SRC_FPS / 24)
        c, s = abs(np.cos(th)), abs(np.sin(th))
        half = np.array([c * BLOCK_HALF[0] + s * BLOCK_HALF[1], s * BLOCK_HALF[0] + c * BLOCK_HALF[1], BLOCK_HALF[2]])
        lo, hi = bounds(drawn["frames"][str(i)], "block", "geom")
        assert np.allclose(lo, [300, 300, 600] - half, atol=0.5) and np.allclose(hi, [300, 300, 600] + half, atol=0.5)


def test_a_changing_body_draws_its_latest_mesh(drawn):
    for i in range(N_OUT):
        f = drawn["frames"][str(i)]
        assert {x["kind"] for x in f["drawn"] if x["body"] == "stock"} == {"mesh"}, "its own geoms drawn as well"
        lo, hi = bounds(f, "stock")
        want = STOCK[4] if i * SRC_FPS / 24 >= 4 else STOCK[0]
        assert np.allclose(hi - lo, want, atol=0.5) and np.allclose((lo + hi) / 2, [-300, 300, 600], atol=0.5)


def test_the_person_is_drawn_only_as_skin(drawn):
    for i in range(N_OUT):
        f = drawn["frames"][str(i)]
        assert bounds(f, "R_hand") is None
        assert all(bounds(f, f"{p}_{s}", p) is not None for p in ("hand", "sleeve") for s in ("R", "L"))


def test_the_hands_are_drawn_from_the_bake_at_each_frame(drawn, made):
    skin = read_pc2(made["bake"] / "hand_R.pc2")
    used = np.unique(made["b"]["hand_faces_R"])
    for i in range(N_OUT):
        lo, hi = bounds(drawn["frames"][str(i)], "hand_R", "hand")
        assert np.allclose(lo, skin[i][used].min(0), atol=1.0) and np.allclose(hi, skin[i][used].max(0), atol=1.0)
    lo_r, hi_r = bounds(drawn["frames"]["0"], "hand_R")
    lo_l, hi_l = bounds(drawn["frames"]["0"], "hand_L")
    assert np.allclose([lo_l[0], hi_l[0]], [2 * MIRROR_X - hi_r[0], 2 * MIRROR_X - lo_r[0]], atol=0.5)
    assert np.allclose(lo_l[1:], lo_r[1:], atol=0.5) and np.allclose(hi_l[1:], hi_r[1:], atol=0.5)


def test_the_camera_is_the_operators_eyes(drawn):
    for i in range(N_OUT):
        cam = drawn["frames"][str(i)]["camera"]
        e = eye(i * SRC_FPS / 24)
        assert np.allclose(cam["eye"], e, atol=0.01)
        assert np.allclose(cam["forward"], (LOOK - e) / np.linalg.norm(LOOK - e), atol=1e-4)
