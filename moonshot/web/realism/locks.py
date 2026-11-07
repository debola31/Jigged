"""Locks shared by every worker on this PC, in their separate worktrees: a directory made with mkdir, which the OS
creates atomically, so exactly one worker holds it.

    <data>/web/gpu-lock.d     one GPU job at a time (Cycles bakes, Workbench pictures, the page-side check)
    <data>/realism/tiles-lock.d   one writer of the shared tile library at a time

Inside, owner.json says who holds it and since when. A lock older than STALE_S is a crashed worker's: it is moved
aside (an atomic rename, so two waiters can't both break it) and removed. Release removes it only if it is still
ours. The GPU lock is taken only while <data>/web/gpu-hold is absent: another session sets that to measure frame
times on an idle GPU.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from moonshot.web.realism.paths import gpu_hold, web_root, work_root

POLL_S = 20.0
HOLD_POLL_S = 30.0
STALE_S = 60 * 60


def gpu_lock_dir() -> Path:
    return web_root() / "gpu-lock.d"


def tiles_lock_dir() -> Path:
    return work_root() / "tiles-lock.d"


def _started(lock: Path) -> float:
    try:
        return float(json.loads((lock / "owner.json").read_text())["started_epoch"])
    except (OSError, ValueError, KeyError):
        return lock.stat().st_mtime                     # made but not yet written: as old as the directory


def _break_if_stale(lock: Path) -> bool:
    try:
        if time.time() - _started(lock) <= STALE_S:
            return False
        aside = lock.with_name(f"{lock.name}.stale-{uuid.uuid4().hex[:8]}")
        os.rename(lock, aside)                           # only one waiter's rename can succeed
    except OSError:
        return False
    print(f"[lock] {lock} was stale: broken", flush=True)
    shutil.rmtree(aside, ignore_errors=True)
    return True


@contextmanager
def dir_lock(lock: Path, job: str, hold: Path | None = None):
    """Hold `lock` for the duration; yields the seconds spent waiting for it (and for `hold` to go)."""
    t0 = time.perf_counter()
    token = uuid.uuid4().hex
    lock.parent.mkdir(parents=True, exist_ok=True)
    said = False
    while True:
        if hold is not None and hold.exists():
            print(f"[lock] {hold} exists: waiting", flush=True)
            time.sleep(HOLD_POLL_S)
            continue
        try:
            lock.mkdir()
        except FileExistsError:
            if not _break_if_stale(lock):
                if not said:
                    print(f"[lock] {lock} is held ({_owner(lock)}): waiting", flush=True)
                    said = True
                time.sleep(POLL_S)
            continue
        (lock / "owner.json").write_text(json.dumps({
            "token": token, "job": job, "host": socket.gethostname(), "pid": os.getpid(), "cwd": os.getcwd(),
            "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "started_epoch": time.time()}))
        break
    try:
        yield time.perf_counter() - t0
    finally:
        if _owner(lock).get("token") == token:
            shutil.rmtree(lock, ignore_errors=True)
        else:
            print(f"[lock] {lock} is no longer ours (broken as stale?): left alone", flush=True)


def _owner(lock: Path) -> dict:
    try:
        return json.loads((lock / "owner.json").read_text())
    except (OSError, ValueError):
        return {}


def gpu(job: str):
    """One GPU job at a time across the PC's workers, and none while gpu-hold exists."""
    return dir_lock(gpu_lock_dir(), job, hold=gpu_hold())


def tiles(job: str):
    return dir_lock(tiles_lock_dir(), job)
