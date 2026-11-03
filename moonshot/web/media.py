"""Everything the showcase page loads besides its JSON, staged in <data root>/web/ exactly as Supabase Storage will
serve it (plan §1: "videos and published models in Supabase Storage, never the Next build"):

    models/<asset>.glb             light copies of the library's GLBs for the shop view
    video/<part>/<step>.mp4        each step's final render

    python -m moonshot.web.media models            # decimate every asset the layout places (gltf-transform, via npx)
    python -m moonshot.web.media videos            # copy each live step's takes/<part>-<step>/final.mp4; lists the missing
    python -m moonshot.web.media serve [--draft takes/setup-take/draft.mp4]

`serve` is for development only: it serves the folder on http://localhost:8787 with CORS, so `pnpm dev` can run with
NEXT_PUBLIC_SHOWCASE_MEDIA_URL=http://localhost:8787. With --draft, a step video not staged yet is answered with that
draft, so the player can be built before the finals exist. Nothing here uploads: publishing is a separate decision.
"""
from __future__ import annotations

import argparse
import functools
import shutil
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from moonshot.config import data_root
from moonshot.web.export import RECORDS, _json, asset_record, build, shop_assets

GLTF_TRANSFORM = "@gltf-transform/cli@4.5.1"
# Triangle budgets for the shop view, where a machine is a few hundred pixels across and a tool a few.
BUDGET = {"machines": 15_000, "support": 4_000}
BUDGET_DEFAULT = 1_500
SIMPLIFY_ERROR = 0.02                      # a fraction of the mesh's extent; invisible at shop scale
PORT = 8787


def web_root() -> Path:
    return data_root() / "web"


def build_models(force: bool = False) -> None:
    out = web_root() / "models"
    out.mkdir(parents=True, exist_ok=True)
    npx = shutil.which("npx")
    script_time = Path(__file__).stat().st_mtime
    total_in = total_out = 0
    for asset in shop_assets(_json(RECORDS / "layout.json")):
        rec = asset_record(asset)
        src = data_root() / "library" / rec["category"] / asset / rec["file"]
        dst = out / f"{asset}.glb"
        if force or not dst.exists() or dst.stat().st_mtime < max(src.stat().st_mtime, script_time):
            ratio = min(1.0, BUDGET.get(rec["category"], BUDGET_DEFAULT) / max(rec["triangles"], 1))
            subprocess.run([npx, "--yes", GLTF_TRANSFORM, "optimize", str(src), str(dst),
                            "--simplify-ratio", f"{ratio:.4f}", "--simplify-error", str(SIMPLIFY_ERROR),
                            "--texture-compress", "false", "--palette", "false"],
                           check=True, capture_output=True, text=True)
        total_in, total_out = total_in + src.stat().st_size, total_out + dst.stat().st_size
        print(f"{asset:>10}  {src.stat().st_size / 1e6:6.2f} MB -> {dst.stat().st_size / 1e6:5.2f} MB")
    print(f"models: {total_in / 1e6:.1f} MB -> {total_out / 1e6:.1f} MB in {out}")


def stage_videos() -> None:
    missing = []
    for part in build()["parts"]:
        for s in part.get("steps", []):
            src = data_root() / "takes" / f"{part['id']}-{s['id']}" / "final.mp4"
            dst = web_root() / s["video"]
            if not src.exists():
                missing.append(s["id"])
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                shutil.copy2(src, dst)
    print(f"videos: {'all staged' if not missing else f'{len(missing)} steps have no final yet: ' + ', '.join(missing)}")


class Handler(SimpleHTTPRequestHandler):
    draft: Path | None = None

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def translate_path(self, path):
        local = Path(super().translate_path(path))
        if self.draft and not local.exists() and local.suffix == ".mp4":
            return str(self.draft)
        return str(local)


def serve(draft: Path | None) -> None:
    web_root().mkdir(parents=True, exist_ok=True)
    Handler.draft = draft
    handler = functools.partial(Handler, directory=str(web_root()))
    print(f"serving {web_root()} on http://localhost:{PORT}" + (f", unstaged videos as {draft}" if draft else ""))
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["models", "videos", "serve"])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--draft", type=Path, help="serve: a video for every step not staged yet (relative to the data root)")
    a = ap.parse_args()
    if a.command == "models":
        build_models(a.force)
    elif a.command == "videos":
        stage_videos()
    else:
        serve(data_root() / a.draft if a.draft else None)


if __name__ == "__main__":
    main()
