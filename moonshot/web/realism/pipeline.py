"""One asset through the realism pipeline, step by step, each step's inputs in a job file under <work>/<asset>/:

    simplify  node    the sources to the class's triangle cap (meshoptimizer, error-bounded); heroes stay whole
    prepare   Blender materials from the mapping, hand fixes, UV0 tiles, UV1 atlas            (CPU)
    bake      Blender AO into UV1                                       (GPU: one job at a time across workers, locks.py)
    export    Blender raw GLB, material stubs
    pack      node    library materials, shared tiles by URI, AO as KTX2, one draw per material, meshopt
    validate  node    the Khronos validator; then budgets.py's checks -> <work>/<asset>/report.json

Timings land in <work>/<asset>/timings.json, so the rollout can be costed per asset.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np

from moonshot.config import blender, data_root
from moonshot.web.export import asset_record
from moonshot.web.realism import budgets, locks, matlib
from moonshot.web.realism.paths import HERE, ktx, models_dir, node_dir, tiles_dir, work_dir, work_root

MAPPINGS = HERE / "mappings"
BLENDER_DIR = HERE / "blender"
PACK_DIR = HERE / "pack"
SIMPLIFY_ERROR = {"hero": 0.0005, "large": 0.001, "small": 0.002}   # a fraction of the mesh's radius
# Validator warnings that are the validator's gap, not the model's: 2.0.0-dev.3.10 predates KHR_texture_basisu, so
# it rejects image/ktx2 and can't read KTX2 (ktx validate checks those files instead); and a normal map without
# tangents, which glTF allows and three.js handles (derivative-based tangent space). Any other warning fails.
BENIGN_WARNINGS = {"VALUE_NOT_IN_LIST", "IMAGE_UNRECOGNIZED_FORMAT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"}


def mapping(asset: str) -> dict:
    return json.loads((MAPPINGS / f"{asset}.json").read_text(encoding="utf-8"))


def mapped_assets() -> list[str]:
    return sorted(p.stem for p in MAPPINGS.glob("*.json"))


def _write_job(asset: str, step: str, job: dict) -> Path:
    p = work_dir(asset) / f"job_{step}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(job, indent=1))
    return p


def _timed(asset: str, step: str, seconds: float, **extra) -> None:
    p = work_dir(asset) / "timings.json"
    t = json.loads(p.read_text()) if p.exists() else {}
    t[step] = {"seconds": round(seconds, 1), **extra}
    p.write_text(json.dumps(t, indent=1))


def _run(args: list[str], log: Path, cwd: Path | None = None) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "w", encoding="utf-8") as f:
        r = subprocess.run(args, stdout=f, stderr=subprocess.STDOUT, cwd=cwd, text=True)
    if r.returncode:
        tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]
        raise RuntimeError(f"{args[0]} failed ({r.returncode}); {log}:\n" + "\n".join(tail))


def _blender(asset: str, script: str, job: Path, factory: bool = True) -> None:
    args = [blender(), "-b"] + (["--factory-startup"] if factory else []) + \
        ["--python", str(BLENDER_DIR / script), "--", str(job)]
    _run(args, work_dir(asset) / f"{Path(script).stem}.log")


def node(asset: str, cmd: str, job: Path) -> None:
    """realism.mjs from <data>/realism/node, installing pack/package.json there first if it changed. The repo
    ignores package-lock.json (it is pnpm's), so the direct dependencies are pinned exactly instead."""
    nd = node_dir()
    nd.mkdir(parents=True, exist_ok=True)
    src, dst = PACK_DIR / "package.json", nd / "package.json"
    if not dst.exists() or dst.read_bytes() != src.read_bytes() or not (nd / "node_modules").exists():
        with locks.dir_lock(work_root() / "node-lock.d", "npm install"):
            if not dst.exists() or dst.read_bytes() != src.read_bytes() or not (nd / "node_modules").exists():
                shutil.copyfile(src, dst)
                subprocess.run([shutil.which("npm"), "install", "--no-audit", "--no-fund"], cwd=nd, check=True)
    # each worktree's script by its content, under node/ so its imports resolve to node/node_modules: workers on
    # different commits never overwrite each other's
    code = (PACK_DIR / "realism.mjs").read_bytes()
    run = nd / "runs" / hashlib.sha256(code).hexdigest()[:12]
    run.mkdir(parents=True, exist_ok=True)
    if not (run / "realism.mjs").exists():
        (run / "realism.mjs").write_bytes(code)
    _run([shutil.which("node"), str(run / "realism.mjs"), cmd, str(job)], work_dir(asset) / f"node_{cmd}.log", cwd=nd)


# --- the steps ---------------------------------------------------------------------------------------------------------
def sources(asset: str, mp: dict, rec: dict) -> list[dict]:
    lib = data_root() / "library" / rec["category"] / asset
    s = mp.get("source", {})
    if "links" in s:
        return [{"path": str(lib / "links" / f"{ln}.glb"), "link": ln, "undo_y_up": True,
                 "translate_mm": s.get("translate_mm", [0, 0, 0]), "move_mm": s.get("move_mm", {}).get(ln)}
                for ln in s["links"] if ln not in mp.get("drop_links", [])]
    return [{"path": str(lib / s.get("file", rec["file"])), "link": None, "undo_y_up": False,
             "drop_links": mp.get("drop_links", [])}]


def asset_class(asset: str) -> str:
    return budgets.budget_class(asset, asset_record(asset)["bbox"])


def simplify(asset: str) -> list[dict]:
    rec, mp = asset_record(asset), mapping(asset)
    cls = asset_class(asset)
    srcs = sources(asset, mp, rec)
    out = work_dir(asset) / "src"
    out.mkdir(parents=True, exist_ok=True)
    for s in srcs:
        s["dst"] = str(out / Path(s["path"]).name)
    cap = mp.get("triangles", budgets.CLASSES[cls]["triangles"])
    job = _write_job(asset, "simplify", {"inputs": [{"src": s["path"], "dst": s["dst"]} for s in srcs], "cap": cap,
                                         "error": mp.get("simplify_error", SIMPLIFY_ERROR[cls]),
                                         "drop_links": mp.get("drop_links", []),
                                         "report": str(work_dir(asset) / "simplify.json")})
    t = time.perf_counter()
    node(asset, "simplify", job)
    _timed(asset, "simplify", time.perf_counter() - t, kind="cpu")
    return srcs


def prepare(asset: str) -> dict:
    rec, mp = asset_record(asset), mapping(asset)
    srcs = sources(asset, mp, rec)
    simplified = {Path(f["src"]).name: f["after"] < f["before"]
                  for f in json.loads((work_dir(asset) / "simplify.json").read_text())["files"]}
    for s in srcs:
        dst = work_dir(asset) / "src" / Path(s["path"]).name
        if not dst.exists():
            raise SystemExit(f"{asset}: run simplify first ({dst} missing)")
        s["path"], s["simplified"] = str(dst), simplified.get(dst.name, False)
    means = json.loads((tiles_dir() / "tiles.json").read_text())["src_means"]
    natural = {}
    local = mp.get("materials", {})
    for name in matlib.library(local):
        r = matlib.resolved(name, means, local)
        fam = matlib.FAMILIES[r["family"]]
        k = matlib.BASE_MEAN if fam["size"] and fam.get("base") else 1.0
        natural[name] = [min(1.0, c * k) for c in r["baseColorFactor"][:3]]
    job = _write_job(asset, "prepare", {
        "asset": asset, "mapping": mp, "sources": srcs, "blend": str(work_dir(asset) / "asset.blend"),
        "stats": str(work_dir(asset) / "prepare.json"), "parts_json": str(work_dir(asset) / "parts.json"),
        "bbox_min_z": rec["bbox"]["min"][2] / 1000,
        "atlas": {**{k: budgets.CLASSES[asset_class(asset)][k] for k in ("texel_mm", "atlas_min", "atlas_max")},
                  "margin_px": 3}, "colours": {k: v + [1] for k, v in natural.items()}})
    t = time.perf_counter()
    _blender(asset, "prepare.py", job)
    _timed(asset, "prepare", time.perf_counter() - t, kind="cpu")
    return json.loads((work_dir(asset) / "prepare.json").read_text())


def bake(asset: str, device: str = "OPTIX", samples: int | None = None) -> dict:
    stats = json.loads((work_dir(asset) / "prepare.json").read_text())
    cls = asset_class(asset)
    res = mapping(asset).get("atlas") or budgets.atlas_side(stats["area_m2"], stats["uv1_utilisation"], cls)
    lo, hi = stats["bbox_m"]
    side = max(h - l for l, h in zip(lo, hi))
    job = _write_job(asset, "bake", {
        "asset": asset, "blend": str(work_dir(asset) / "asset.blend"), "ao_png": str(work_dir(asset) / "ao.png"),
        "report": str(work_dir(asset) / "bake.json"), "res": res, "device": device,
        "samples": samples or (128 if device != "CPU" else 64), "distance_m": round(min(max(0.2 * side, 0.02), 0.6), 3),
        "margin_px": max(4, res // 128)})
    if device == "CPU":
        t = time.perf_counter()
        _blender(asset, "bake.py", job, factory=False)
        _timed(asset, "bake", time.perf_counter() - t, kind="cpu")
    else:
        with locks.gpu(f"bake {asset}") as waited:
            t = time.perf_counter()
            _blender(asset, "bake.py", job, factory=False)
        _timed(asset, "bake", time.perf_counter() - t, kind="gpu", waited_s=round(waited))
    return json.loads((work_dir(asset) / "bake.json").read_text())


def encode_ao(asset: str) -> Path:
    """The AO atlas to KTX2: ETC1S (grey, smooth: its blocks don't show), linear, mipmapped."""
    png, dst = work_dir(asset) / "ao.png", work_dir(asset) / "ao.ktx2"
    subprocess.run([str(ktx()), "create", "--format", "R8G8B8_UNORM", "--assign-tf", "linear", "--encode", "basis-lz",
                    "--qlevel", "255", "--clevel", "4", "--generate-mipmap", "--threads", "4", str(png), str(dst)],
                   check=True, capture_output=True, text=True)
    return dst


def export(asset: str) -> Path:
    raw = work_dir(asset) / "raw.glb"
    job = _write_job(asset, "export", {"asset": asset, "blend": str(work_dir(asset) / "asset.blend"), "raw": str(raw)})
    t = time.perf_counter()
    _blender(asset, "export.py", job)
    _timed(asset, "export", time.perf_counter() - t, kind="cpu")
    return raw


def pack(asset: str) -> dict:
    tiles = json.loads((tiles_dir() / "tiles.json").read_text())
    t = time.perf_counter()
    ao = encode_ao(asset) if (work_dir(asset) / "ao.png").exists() else None
    models_dir().mkdir(parents=True, exist_ok=True)
    job = _write_job(asset, "pack", {
        "raw": str(work_dir(asset) / "raw.glb"), "out": str(models_dir() / f"{asset}.glb"),
        "ao_ktx2": str(ao) if ao else None, "tiles_uri": "../tiles/", "families": tiles["families"],
        "materials": matlib.resolve_all(tiles["src_means"], mapping(asset).get("materials")),
        "report": str(work_dir(asset) / "pack.json")})
    node(asset, "pack", job)
    _timed(asset, "pack", time.perf_counter() - t, kind="cpu")
    return json.loads((work_dir(asset) / "pack.json").read_text())


def validate(asset: str) -> dict:
    job = _write_job(asset, "validate", {"glb": str(models_dir() / f"{asset}.glb"),
                                         "report": str(work_dir(asset) / "validator.json")})
    node(asset, "validate", job)
    report = check(asset)
    (work_dir(asset) / "report.json").write_text(json.dumps(report, indent=1))
    return report


UV1_FLOOR = 0.1             # an atlas using less of its square than this is mostly margin (prepare.py repacks under 0.2)
AO_LIT = 0.25                # an AO texel above this is lit; a healthy bake has most of its islands' texels above it


def ao_health(asset: str, st: dict) -> dict:
    """Whether the AO bake is usable: its atlas isn't mostly margin, and its islands aren't black. edgef's spring
    shattered into thousands of islands, its pack fell to 0.000 and it baked black, and every other check passed."""
    util = st["uv1_utilisation"]
    png = work_dir(asset) / "ao.png"
    if not png.exists():
        return {"ok": False, "uv1_utilisation": util, "why": "no AO bake"}
    from PIL import Image
    a = np.asarray(Image.open(png).convert("L"), np.float32) / 255
    lit = float((a > AO_LIT).mean())
    ok = util >= UV1_FLOOR and lit >= 0.4 * util
    return {"ok": bool(ok), "uv1_utilisation": util, "lit_share": round(lit, 4), "mean": round(float(a.mean()), 4)}


def check(asset: str) -> dict:
    """The asset against its budgets: the validator's verdict, size, triangles, its frame against the record's."""
    rec, mp = asset_record(asset), mapping(asset)
    cls = asset_class(asset)
    c = budgets.CLASSES[cls]
    w = work_dir(asset)
    pk = json.loads((w / "pack.json").read_text())
    va = json.loads((w / "validator.json").read_text())
    st = json.loads((w / "prepare.json").read_text())
    ao = next((t for t in pk["embedded_textures"] if t["name"] == "ao"), None)
    gpu_tex = budgets.gpu_texture_bytes(*ao["size"]) if ao else 0
    # the frame: glTF (x, y, z) is the library's (x, -z, y), in metres; the record's bbox is the library's, in mm
    b = pk["bounds"]
    got = {"min": [b["min"][0] * 1000, -b["max"][2] * 1000, b["min"][1] * 1000],
           "max": [b["max"][0] * 1000, -b["min"][2] * 1000, b["max"][1] * 1000]}
    tol = mp.get("bbox_tolerance_mm", 10.0)
    frame = {k: [round(g - r, 1) for g, r in zip(got[k], rec["bbox"][k])] for k in ("min", "max")}
    bad = [m for m in va["messages"] if m["severity"] <= 1 and (m["code"] not in BENIGN_WARNINGS or (
        m["code"] == "VALUE_NOT_IN_LIST" and "image/ktx2" not in m["message"]))]
    ktx_ok = not (w / "ao.ktx2").exists() or         subprocess.run([str(ktx()), "validate", str(w / "ao.ktx2")], capture_output=True).returncode == 0
    health = ao_health(asset, st)
    cap_bytes = mp.get("download_bytes", c["download_bytes"])
    checks = {
        "validator": va["errors"] == 0 and not bad and ktx_ok,
        "download": pk["bytes"] <= cap_bytes,
        "triangles": pk["triangles"] <= mp.get("triangles", c["triangles"]) * 1.05,
        "frame": all(abs(d) <= tol for k in frame for d in frame[k]),
        "mapped": not set(st["unmapped"]) - set(mp.get("fallback_ok", [])),
        "ao": health["ok"],
    }
    allowance = {k: mp[k] for k in ("download_bytes", "download_why", "triangles", "triangles_why") if k in mp}
    return {"asset": asset, "class": cls, "status": "ok" if all(checks.values()) else "failed: " + ", ".join(
        k for k, v in checks.items() if not v), "checks": checks, "bytes": pk["bytes"], "triangles": pk["triangles"],
        "draw_calls": pk["draw_calls"], "gpu_texture_bytes": gpu_tex, "gpu_geometry_bytes": pk["geometry_gpu_bytes"],
        "ao": ao, "tiles": pk["tiles"], "materials": pk["materials"], "frame_delta_mm": frame,
        "validator": {**{k: va[k] for k in ("errors", "warnings", "infos", "hints")},
                      "not_benign": [f"{m['code']} {m.get('pointer', '')}" for m in bad][:20]},
        "unmapped": st["unmapped"], "ao_health": health, "allowance": allowance,
        "budget": c}


def build(asset: str, device: str = "OPTIX", steps: list[str] | None = None) -> dict:
    steps = steps or ["simplify", "prepare", "bake", "export", "pack", "validate"]
    out = {}
    for s in steps:
        print(f"[realism] {asset}: {s}", flush=True)
        out[s] = globals()[s](asset, device) if s == "bake" else globals()[s](asset)
    return out.get("validate", {})
