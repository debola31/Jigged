"""A take, end to end, through the queue: planned, simulated and checked by one job; rendered by another only if every
check passed. Runs on the hub; the jobs show on the dashboard like any other.

    python -m moonshot.orchestrate.pipeline <take> [--part nist-ftc-10 --setup op10] [--no-render]
    python -m moonshot.orchestrate.pipeline <take> --render-only [--final]

The take's files and its draft land in the data root's takes/<take>/ as the jobs finish. A render is split: the skin
baked once, then frame ranges any GPU takes, then joined on the hub, so every machine works on the same take.
--final renders at 1080p and 96 samples instead of the draft's 960x540 and 32.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
import urllib.request

from moonshot.config import data_root, hub_url
from moonshot.orchestrate.hub import blob_dir, queue_dir, token_for
from moonshot.orchestrate.queue import Queue


def submit(kind: str, payload: dict, inputs: list[str], group: str) -> str:
    root = data_root()
    req = urllib.request.Request(hub_url() + "/jobs", data=json.dumps(
        {"kind": kind, "payload": payload, "inputs": inputs, "group": group}).encode(), headers={
        "Authorization": f"Bearer {token_for(root)}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["id"]


def wait(job_id: str, poll_s: float = 15.0) -> dict:
    q = Queue(queue_dir(data_root()) / "queue.db")
    try:
        while True:
            job = q.get(job_id)
            if job["state"] in ("done", "failed"):
                return job
            time.sleep(poll_s)
    finally:
        q.close()


def collect(files: dict[str, str], take: str) -> None:
    dest = data_root() / "takes" / take
    dest.mkdir(parents=True, exist_ok=True)
    for name, digest in files.items():
        shutil.copyfile(blob_dir(data_root()) / digest, dest / name)


def main(argv: list[str]) -> int:
    take = argv[0]
    opt = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None   # noqa: E731
    if "--render-only" in argv:
        return render(take, stored(data_root() / "takes" / take / "sim.npz"), final="--final" in argv)
    payload = {"take": take} | ({"part": opt("--part"), "setup": opt("--setup")} if opt("--part") else {})
    jid = submit("vise_take", payload, [], group=take)
    print(f"[pipeline] {take}: vise_take job {jid[:12]} queued", flush=True)
    job = wait(jid)
    if job["state"] != "done":
        print(f"[pipeline] {take}: the take failed: {job.get('error')}", flush=True)
        return 1
    res = job["result"]
    collect(res["files"], take)
    for name, c in res["checks"].items():
        print(f"[pipeline] {take}: {name}: {c}", flush=True)
    if not res["passed"]:
        print(f"[pipeline] {take}: a check failed, so it isn't rendered", flush=True)
        return 1
    if "--no-render" in argv:
        return 0
    return render(take, res["files"]["sim.npz"], final=False)


def stored(path) -> str:
    """The file's sha256, put in the hub's blob store if it isn't there."""
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if not (blob_dir(data_root()) / digest).exists():
        shutil.copyfile(path, blob_dir(data_root()) / digest)
    return digest


def render(take: str, sim: str, final: bool, chunk: int = 48) -> int:
    quality = {"res": "1920x1080", "samples": 96} if final else {"res": "960x540", "samples": 32}
    name = "final" if final else "draft"
    group = f"{take}-{name}"
    t0 = time.time()
    bake = wait(submit("skin_bake", {"take": take}, [sim], group=group))
    if bake["state"] != "done":
        print(f"[pipeline] {take}: the bake failed: {bake.get('error')}", flush=True)
        return 1
    import numpy as np
    n = len(np.load(blob_dir(data_root()) / sim)["t"])
    ids = [submit("render_frames", {"take": take, "frames": [lo, min(lo + chunk, n)]} | quality,
                  [sim, bake["result"]["bake"]], group=group) for lo in range(0, n, chunk)]
    print(f"[pipeline] {take}: baked; {n} frames in {len(ids)} ranges queued ({name})", flush=True)
    parts = [wait(j) for j in ids]
    if failed := [j for j in parts if j["state"] != "done"]:
        print(f"[pipeline] {take}: {len(failed)} ranges failed: {failed[0].get('error')}", flush=True)
        return 1
    enc = wait(submit("encode_frames", {"take": take, "fps": 24, "name": name},
                      [j["result"]["png"] for j in parts], group=group))
    if enc["state"] != "done":
        print(f"[pipeline] {take}: the encode failed: {enc.get('error')}", flush=True)
        return 1
    collect(enc["result"]["files"], take)
    by = {}
    for j in parts:
        w = by.setdefault(j["worker"], [0, 0.0])
        w[0] += j["result"]["frames"][1] - j["result"]["frames"][0]
        w[1] += j["result"]["render_s"]
    rates = ", ".join(f"{w} {f} frames at {s / f:.1f} s" for w, (f, s) in sorted(by.items()))
    print(f"[pipeline] {take}: {n} frames in {(time.time() - t0) / 60:.0f} min ({rates}): "
          f"{data_root() / 'takes' / take / (name + '.mp4')}", flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
