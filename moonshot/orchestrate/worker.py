"""A farm worker: leases jobs from the hub, runs them, reports back. Runs on every machine, the hub included.

    python -m moonshot.orchestrate.worker --name m4-max --kinds blender_bench,probe --blender <path> \
        [--gpu-mem 48] [--device METAL] [--cache-only]

Holds no source of truth (plan §8). Inputs are fetched from the hub by sha256 into a local cache and verified;
results go to an outbox first and are sent when the hub answers, so a Wi-Fi blip or a closed laptop loses
nothing but time. Leases two jobs ahead so a short blip doesn't idle it, and heartbeats while it works.
Stdlib only, apart from what a job's own handler needs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable

from moonshot.config import data_root, hub_url

MOONSHOT = Path(__file__).resolve().parents[1]
Handler = Callable[["Worker", dict, list[Path]], dict]


class HubUnreachable(Exception):
    pass


class Worker:
    def __init__(self, name: str, capabilities: dict, token: str, hub: str, home: Path,
                 handlers: dict[str, Handler], lease_ahead: int = 2, options: dict | None = None):
        self.name, self.capabilities, self.token, self.hub = name, capabilities, token, hub.rstrip("/")
        self.handlers, self.lease_ahead, self.options = handlers, lease_ahead, options or {}
        self.cache, self.outbox = home / "cache", home / "outbox"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.outbox.mkdir(parents=True, exist_ok=True)
        self.held: list[dict] = []
        self.progress: dict[str, dict] = {}              # job id -> what it last reported (report)
        self.lease_s = 120.0
        self._lock = threading.Lock()

    # --- talking to the hub ---

    def _request(self, path: str, body: dict | None = None, timeout: float = 30) -> dict:
        req = urllib.request.Request(self.hub + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.token}",
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, OSError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500:
                raise
            raise HubUnreachable(str(e)) from e

    def fetch(self, digest: str) -> Path:
        """The input with this sha256, from the cache or the hub. A download that doesn't hash right is refused."""
        dest = self.cache / digest
        if dest.exists():
            return dest
        tmp = self.cache / f".{digest}.{uuid.uuid4().hex}.part"
        req = urllib.request.Request(f"{self.hub}/blobs/{digest}", headers={"Authorization": f"Bearer {self.token}"})
        h = hashlib.sha256()
        try:
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    h.update(chunk)
                    f.write(chunk)
        except (urllib.error.URLError, OSError) as e:
            tmp.unlink(missing_ok=True)
            raise HubUnreachable(str(e)) from e
        if h.hexdigest() != digest:
            tmp.unlink(missing_ok=True)
            raise ValueError(f"blob {digest[:12]} arrived with hash {h.hexdigest()[:12]}")
        os.replace(tmp, dest)
        return dest

    def upload(self, path: Path) -> str:
        """Send a result file to the hub's blob store; returns its sha256, the name it goes by from now on."""
        data = Path(path).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        req = urllib.request.Request(f"{self.hub}/blobs", data=data, headers={
            "Authorization": f"Bearer {self.token}", "X-Sha256": digest, "Content-Type": "application/octet-stream"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())["digest"]
        except (urllib.error.URLError, OSError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500:
                raise
            raise HubUnreachable(str(e)) from e

    def cached(self) -> list[str]:
        return [p.name for p in self.cache.iterdir() if len(p.name) == 64]

    # --- the outbox: results survive the hub being away ---

    def _post_result(self, msg: dict) -> None:
        (self.outbox / f"{time.time_ns()}-{msg['job']}.json").write_text(json.dumps(msg))
        self.flush()

    def flush(self) -> int:
        sent = 0
        for p in sorted(self.outbox.glob("*.json")):
            msg = json.loads(p.read_text())
            try:
                self._request("/complete" if msg["op"] == "complete" else "/fail",
                              {"worker": self.name, "job": msg["job"],
                               **({"result": msg["result"]} if msg["op"] == "complete" else {"error": msg["error"]})})
            except HubUnreachable:
                break
            p.unlink()
            sent += 1
        return sent

    # --- the loop ---

    def report(self, job_id: str, stage: str, done: float | None = None, total: float | None = None) -> None:
        """A running job's progress, for the dashboard's ETA: its stage and, where it can count, how far through.
        Sent with the next heartbeat, and at once when the stage changes."""
        with self._lock:
            prev = self.progress.get(job_id, {})
            since = prev["since"] if prev.get("stage") == stage else time.time()
            self.progress[job_id] = {"stage": stage, "done": done, "total": total, "since": since}
        if prev.get("stage") != stage:
            self._beat()

    def _beat(self) -> None:
        with self._lock:
            ids = [j["id"] for j in self.held]
            progress = {j: p for j, p in self.progress.items() if j in ids}
        if ids:
            try:
                self._request("/heartbeat", {"worker": self.name, "jobs": ids, "progress": progress})
            except HubUnreachable:
                pass

    def _heartbeat_loop(self, stop: threading.Event) -> None:
        while not stop.wait(max(5.0, self.lease_s / 6)):
            self._beat()

    def lease(self) -> None:
        want = self.lease_ahead - len(self.held)
        if want <= 0:
            return
        r = self._request("/lease", {"worker": self.name, "capabilities": self.capabilities,
                                     "cached": self.cached(), "max_jobs": want})
        self.lease_s = r.get("lease_s", self.lease_s)
        with self._lock:
            self.held.extend(r["jobs"])

    def run_one(self) -> dict | None:
        """Run the oldest held job. Returns the outbox message, or None if nothing is held."""
        with self._lock:
            if not self.held:
                return None
            job = self.held[0]
        try:
            handler = self.handlers[job["kind"]]
            self.report(job["id"], "starting")
            inputs = [self.fetch(d) for d in job["inputs"]]
            msg = {"op": "complete", "job": job["id"], "result": handler(self, job, inputs)}
        except HubUnreachable:
            return None                                   # keep the job; try again when the hub is back
        except Exception as e:                            # noqa: BLE001 - a job's failure is reported, not fatal
            msg = {"op": "fail", "job": job["id"], "error": f"{type(e).__name__}: {e}"[:2000]}
        with self._lock:
            self.held.remove(job)
            self.progress.pop(job["id"], None)
        self._post_result(msg)
        return msg

    def step(self) -> bool:
        """One pass: send queued results, top up leases, run one job. True if a job ran."""
        try:
            self.flush()
            self.lease()
        except HubUnreachable:
            pass
        return self.run_one() is not None

    def run_forever(self, idle_s: float = 10.0) -> None:
        stop = threading.Event()
        threading.Thread(target=self._heartbeat_loop, args=(stop,), daemon=True).start()
        try:
            while True:
                if not self.step():
                    time.sleep(idle_s)
        finally:
            stop.set()


# --- handlers: one per job kind ---

def noop(worker: Worker, job: dict, inputs: list[Path]) -> dict:
    return {"echo": job["payload"], "inputs": [p.name for p in inputs]}


def probe(worker: Worker, job: dict, inputs: list[Path]) -> dict:
    return {"host": socket.gethostname(), "os": platform.platform(), "python": platform.python_version(),
            "cpus": os.cpu_count(), "capabilities": worker.capabilities}


def blender_bench(worker: Worker, job: dict, inputs: list[Path]) -> dict:
    """Render one frame of the scene pack in inputs[0] and report the time (moonshot/render/blender_bench.py)."""
    blender = worker.options.get("blender")
    if not blender:
        raise RuntimeError("this worker has no --blender")
    p = job["payload"]
    with tempfile.TemporaryDirectory() as tmp:
        scene = Path(tmp) / "scene.blend"
        try:
            os.link(inputs[0], scene)
        except OSError:
            scene.write_bytes(inputs[0].read_bytes())
        report = Path(tmp) / "report.json"
        cmd = [blender, "-b", str(scene), "--python", str(MOONSHOT / "render" / "blender_bench.py"), "--",
               "--device", worker.options.get("device", "METAL"), "--samples", str(p.get("samples", 96)),
               "--res", p.get("res", "1920x1080"), "--out", str(Path(tmp) / "frame.png"), "--report", str(report)]
        t0 = time.perf_counter()
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=p.get("timeout_s", 3600))
        if run.returncode != 0 or not report.exists():
            raise RuntimeError(f"blender exited {run.returncode}: {(run.stderr or run.stdout)[-1500:]}")
        out = json.loads(report.read_text())
        out["wall_s"] = round(time.perf_counter() - t0, 2)
        return out


def _production(name: str) -> Handler:
    """A production job kind (moonshot/orchestrate/jobs.py), imported only when one runs: they need the pipeline's
    heavy dependencies, which this module doesn't."""
    def run(worker: Worker, job: dict, inputs: list[Path]) -> dict:
        from moonshot.orchestrate import jobs
        return getattr(jobs, name)(worker, job, inputs)
    return run


HANDLERS: dict[str, Handler] = {"noop": noop, "probe": probe, "blender_bench": blender_bench,
                                **{k: _production(k) for k in ("vise_take", "bake_render", "skin_bake", "render_frames",
                                                               "encode_frames")}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default=socket.gethostname())
    ap.add_argument("--kinds", default="noop,probe")
    ap.add_argument("--gpu-mem", type=float, default=0)
    ap.add_argument("--cache-only", action="store_true")
    ap.add_argument("--blender")
    ap.add_argument("--trainual", help="trainual's checkout, whose renderer bake_render runs")
    ap.add_argument("--device", default="METAL")
    ap.add_argument("--home", type=Path, default=data_root() / "worker")
    ap.add_argument("--token-file", type=Path, default=data_root() / "queue" / "token")
    a = ap.parse_args()
    caps = {"kinds": a.kinds.split(","), "gpu_mem_gb": a.gpu_mem, "cache_only": a.cache_only, "device": a.device}
    w = Worker(a.name, caps, a.token_file.read_text().strip(), hub_url(), a.home, HANDLERS,
               options={"blender": a.blender, "device": a.device, "trainual": a.trainual})
    print(f"[worker {a.name}] hub {w.hub}, kinds {caps['kinds']}", flush=True)
    w.run_forever()


if __name__ == "__main__":
    main()
