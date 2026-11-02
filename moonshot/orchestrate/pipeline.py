"""A take, end to end, through the queue: planned, simulated and checked by one job; rendered by another only if every
check passed. Runs on the hub; the jobs show on the dashboard like any other.

    python -m moonshot.orchestrate.pipeline <take> [--part nist-ftc-10 --setup op10] [--no-render]

The take's files and its draft land in the data root's takes/<take>/ as the jobs finish.
"""
from __future__ import annotations

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
    jid = submit("bake_render", {"take": take}, [res["files"]["sim.npz"]], group=take)
    print(f"[pipeline] {take}: every check passed; bake_render job {jid[:12]} queued", flush=True)
    job = wait(jid)
    if job["state"] != "done":
        print(f"[pipeline] {take}: the render failed: {job.get('error')}", flush=True)
        return 1
    collect(job["result"]["files"], take)
    r = job["result"]
    print(f"[pipeline] {take}: rendered {r['frames']} frames at {r['s_per_frame']} s each: "
          f"{data_root() / 'takes' / take / 'draft.mp4'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
