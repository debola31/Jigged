"""The page-side check: preview/index.html, served beside <data>/web as the media server would serve it, loaded in
headless Chromium on the GPU through realism.mjs `shots`. Before/after pictures per asset (its light model, then its
realistic one, same camera and light) and, for the whole shop, triangles, draws and GPU frame time.

    python -m moonshot.web.realism.loadcheck vf2 bandsaw ...        # before/after shots per asset
    python -m moonshot.web.realism.loadcheck --shop                 # the whole shop, light vs full, frame times
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from moonshot.web.export import OUT as SHOWCASE_JSON
from moonshot.web.realism import locks, pipeline, review
from moonshot.web.realism.paths import HERE, web_root, work_root

PORT = 8790


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split("?", 1)[0].lstrip("/")
        if p in ("", "index.html"):
            return str(HERE / "preview" / "index.html")
        if p == "shop.json":
            return str(SHOWCASE_JSON)
        if p.startswith("env/"):
            return str(work_root() / p)
        return str(web_root() / p)

    def log_message(self, *a):
        pass


def serve() -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=str(web_root())))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def run(shots: list[dict], name: str) -> list[dict]:
    """The shots in headless Chromium, holding the GPU lock (which also keeps two workers off the one port)."""
    d = work_root() / "checks"
    d.mkdir(parents=True, exist_ok=True)
    name = f"{name}_{os.getpid()}"
    job = d / f"shots_{name}.json"
    job.write_text(json.dumps({"base": f"http://127.0.0.1:{PORT}", "shots": shots, "report": str(d / f"{name}.json")},
                              indent=1))
    with locks.gpu(f"loadcheck {name}"):
        httpd = serve()
        try:
            pipeline.node("checks", "shots", job)
        finally:
            httpd.shutdown()
            httpd.server_close()
    out = json.loads((d / f"{name}.json").read_text())
    (d / f"{name.rsplit('_', 1)[0]}.json").write_text(json.dumps(out, indent=1))     # the latest, by kind
    return out


def asset_shots(assets: list[str], out_dir: Path, views=("front", "close")) -> list[dict]:
    shots = []
    for a in assets:
        extra = pipeline.mapping(a).get("check_views", {})
        for v in [*views, *extra]:
            for mode in ("light", "full"):
                q = f"scene=asset&asset={a}&mode={mode}&view={v}"
                if v in extra:
                    q = f"scene=asset&asset={a}&mode={mode}&view=front&eye={extra[v]['eye']}&target={extra[v]['target']}"
                shots.append({"query": q, "w": 1280, "h": 800, "png": str(out_dir / f"{a}_{v}_{mode}.png"),
                              "asset": a, "view": v, "mode": mode})
    res = run(shots, "assets")
    for a in assets:
        for v in [*views, *pipeline.mapping(a).get("check_views", {})]:
            review.side_by_side([("before: today's light model", out_dir / f"{a}_{v}_light.png"),
                                 ("after: realistic model", out_dir / f"{a}_{v}_full.png")],
                                out_dir / f"{a}_{v}_before_after.png", f"{a}, {v}: three.js r186, same camera and light")
    return res


def shop_shots(out_dir: Path, extras=(0, 2, 4)) -> list[dict]:
    """The whole shop at 1080p, light then full, shadows redrawn every frame and drawn once (as the page does);
    then with `extra` more copies of every realistic model, for the cost of each million triangles."""
    shots = []
    for shadow in ("dynamic", "static"):
        for m in ("light", "full"):
            shots.append({"query": f"scene=shop&mode={m}&shadow={shadow}", "w": 1920, "h": 1080, "bench": 120,
                          "png": str(out_dir / f"shop_{m}_{shadow}.png"), "mode": m, "shadow": shadow,
                          "extra": 0, "timeout_ms": 600000})
        for n in extras[1:]:
            shots.append({"query": f"scene=shop&mode=full&shadow={shadow}&extra={n}", "w": 1920, "h": 1080,
                          "bench": 120, "mode": "full", "shadow": shadow, "extra": n, "timeout_ms": 600000})
    return run(shots, "shop")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("assets", nargs="*")
    ap.add_argument("--shop", action="store_true")
    ap.add_argument("--out", type=Path, default=work_root() / "checks")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    if a.assets:
        for r in asset_shots(a.assets, a.out):
            print(r["query"], r.get("stats"), r.get("errors"))
    if a.shop:
        for r in shop_shots(a.out):
            print(r["query"], r.get("stats"), r.get("frame_ms"), r.get("errors"))


if __name__ == "__main__":
    main()
