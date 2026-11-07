"""python -m moonshot.web.realism <command>: see the package docstring."""
from __future__ import annotations

import argparse
import json

from moonshot.web.realism import draft, locks, manifest, pipeline, projection, review, tiles
from moonshot.web.realism.paths import work_dir

LOOK_VIEWS = ["front", "back", "left", "right", "top", "low"]


def look(asset: str, modes: list[str], views: list[str], out_dir=None) -> list:
    d = work_dir(asset) / "look"
    job = pipeline._write_job(asset, "look", {
        "asset": asset, "blend": str(work_dir(asset) / "asset.blend"), "out_dir": str(d), "modes": modes,
        "views": views, "iso_views": views[:2], "natural": json.loads((work_dir(asset) / "job_prepare.json").read_text())["colours"],
        "extra_views": pipeline.mapping(asset).get("views", {}),
        "names": {"links": json.loads((work_dir(asset) / "prepare.json").read_text())["links"],
                  "cads": json.loads((work_dir(asset) / "prepare.json").read_text())["cads"]}})
    with locks.gpu(f"look {asset}"):            # Workbench draws on the GPU
        pipeline._blender(asset, "look.py", job)
    out = out_dir or d
    sheets = [review.sheet(d, m, views, out / f"{asset}_{m}.png", f"{asset}: {m}") for m in modes if m != "iso"]
    if "iso" in modes:
        mp = pipeline.mapping(asset)
        legend = json.loads((d / "legend.json").read_text())
        labels = {c: mp["cad"].get("*", {}).get(c, "") for c in legend["iso"]}
        sheets.append(review.iso_sheet(d, legend["iso"], views[:2], labels, out / f"{asset}_iso.png",
                                       f"{asset}: each CAD material alone, and what the mapping makes it"))
    return sheets


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m moonshot.web.realism")
    ap.add_argument("command", choices=["tiles", "draft", "build", "look", "manifest", "check", "project"])
    ap.add_argument("assets", nargs="*")
    ap.add_argument("--steps", help="build: comma-separated steps (default all)")
    ap.add_argument("--device", default="OPTIX", help="bake: OPTIX, CUDA or CPU")
    ap.add_argument("--modes", default="materials,natural,parts")
    ap.add_argument("--views", default=",".join(LOOK_VIEWS))
    ap.add_argument("--fallback", default="paint_mid_grey", help="draft: the material of faces nothing maps")
    a = ap.parse_args()
    if a.command == "tiles":
        tiles.build(set(a.assets) or None)
    elif a.command == "build":
        for asset in a.assets or pipeline.mapped_assets():
            r = pipeline.build(asset, a.device, a.steps.split(",") if a.steps else None)
            print(f"[realism] {asset}: {r.get('status', 'done')}")
    elif a.command == "look":
        for asset in a.assets:
            for p in look(asset, a.modes.split(","), a.views.split(",")):
                print(p)
    elif a.command == "draft":
        for asset in a.assets:
            draft.draft(asset, a.fallback)
            print(f"wrote mappings/{asset}.json: review it")
    elif a.command == "check":
        for asset in a.assets or pipeline.mapped_assets():
            print(json.dumps(pipeline.check(asset), indent=1))
    elif a.command == "project":
        p = projection.project()
        for asset, r in sorted(p["assets"].items(), key=lambda kv: (kv[1]["class"], -kv[1]["bytes"])):
            print(f"{asset:>12} {r['class']:>5} {r['priority']:>5} x{r['items']:<2} {'built' if r['built'] else 'est.':>5} "
                  f"{r['triangles']:>8} tris {r['bytes'] / 1e6:6.2f} MB {r['gpu_texture_bytes'] / 1e6:6.1f} MB GPU")
        print(json.dumps(p["totals"], indent=1))
        print(json.dumps({k: v for k, v in (p["frame_model"] or {}).items() if k != "points"}, indent=1))
    else:
        print(manifest.write())


if __name__ == "__main__":
    main()
