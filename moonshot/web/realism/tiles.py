"""The shared tile library: each surface family (matlib.FAMILIES) baked with numpy into a colour-neutral, seamlessly
tiling texture set, then KTX2-encoded once for the whole shop into <data>/web/tiles/:

    <family>_base.ktx2   ETC1S (BasisLZ), sRGB: luminance only, averaging matlib.BASE_MEAN; the material's
                         baseColorFactor gives the colour
    <family>_mr.ktx2     UASTC + zstd, linear: G roughness averaging the family's rough_mean, B metalness 1 (glTF's
                         metallicRoughnessTexture; the factors scale both)
    <family>_nrm.ktx2    UASTC + zstd, linear: tangent-space normal, OpenGL (+Y up) as glTF's
    tiles.json           per family: files, sizes, bytes, estimated GPU bytes; each source's mean colour

ETC1S for colour, UASTC for the maps where ETC1S's block artefacts would read as lighting noise: the spike's
"ktx2mix". Every procedural layer is periodic (FFT-filtered noise), so each tile repeats without a seam. CPU only.
"""
from __future__ import annotations

import json
import subprocess
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from moonshot.config import data_root
from moonshot.web.realism import matlib
from moonshot.web.realism.budgets import gpu_texture_bytes
from moonshot.web.realism.paths import ktx, tiles_dir, work_root

Image.MAX_IMAGE_PIXELS = None
ETC1S_QUALITY = "255"
UASTC = ["--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", "1.0", "--zstd", "18"]


# --- sources ---------------------------------------------------------------------------------------------------------
def src_map(asset: str, kind: str, n: int | None = None) -> np.ndarray | None:
    """An ambientCG map (resized to n x n): Color as linear RGB, NormalGL as RGB 0..1, the rest one channel 0..1."""
    folder = data_root() / "cc0" / asset
    hits = sorted(folder.glob(f"{asset}_*_{kind}.jpg")) + sorted(folder.glob(f"{asset}_*_{kind}.png"))
    if not hits:
        return None
    im = Image.open(hits[0]).convert("RGB" if kind in ("Color", "NormalGL") else "L")
    if n:
        im = im.resize((n, n), Image.LANCZOS)
    a = np.asarray(im, np.float32) / 255.0
    return srgb_to_lin(a) if kind == "Color" else a


def mask_of(asset: str, n: int) -> np.ndarray:
    """A 0..1 mask from an imperfection map: its roughness if it has one, else its colour's luminance; stretched."""
    m = src_map(asset, "Roughness", n)
    if m is None:
        m = lum(src_map(asset, "Color", n))
    lo, hi = np.percentile(m, 2), np.percentile(m, 98)
    return np.clip((m - lo) / max(hi - lo, 1e-4), 0, 1)


def src_mean(asset: str) -> list[float]:
    c = src_map(asset, "Color", 512)
    return [round(float(x), 5) for x in c.reshape(-1, 3).mean(0)]


# --- colour and normals ------------------------------------------------------------------------------------------------
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def lum(c):
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def decode_n(rgb):
    n = rgb * 2 - 1
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def scale_n(n, s):
    m = n.copy()
    m[..., :2] *= s
    return m / np.linalg.norm(m, axis=-1, keepdims=True)


def blend_n(a, b):
    """Whiteout blend of two tangent-space normals."""
    m = np.stack([a[..., 0] + b[..., 0], a[..., 1] + b[..., 1], a[..., 2] * b[..., 2]], -1)
    return m / np.linalg.norm(m, axis=-1, keepdims=True)


