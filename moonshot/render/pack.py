"""What a render job carries, as tars the hub stores by sha256 (moonshot/orchestrate/jobs.py), so a worker needs no
data root: a take's pack (its record, and every GLB its scene names under data/) and the look's (the CC0 textures
and HDRI). Both are built the same way every time, so the same files make the same hash and a worker's cache keeps
them.
"""
from __future__ import annotations

import json
import os
import tarfile
from pathlib import Path

from moonshot.config import data_root
from moonshot.contracts.take_record import files


def _tar(out: Path, members: list[tuple[Path, str]]) -> Path:
    def plain(ti: tarfile.TarInfo) -> tarfile.TarInfo:
        ti.mtime, ti.uid, ti.gid, ti.uname, ti.gname = 0, 0, 0, "", ""
        return ti
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f"{out.name}.{os.getpid()}.part")   # its own: two pipelines may pack the same look at once
    with tarfile.open(tmp, "w", format=tarfile.PAX_FORMAT) as t:
        for path, name in sorted(members, key=lambda m: m[1]):
            t.add(path, arcname=name, filter=plain)
    try:
        tmp.replace(out)
    except PermissionError:                                     # Windows: the other one is replacing it now
        tmp.unlink()
    return out


def take_pack(take: Path, out: Path, data: Path | None = None) -> Path:
    """The take record and, under data/, every GLB its scene names (paths under the data root)."""
    take, data = Path(take), Path(data or data_root())
    scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
    glbs = sorted({g["path"] for b in scene["bodies"].values() for g in b.get("glbs", [])})
    return _tar(Path(out), [(take / f, f) for f in files(take)] + [(data / p, f"data/{p}") for p in glbs])


def look_pack(out: Path, data: Path | None = None) -> Path:
    cc0 = Path(data or data_root()) / "cc0"
    return _tar(Path(out), [(p, p.relative_to(cc0).as_posix()) for p in cc0.rglob("*") if p.is_file()])


def unpack(tar: Path, dest: Path) -> Path:
    """The tar's files in dest, extracted once."""
    dest = Path(dest)
    if not dest.exists():
        tmp = dest.with_name(dest.name + ".part")
        with tarfile.open(tar) as t:
            t.extractall(tmp, filter="data")
        tmp.replace(dest)
    return dest
