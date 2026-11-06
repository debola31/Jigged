"""Review sheets: look.py's renders of an asset composed into one labelled picture per mode, with the legend, for
judging a mapping by eye; and before/after sheets from the page-side screenshots."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw


def _srgb(c: float) -> int:
    c = min(max(c, 0.0), 1.0)
    return int(255 * (c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))


def sheet(look_dir: Path, mode: str, views: list[str], out: Path, title: str, cols: int = 3) -> Path:
    legend = json.loads((look_dir / "legend.json").read_text()).get(mode, {})
    ims = [Image.open(look_dir / f"{mode}_{v}.png").convert("RGB") for v in views]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    key_w = 300 if legend else 0
    out_im = Image.new("RGB", (cols * w + key_w, max(rows * h, 22 * len(legend) + 40) + 30), (24, 24, 26))
    d = ImageDraw.Draw(out_im)
    d.text((8, 8), title, fill=(240, 240, 240))
    for i, (im, v) in enumerate(zip(ims, views)):
        x, y = (i % cols) * w, (i // cols) * h + 30
        out_im.paste(im, (x, y))
        d.text((x + 6, y + 6), v, fill=(0, 0, 0))
    for i, (name, c) in enumerate(legend.items()):
        x, y = cols * w + 10, 40 + i * 22
        d.rectangle([x, y, x + 16, y + 16], fill=tuple(_srgb(v) for v in c))
        d.text((x + 24, y + 2), name, fill=(230, 230, 230))
    out.parent.mkdir(parents=True, exist_ok=True)
    out_im.save(out)
    return out


def side_by_side(pairs: list[tuple[str, Path]], out: Path, title: str, width: int = 960) -> Path:
    """Pictures in a row, each scaled to `width`, captioned."""
    ims = [(cap, Image.open(p).convert("RGB")) for cap, p in pairs if Path(p).exists()]
    ims = [(cap, im.resize((width, int(im.height * width / im.width)))) for cap, im in ims]
    h = max(im.height for _, im in ims)
    out_im = Image.new("RGB", (width * len(ims), h + 30), (24, 24, 26))
    d = ImageDraw.Draw(out_im)
    d.text((8, 8), title, fill=(240, 240, 240))
    for i, (cap, im) in enumerate(ims):
        out_im.paste(im, (i * width, 30))
        d.rectangle([i * width, 30, i * width + 8 * len(cap) + 12, 50], fill=(0, 0, 0))
        d.text((i * width + 6, 34), cap, fill=(255, 220, 90))
    out.parent.mkdir(parents=True, exist_ok=True)
    out_im.save(out)
    return out