def height_to_n(h, strength):
    """Normals from a periodic height field (texels of height per texel), OpenGL convention (+V up)."""
    du = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dv = -(np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    m = np.stack([-du * strength, -dv * strength, np.ones_like(h)], -1)
    return m / np.linalg.norm(m, axis=-1, keepdims=True)


def noise(n, f_lo, f_hi, seed, beta=1.0):
    """Band-limited periodic noise, 0..1: frequencies f_lo..f_hi cycles per tile, amplitude ~ 1/f^beta."""
    rng = np.random.default_rng(seed)
    F = np.fft.fft2(rng.standard_normal((n, n)))
    f = np.fft.fftfreq(n) * n
    r = np.sqrt(f[None, :] ** 2 + f[:, None] ** 2)
    amp = np.where((r >= f_lo) & (r <= f_hi), 1.0 / np.maximum(r, 1.0) ** beta, 0.0)
    h = np.real(np.fft.ifft2(F * amp))
    h = (h - h.mean()) / (h.std() + 1e-9)
    return np.clip(0.5 + h / 6, 0, 1).astype(np.float32)


# --- one family ----------------------------------------------------------------------------------------------------------
def bake(name: str) -> dict[str, np.ndarray]:
    """A family's maps as float arrays: base (linear grey, mean BASE_MEAN), mr (RGB), nrm (RGB 0..1, or none)."""
    f = matlib.FAMILIES[name]
    n, k = f["size"], f["tile_m"]
    seed = zlib.crc32(name.encode())
    b, r, nm, src = f.get("base", {}), f.get("rough", {}), f.get("normal", {}), f.get("src")
    v = np.ones((n, n), np.float32)                      # base: relative brightness, mean 1
    if src and "contrast" in b:
        L = lum(src_map(src, "Color", n))
        v = 1 + (L / L.mean() - 1) * b["contrast"]
    if b.get("mottle"):
        v = v * (1 - b["mottle"] * noise(n, 1, 6, seed + 1, 1.5))
    m = np.ones((n, n), np.float32)                      # roughness: relative, mean 1
    if src and "contrast" in r:
        R = src_map(src, "Roughness", n)
        m = 1 + (R / R.mean() - 1) * r["contrast"]
    if r.get("smudge"):
        m = m + (mask_of(r["smudge"][0], n) - 0.5) * 2 * r["smudge"][1]
    if r.get("prints"):
        p = mask_of(r["prints"][0], n)
        m = m + (p - p.mean()) * r["prints"][1]
    N = None
    if src and "strength" in nm:
        N = scale_n(decode_n(src_map(src, "NormalGL", n)), nm["strength"])
    if nm.get("peel"):                                   # orange peel: 1-3 mm undulation of the paint
        P = height_to_n(noise(n, 0.3 / 0.003 * k, 1 / 0.0012 * k, seed + 4), nm["peel"] * 2.0)
        N = P if N is None else blend_n(N, P)
    if nm.get("cast"):                                   # sand-cast surface under paint: pits and lumps
        h = noise(n, 1 / 0.02 * k, 1 / 0.0015 * k, seed + 5, 0.7)
        pits = np.clip((noise(n, 1 / 0.01 * k, 1 / 0.003 * k, seed + 6) - 0.72) * 6, 0, 1)
        C = height_to_n(h - 0.6 * pits, nm["cast"] * 6.0)
        N = C if N is None else blend_n(N, C)
        v = v * (1 - b.get("pits", 0.0) * pits)
        m = m + 0.3 * pits                               # paint thin and dull in the pits
    v = v / v.mean()
    m = m / m.mean()
    out = {"base": np.clip(matlib.BASE_MEAN * v, 0, 1)} if b else {}
    out["mr"] = np.stack([np.ones_like(m), np.clip(f["rough_mean"] * m, 0.02, 1), np.ones_like(m)], -1)
    if N is not None:
        out["nrm"] = N * 0.5 + 0.5
    return out


def encode(png: Path, dst: Path, kind: str) -> None:
    """One map to KTX2 with mipmaps (wrapped, as the tile repeats)."""
    common = ["--generate-mipmap", "--mipmap-wrap", "wrap", "--threads", "4"]
    if kind == "base":
        args = ["--format", "R8G8B8_SRGB", "--encode", "basis-lz", "--qlevel", ETC1S_QUALITY, "--clevel", "4"]
    else:
        args = ["--format", "R8G8B8_UNORM", "--assign-tf", "linear", *UASTC]
    subprocess.run([str(ktx()), "create", *args, *common, str(png), str(dst)], check=True, capture_output=True,
                   text=True)


def build(only: set[str] | None = None) -> dict:
    out_dir, png_dir = tiles_dir(), work_root() / "tiles_png"
    out_dir.mkdir(parents=True, exist_ok=True)
    png_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "tiles.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"families": {}}
    index["about"] = ("The shop's shared tile textures: one colour-neutral set per surface family, referenced by every "
                      "realistic model (moonshot/web/realism/SPEC.md). Sources CC0: " + matlib.LICENCE)
    index["sources"] = matlib.SOURCES
    index["src_means"] = {s: src_mean(s) for s in sorted({f["src"] for f in matlib.FAMILIES.values() if f.get("src")})}
    for name, f in matlib.FAMILIES.items():
        if f["size"] == 0 or (only and name not in only):
            continue
        maps = bake(name)
        files = {}
        for kind, a in maps.items():
            png = png_dir / f"{name}_{kind}.png"
            img = lin_to_srgb(a) if kind == "base" else a
            if img.ndim == 2:
                img = np.repeat(img[..., None], 3, -1)
            Image.fromarray((img * 255 + 0.5).astype(np.uint8)).save(png)
            dst = out_dir / f"{name}_{kind}.ktx2"
            encode(png, dst, kind)
            files[kind] = {"file": dst.name, "size": f["size"], "bytes": dst.stat().st_size,
                           "gpu_bytes": gpu_texture_bytes(f["size"], f["size"]),
                           "colorSpace": "srgb" if kind == "base" else "linear"}
            print(f"[tiles] {dst.name}: {dst.stat().st_size / 1e3:.0f} kB", flush=True)
        index["families"][name] = {"about": f["about"], "tile_m": f["tile_m"], "rough_mean": f["rough_mean"],
                                   "files": files}
    index["families"] = {k: v for k, v in index["families"].items() if k in matlib.FAMILIES}
    index["bytes"] = sum(x["bytes"] for fam in index["families"].values() for x in fam["files"].values())
    index["gpu_bytes"] = sum(x["gpu_bytes"] for fam in index["families"].values() for x in fam["files"].values())
    index_path.write_text(json.dumps(index, indent=1) + "\n")
    print(f"[tiles] {len(index['families'])} families, {index['bytes'] / 1e6:.1f} MB, "
          f"~{index['gpu_bytes'] / 1e6:.0f} MB GPU", flush=True)
    swatches(index)
    return index


def swatches(index: dict) -> Path:
    """Every material as a lit swatch (its family's textures times its factors), for review."""
    png_dir = work_root() / "tiles_png"
    s, cols = 192, 6
    names = list(matlib.MATERIALS)
    sheet = Image.new("RGB", (cols * s, ((len(names) + cols - 1) // cols) * (s + 18)), (20, 20, 22))
    d = ImageDraw.Draw(sheet)
    L = np.array([-0.5, 0.5, 0.7])
    L = L / np.linalg.norm(L)
    for i, name in enumerate(names):
        r = matlib.resolved(name, index["src_means"])
        fam = r["family"]
        base = np.ones((s, s, 3), np.float32)
        p = png_dir / f"{fam}_base.png"
        if p.exists():
            base = srgb_to_lin(np.asarray(Image.open(p).convert("RGB").resize((s, s)), np.float32) / 255)
        base = base * np.array(r["baseColorFactor"][:3], np.float32)
        shade = np.ones((s, s), np.float32)
        p = png_dir / f"{fam}_nrm.png"
        if p.exists():
            N = np.asarray(Image.open(p).convert("RGB").resize((s, s)), np.float32) / 255 * 2 - 1
            N[..., :2] *= r["normalScale"]
            N = N / np.linalg.norm(N, axis=-1, keepdims=True)
            shade = np.clip(N @ L, 0, 1) / float(L[2])
        img = lin_to_srgb(base * shade[..., None] * 1.6)
        x, y = (i % cols) * s, (i // cols) * (s + 18)
        sheet.paste(Image.fromarray((img * 255).astype(np.uint8)), (x, y + 18))
        d.text((x + 3, y + 3), name, fill=(240, 220, 90))
    out = work_root() / "swatches.png"
    sheet.save(out)
    print(f"[tiles] swatches {out}", flush=True)
    return out
