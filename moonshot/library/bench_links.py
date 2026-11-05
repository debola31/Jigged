"""Render meshes for the bench takes' moving bodies (moonshot/world/bench_cell.py), each in its body's frame, metres,
Z up, written as moonshot/library/stations/extract.py writes a station's links (the renderer draws a GLB's stored
coordinates in its body's frame):
- each finished part from its STEP, in the STEP's frame: <data root>/parts/<part>/finished.glb (nist-ftc-10's, and
  G1's as their bench takes need them)
- the swivel deburring tool out of the deburring kit's GLB (its handle and its blade, not the file, pad or mat), its
  frame on the handle's axis at the back end, with the swivel blade's hook the kit's placeholder lacks (its collider's
  two arms): library/hand_tools/deburr/links/tool.glb
- the calipers split at the slider: library/inspection/cal6/links/beam.glb (the beam, its fixed jaws and its scale)
  and slider.glb (the slider and display, the moving jaw, the thumb roller and the locking screw, and the depth rod,
  which the GrabCAD model doesn't have: the collider's box). A part of the model is the slider's if it lies at the
  jaw end and stands out of the beam's section.

    python -m moonshot.library.bench_links                 # nist-ftc-10's part, the deburring tool and the calipers
    python -m moonshot.library.bench_links ll-1007223 ...  # just these parts' finished.glb
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

from moonshot.config import data_root

Y_UP_TO_Z_UP = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])     # a glTF file's (x, y, z) -> (x, -z, y)
DEBURR_IN_KIT = np.array([-114.3, 79.4, 17.8])                        # bench_cell.DEBURR["in_kit"]
BEAM_SECTION = {"y": (1.5, 18.0), "z": (2.4, 7.0)}                     # mm, the beam's section and its scale's print
SLIDER_END_X = -28.0                                                  # the slider and all on it lie left of this
ROD = ((-40.4, 8.75, 1.4), (116.6, 10.75, 2.4))                        # bench_cell.CAL["rod"]
HOOK_AT, HOOK_R, HOOK_LEN = np.array([163.58, 0.0, 0.0]), 1.0, 3.0        # bench_cell.deburr_tip(), DEBURR's hook
HOOK = ((0.8138, 0.3827, 0.4373), (0.4698, -0.8762, -0.1076))
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NORM = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}


def read_glb(path: Path) -> list[tuple[str, np.ndarray, np.ndarray]]:
    """Each primitive of a GLB as (node name, vertices in mm with Z up, triangles), its node transforms and
    quantization applied."""
    b = path.read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    g, bin0 = json.loads(b[20:20 + n]), 20 + n + 8

    def acc(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        dt, k = np.dtype(CT[a["componentType"]]), {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        stride = bv.get("byteStride", 0) or dt.itemsize * k
        off = bin0 + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        rows = [np.frombuffer(b, dt, k, off + r * stride) for r in range(a["count"])]
        out = np.array(rows, float)
        return out / NORM[a["componentType"]] if a.get("normalized") else out

    def local(nd):
        if "matrix" in nd:
            return np.array(nd["matrix"]).reshape(4, 4).T
        x, y, z, w = nd.get("rotation", [0, 0, 0, 1])
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        T = np.eye(4)
        T[:3, :3], T[:3, 3] = R @ np.diag(nd.get("scale", [1, 1, 1])), nd.get("translation", [0, 0, 0])
        return T

    parent = {c: i for i, nd in enumerate(g["nodes"]) for c in nd.get("children", [])}
    out = []
    for i, nd in enumerate(g["nodes"]):
        if "mesh" not in nd:
            continue
        T, j = local(nd), i
        while j in parent:
            j = parent[j]
            T = local(g["nodes"][j]) @ T
        for prim in g["meshes"][nd["mesh"]]["primitives"]:
            v = acc(prim["attributes"]["POSITION"])
            v = ((T[:3, :3] @ v.T).T + T[:3, 3]) @ Y_UP_TO_Z_UP.T * 1000
            out.append((nd.get("name", ""), v, acc(prim["indices"]).astype(int).reshape(-1, 3)))
    return out


def box_mesh(lo, hi):
    import trimesh
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    return trimesh.creation.box(extents=hi - lo, transform=np.r_[np.c_[np.eye(3), (lo + hi) / 2], [[0, 0, 0, 1]]])


def write(mesh, path: Path) -> dict:
    """Export a mesh given in mm as metres; its bounds (mm) and triangle count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    m = mesh.copy()
    m.apply_scale(0.001)
    m.export(path)
    return {"path": str(path.relative_to(data_root())).replace("\\", "/"), "triangles": int(len(m.faces)),
            "min_mm": np.round(mesh.bounds[0], 1).tolist(), "max_mm": np.round(mesh.bounds[1], 1).tolist()}


