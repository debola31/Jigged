"""A take's tool holders and cutters drawn again by the fixed placement, without running it again.

Where a take draws a CAT40 holder or a cutter is written into its scene.json when its run is exported: every body's
`glbs` entries, each with its `in_body` placement. Before 2026-11-06 those entries placed the library's GLBs, which are
stored Y up, unturned, so every take drew its holders and their tools lying on their side (moonshot/world/tooling.py
Y_UP). redraw() rewrites only those entries' in_body from the fixed code (tooling.glb_entry), each keeping its place
along the body's axis, its record and physics as they were, and notes it in take.json's "redrawn":

    python -m moonshot.sim.tool_redraw <take> ...     (each a folder under the data root's takes/)
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

from moonshot.config import data_root
from moonshot.world import tooling as TL

WHY = "the tool GLBs stood up along their holders' axes (stored Y up, they were drawn lying on their side)"


def is_tool_glb(path: str) -> bool:
    """A holder's or a cutter's GLB: the library's, or a take's own stand-in cutter (moonshot/sim/cycle_take.py)."""
    return path.startswith("library/tooling/") or Path(path).name.startswith("cutter_")


def redraw(folder: Path) -> list[str]:
    """The take's tool GLB entries placed again (tooling.glb_entry); returns the bodies whose entries changed. A take
    already drawn so is left as it is, and nothing is noted."""
    folder = Path(folder)
    scene = json.loads((folder / "scene.json").read_text(encoding="utf-8"))
    changed = []
    for name, body in scene.get("bodies", {}).items():
        moved = False
        for e in body.get("glbs", []):
            if not is_tool_glb(e["path"]):
                continue
            at = list(e["in_body"][:3])
            fixed = at + TL.glb_entry(e["path"], at[2])["in_body"][3:]
            if [round(float(v), 7) for v in e["in_body"]] != [round(float(v), 7) for v in fixed]:
                e["in_body"], moved = fixed, True
        if moved:
            changed.append(name)
    if changed:
        (folder / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
        tk_path = folder / "take.json"
        if tk_path.exists():
            tk = json.loads(tk_path.read_text(encoding="utf-8"))
            tk.setdefault("redrawn", []).append({"what": "tool GLBs", "why": WHY, "bodies": changed,
                                                 "on": date.today().isoformat(), "by": "moonshot.sim.tool_redraw"})
            tk_path.write_text(json.dumps(tk, indent=1), encoding="utf-8")
    return changed


if __name__ == "__main__":
    for name in sys.argv[1:]:
        print(name, "redrawn:", redraw(data_root() / "takes" / name) or "nothing to change", flush=True)
