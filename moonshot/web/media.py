"""Everything the showcase page loads besides its JSON, staged in <data root>/web/ exactly as Supabase Storage will
serve it (plan §1: "videos and published models in Supabase Storage, never the Next build"):

    models/<asset>.glb             light copies of the library's GLBs for the shop view
    video/<part>/<step>.mp4        a person's step: its final render, takes/<part>-<step>/final.mp4
    still/<part>/<step>.webp       a machine cycle: one still of the part after it, from takes/<part>-<step>/still.png
    cut/<part>/<step>.glb          ... and the part itself, the take's last stock mesh, for a desktop to turn

    python -m moonshot.web.media models            # decimate every asset the layout places (gltf-transform, via npx)
    python -m moonshot.web.media stage             # stage every live step's final or still that exists; lists the missing
    python -m moonshot.web.media serve [--draft takes/setup-take/draft.mp4]
    SUPABASE_SECRET_KEY=... python -m moonshot.web.media upload --url https://<ref>.supabase.co op10-face op10-seat ...

`serve` is for development only: it serves the folder on http://localhost:8787 with CORS, so `pnpm dev` can run with
NEXT_PUBLIC_SHOWCASE_MEDIA_URL=http://localhost:8787. With --draft, a step video not staged yet is answered with that
draft, so the player can be built before the finals exist; drafts are never staged, so never uploaded.

`upload` publishes the named steps' media (and, with --models, the models) to the public `showcase` bucket
(supabase/migrations/*_showcase_storage_bucket.sql): anyone can then fetch it. Steps are named one by one because a
person's step is published only once the user has reviewed its draft; nothing is published for being staged. It takes
the project's URL explicitly and the secret key only from the environment, so it can't publish to a project by
accident through .env.local.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import shutil
import subprocess
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from moonshot.config import data_root
from moonshot.web.export import PUBLISHED, RECORDS, _json, asset_record, build, media_paths, shop_assets

GLTF_TRANSFORM = "@gltf-transform/cli@4.5.1"
# Triangle budgets for the shop view, where a machine is a few hundred pixels across and a tool a few.
BUDGET = {"machines": 15_000, "support": 4_000}
BUDGET_DEFAULT = 1_500
SIMPLIFY_ERROR = 0.02                      # a fraction of the mesh's extent; invisible at shop scale
PORT = 8787
BUCKET = "showcase"
CONTENT_TYPES = {".glb": "model/gltf-binary", ".mp4": "video/mp4", ".webp": "image/webp"}
STILL_QUALITY = 85                         # WebP: a 1080p still in a few hundred kB, for phones on cellular


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


def live_steps() -> dict[str, tuple[str, dict]]:
    """Each live step by id, with its part: "op10-face" -> ("nist-ftc-10", step)."""
    return {s["id"]: (part["id"], s) for part in build()["parts"] for s in part.get("steps", [])}


def _stale(src: Path, dst: Path) -> bool:
    return not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime


def stage_step(part: str, step: dict) -> bool:
    """Stage one step's media from its take; False if the take has no final (or still and stock) yet."""
    take = data_root() / "takes" / f"{part}-{step['id']}"
    media = step["media"]
    if media["type"] == "video":
        src, dst = take / "final.mp4", web_root() / media["path"]
        if not src.exists():
            return False
        dst.parent.mkdir(parents=True, exist_ok=True)
        if _stale(src, dst):
            shutil.copy2(src, dst)
        return True
    still, stock = take / "still.png", sorted((take / "stock").glob("*.glb"), key=lambda p: int(p.stem))
    if not still.exists() or not stock:
        return False
    dst = web_root() / media["still"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    if _stale(still, dst):
        Image.open(still).convert("RGB").save(dst, "WEBP", quality=STILL_QUALITY, method=6)
    # The stock as the cut leaves it: its last mesh (named by frame), meshopt-compressed but not simplified, so the
    # model shows the cut exactly.
    dst = web_root() / media["model"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    if _stale(stock[-1], dst):
        subprocess.run([shutil.which("npx"), "--yes", GLTF_TRANSFORM, "optimize", str(stock[-1]), str(dst),
                        "--simplify", "false", "--texture-compress", "false", "--palette", "false"],
                       check=True, capture_output=True, text=True)
    return True


def stage() -> None:
    missing = [s["id"] for part, s in live_steps().values() if not stage_step(part, s)]
    print(f"staged: {'every step' if not missing else f'all but {len(missing)} steps, with no final yet: ' + ', '.join(missing)}")


def upload(url: str, step_ids: list[str], models: bool) -> None:
    key = os.environ["SUPABASE_SECRET_KEY"]
    steps = live_steps()
    unknown = [i for i in step_ids if i not in steps]
    if unknown:
        raise SystemExit(f"no live step {', '.join(unknown)}")
    missing = [i for i in step_ids if not stage_step(*steps[i])]
    if missing:
        raise SystemExit(f"nothing to publish yet for {', '.join(missing)}: no final in takes/")
    paths = [p for i in step_ids for p in media_paths(steps[i][1]["media"])]
    if models:
        paths += [f"models/{a}.glb" for a in shop_assets(_json(RECORDS / "layout.json"))]
    total = 0
    for path in paths:
        p = web_root() / path
        # The key goes in apikey only: a secret key (sb_secret_...) isn't a JWT, and is refused as a bearer token.
        req = urllib.request.Request(
            f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}", data=p.read_bytes(), method="POST",
            headers={"apikey": key, "Content-Type": CONTENT_TYPES[p.suffix], "x-upsert": "true",
                     "Cache-Control": "max-age=3600"})
        with urllib.request.urlopen(req, timeout=300):
            pass
        total += p.stat().st_size
    print(f"uploaded {len(paths)} files, {total / 1e6:.1f} MB, to {url}/storage/v1/object/public/{BUCKET}/")
    # Only now is a step's media the page's to show: record it, then re-export and commit the page's data.
    record = _json(PUBLISHED)
    record["media"] = sorted(set(record["media"]) | {p for i in step_ids for p in media_paths(steps[i][1]["media"])})
    PUBLISHED.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{PUBLISHED.name}: {len(record['media'])} files published; now run python -m moonshot.web.export")


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
    ap.add_argument("command", choices=["models", "stage", "serve", "upload"])
    ap.add_argument("steps", nargs="*", help="upload: the live steps to publish, by id (op10-face ...)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--models", action="store_true", help="upload: the shop's models too")
    ap.add_argument("--draft", type=Path, help="serve: a video for every step not staged yet (relative to the data root)")
    ap.add_argument("--url", help="upload: the Supabase project, https://<ref>.supabase.co")
    a = ap.parse_args()
    if a.command == "models":
        build_models(a.force)
    elif a.command == "stage":
        stage()
    elif a.command == "upload":
        if not a.url or not (a.steps or a.models):
            ap.error("upload needs --url, and the steps to publish (or --models)")
        upload(a.url, a.steps, a.models)
    else:
        serve(data_root() / a.draft if a.draft else None)


if __name__ == "__main__":
    main()
