"""A take, end to end, through the queue: planned, simulated and checked by one job; rendered by another only if every
check passed. Runs on the hub; the jobs show on the dashboard like any other.

    python -m moonshot.orchestrate.pipeline <take> [--part nist-ftc-10 --setup op10] [--lift-out] [--no-render]
    python -m moonshot.orchestrate.pipeline <take> --render-only [--final] [--trainual]
    python -m moonshot.orchestrate.pipeline <part> --assemble [--final]
    python -m moonshot.orchestrate.pipeline <take> --still

The take's files and its draft land in the data root's takes/<take>/ as the jobs finish. A render is split: the skin
baked once, then frame ranges any GPU takes, then joined on the hub, so every machine works on the same take. It
draws the take record at 24 fps with moonshot's renderer (moonshot/render/), or with --trainual the sim.npz at the
take's own rate with trainual's scripts. A take whose checks pass renders its final straight away, at 720p, with no
draft before it (your decision, 2026-11-04: nist-ftc-10 on the web tonight, its backlog's drafts taken as approved);
--render-only renders a draft (960x540) unless --final.

--still renders one 1080p picture of a machine-only step's take, its last frame, close on the part from in front and
above, nothing blurred: the web shows it in place of a video (your decision, 2026-11-03: the machine's own work isn't
rendered as video). --assemble makes each step's video of a part, from its takes' videos, for every step whose takes all have one
(moonshot/render/step_video.py): drafts, or finals with --final.
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

DRAFT = {"res": "960x540", "samples": 32}
FINAL = {"res": "1280x720", "samples": 48}               # tuned: moonshot/render/render_take.py settings(); 720p, not
                                                          # 1080p, so nist-ftc-10's 31,000 frames fit a night (your
                                                          # decision, 2026-11-04)


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
        (dest / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(blob_dir(data_root()) / digest, dest / name)


def main(argv: list[str]) -> int:
    take = argv[0]
    opt = lambda flag: argv[argv.index(flag) + 1] if flag in argv else None   # noqa: E731
    if "--render-only" in argv:
        return render(take, final="--final" in argv, trainual="--trainual" in argv)
    if "--still" in argv:
        return still(take)
    if "--assemble" in argv:
        from moonshot.render.step_video import assemble
        state = assemble(take, "final" if "--final" in argv else "draft")
        for sid, s in state.items():
            print(f"[pipeline] {take}-{sid}: {s}", flush=True)
        print(f"[pipeline] {take}: {sum(s != 'waiting' for s in state.values())} of {len(state)} steps have videos",
              flush=True)
        return 0
    payload = {"take": take} | ({"part": opt("--part"), "setup": opt("--setup")} if opt("--part") else {})
    if "--lift-out" in argv:                      # the unload's last take: the part lifted out of the loosened vise
        payload["start"] = "vise"
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
    return render(take, final=True)


def stored(path) -> str:
    """The file's sha256, put in the hub's blob store if it isn't there."""
    for attempt in range(20):
        try:
            data = open(path, "rb").read()
            break
        except PermissionError:          # Windows: another pipeline is replacing the same pack (pack.py _tar) this moment
            if attempt == 19:
                raise
            time.sleep(0.25)
    digest = hashlib.sha256(data).hexdigest()
    if not (blob_dir(data_root()) / digest).exists():
        shutil.copyfile(path, blob_dir(data_root()) / digest)
    return digest


STILL_FROM_MM = (120.0, -330.0, 230.0)                    # the camera from the part: in front, a little right, above


def still(take: str) -> int:
    """One picture of the take's last frame, close on the part (its blank), at final quality: takes/<take>/still.png."""
    import io
    import tarfile

    import numpy as np
    from moonshot.render.pack import look_pack, take_pack
    folder = data_root() / "takes" / take
    rec = np.load(folder / "take.npz")
    part = rec["pos"][-1, [str(b) for b in rec["bodies"]].index("blank")]
    camera = {"eye": (part + STILL_FROM_MM).round(1).tolist(), "look": part.round(1).tolist()}
    packs = data_root() / "packs" / "render"
    pack = stored(take_pack(folder, packs / f"{take}.tar"))
    look = stored(look_pack(packs / "look.tar"))
    bake = wait(submit("take_bake", {"take": take}, [pack], group=f"{take}-still"))
    if bake["state"] != "done":
        print(f"[pipeline] {take}: the bake failed: {bake.get('error')}", flush=True)
        return 1
    n = bake["result"]["frames"]
    job = wait(submit("take_render", {"take": take, "frames": [n - 1, n], "camera": camera, "res": FINAL["res"],
                                      "samples": 2 * FINAL["samples"]}, [pack, bake["result"]["bake"], look],
                      group=f"{take}-still"))
    if job["state"] != "done":
        print(f"[pipeline] {take}: the still failed: {job.get('error')}", flush=True)
        return 1
    with tarfile.open(fileobj=io.BytesIO((blob_dir(data_root()) / job["result"]["png"]).read_bytes())) as tar:
        png = next(m for m in tar.getmembers() if m.name.endswith(".png"))
        (folder / "still.png").write_bytes(tar.extractfile(png).read())
    print(f"[pipeline] {take}: still -> {folder / 'still.png'}", flush=True)
    return 0


def render(take: str, final: bool, trainual: bool = False, chunk: int = 48) -> int:
    folder = data_root() / "takes" / take
    if trainual:
        quality = {"res": "1920x1080", "samples": 96} if final else {"res": "960x540", "samples": 32}
    else:
        quality = FINAL if final else DRAFT
    name = "final" if final else "draft"
    group = f"{take}-{name}"
    t0 = time.time()
    if trainual:
        sim = stored(folder / "sim.npz")
        bake = wait(submit("skin_bake", {"take": take}, [sim], group=group))
    else:
        from moonshot.render.pack import look_pack, take_pack
        packs = data_root() / "packs" / "render"
        pack = stored(take_pack(folder, packs / f"{take}.tar"))
        look = stored(look_pack(packs / "look.tar"))
        bake = wait(submit("take_bake", {"take": take}, [pack], group=group))
    if bake["state"] != "done":
        print(f"[pipeline] {take}: the bake failed: {bake.get('error')}", flush=True)
        return 1
    if trainual:
        import numpy as np
        motion = np.load(blob_dir(data_root()) / sim)
        n, fps = len(motion["t"]), int(motion["fps"])
        kind, inputs = "render_frames", [sim, bake["result"]["bake"]]
    else:
        n, fps = bake["result"]["frames"], 24
        kind, inputs = "take_render", [pack, bake["result"]["bake"], look]
    ids = [submit(kind, {"take": take, "frames": [lo, min(lo + chunk, n)]} | quality, inputs, group=group)
           for lo in range(0, n, chunk)]
    print(f"[pipeline] {take}: baked; {n} frames in {len(ids)} ranges queued ({name})", flush=True)
    parts = [wait(j) for j in ids]
    if failed := [j for j in parts if j["state"] != "done"]:
        print(f"[pipeline] {take}: {len(failed)} ranges failed: {failed[0].get('error')}", flush=True)
        return 1
    enc = wait(submit("encode_frames", {"take": take, "fps": fps, "name": name},
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