def part(name: str = "nist-ftc-10") -> dict:
    import cadquery as cq
    import trimesh
    shape = cq.importers.importStep(str(data_root() / "parts" / name / "part.step")).val()
    verts, faces = shape.tessellate(0.05, 0.3)
    mesh = trimesh.Trimesh(np.array([(p.x, p.y, p.z) for p in verts]), np.array(faces), process=True)
    # drawn in what it's made of where that isn't steel (a GLB with no material is drawn as bare steel): the acetal
    # plate black, as its drawing has it
    record = json.loads((data_root() / "parts" / name / "part.json").read_text(encoding="utf-8"))
    if any(w in (record.get("material") or "").lower() for w in ("acetal", "delrin")):
        from trimesh.visual.material import PBRMaterial
        mesh.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
            name="acetal_black", baseColorFactor=[0.02, 0.02, 0.022, 1.0], metallicFactor=0.0, roughnessFactor=0.4))
    return write(mesh, data_root() / "parts" / name / "finished.glb")


def deburr_tool() -> dict:
    import trimesh
    kit = data_root() / "library" / "hand_tools" / "deburr"
    pieces = []
    for name, v, f in read_glb(kit / "deburr.glb"):
        if name == "deburr_handle":
            pieces.append(trimesh.Trimesh(v - DEBURR_IN_KIT, f))
        elif name == "deburr_blade":                         # this mesh is the file's blade and the tool's: keep the tool's
            for c in trimesh.Trimesh(v, f, process=True).split(only_watertight=False):
                if c.bounds[0][1] > 60.0:
                    pieces.append(trimesh.Trimesh(c.vertices - DEBURR_IN_KIT, c.faces))
    for u in HOOK:
        pieces.append(trimesh.creation.capsule(height=HOOK_LEN, radius=HOOK_R, count=[8, 8]))
        pieces[-1].apply_translation([0, 0, HOOK_LEN / 2])                    # its axis from the origin along +Z ...
        pieces[-1].apply_transform(trimesh.geometry.align_vectors([0, 0, 1], u))
        pieces[-1].apply_translation(HOOK_AT)                                  # ... turned onto the arm, at the tip
    return write(trimesh.util.concatenate(pieces), kit / "links" / "tool.glb")


def caliper() -> dict:
    import trimesh
    lib = data_root() / "library" / "inspection" / "cal6"
    beam, slider = [], [box_mesh(*ROD)]
    for _, v, f in read_glb(lib / "cal6.glb"):
        for c in trimesh.Trimesh(v, f, process=True).split(only_watertight=False):
            (x0, y0, z0), (x1, y1, z1) = c.bounds
            outside = (y0 < BEAM_SECTION["y"][0] or y1 > BEAM_SECTION["y"][1] or z0 < BEAM_SECTION["z"][0]
                       or z1 > BEAM_SECTION["z"][1])
            (slider if x1 <= SLIDER_END_X and outside else beam).append(c)
    return {"beam": write(trimesh.util.concatenate(beam), lib / "links" / "beam.glb"),
            "slider": write(trimesh.util.concatenate(slider), lib / "links" / "slider.glb")}


if __name__ == "__main__":
    names = sys.argv[1:]
    print(json.dumps({n: part(n) for n in names} if names else
                     {"part": part(), "deburr_tool": deburr_tool(), "caliper": caliper()}, indent=1))
