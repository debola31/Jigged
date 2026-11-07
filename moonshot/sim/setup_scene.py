"""A per-setup take's table at the VF-2 (take.json "scene", moonshot/motion/loads.py scene_spec; routed by
moonshot/planning/takes.py per_setup): what every runner of the cell's takes run per setup (the doors and Cycle Start,
the blow-off, setting the parallels or the stop, loosening the vise) builds for a part other than nist-ftc-10, whose
takes keep the reference load (moonshot/world/vise.py REFERENCE).

- A vise setup, clamped (its start and its unload): the setup's part on its parallels, or on the vise's floor
  against its stop, where moonshot/motion/loads.py part_pose stands it, the jaw closed on it to 0.1 mm and the screw
  locked, as the vise take leaves it (the setting session's runner, moonshot/sim/pendant.py, and the tool takes,
  moonshot/sim/tool_load.py, build the same vise from setting.part_in_vise).
- A vise setup, open (its clean): the vise open at the load's opening, the parallels free in their rack
  (moonshot/world/parallel_rack.py) or the stop free on the table where it waits (vise.STOP_HOME), and the part
  waiting on the table right of the vise (Load.stage), as setting them finds it (moonshot/sim/set_parallels.py,
  set_stop.py).
- A vise setup, set (its load's start, for its still: moonshot/sim/step_still.py): as open, but the parallels on the
  seat, or the stop on the floor, where they were set; or placed (its seat's start): the part set down on them too,
  where it is clamped, the jaw still open. Each held where it stands by the vise scene's keepers, as the load take
  finds them.
- A plate setup: the plate on its spoilboard under its clamps (moonshot/motion/plates.py; nist-ftc-09's on its
  riser), held to the table by the declared `clamped` weld, as the setting session holds it. Its clamps are clamped
  on it, or with scene "clamps": "parked" slid back off it and tipped onto the spoilboard, their nuts run up, as the
  plate lies before they are set and once they are loosened (moonshot/world/spoilboard.py; for a step's still).

The part is drawn as the cutting simulation (moonshot/sim/cycle_take.py) has it: entering the setup ("in"), the
setup's first cycle's stock at its first frame; leaving it ("out"), its last cycle's last stock. Each GLB is in the
part's model frame (its STEP's); the cycle's blank stands at part_pose's origin turned R, so moved into this take's
blank, the box part_pose centres (it carries no turn), a model point p is at R (p - envelope's middle). Its physics
is that box, as every vise take's. A setup none of whose cycles has run yet draws the finished part if it has one, else
the box (vise.render_meshes). A plate is drawn from its geoms, as the plates' own takes draw it; a step's still draws
it from its stock (Table.part_mesh), as the cutting simulation has it.

The part's mesh is written into the take's folder when its run is exported, so the render draws the stock as it was
then. When a setup's stock comes later (ll-1007224 op30's, drawn finished until the cutting simulation hands it the
part as op20 leaves it), its takes are drawn again from it without running them again: the physics is the box's.

    python -m moonshot.sim.setup_scene ll-1007224-op30-door-close ...     # each take's part drawn from its stock now
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import mujoco
import numpy as np

from moonshot.config import data_root
from moonshot.motion import plates
from moonshot.motion.loads import part_pose
from moonshot.planning.validate import load_plan
from moonshot.sim.record import glbs_in_bodies
from moonshot.world import cell, vf2
from moonshot.world import parallel_rack as RACK
from moonshot.world import spoilboard as SB
from moonshot.world import vise as V

JAW_GAP_MM = 0.1            # the jaw stands this far off the part, as the door takes' start (sim/door_cycle.py)


class Table:
    """The table a per-setup take finds (the module's doc), from its take.json: "scene" and, for a vise, "load"."""

    def __init__(self, tk: dict):
        s = tk["scene"]
        self.part, self.setup, self.stock_at = s["part"], s["setup"], s["stock"]
        self.plan = load_plan(self.part)
        self.is_plate, self.vise = bool(s["plate"]), s.get("vise")
        self.pose = part_pose(self.plan, self.setup)
        if self.is_plate:
            self.plate, self.clamps = plates.plate(self.part, self.setup, self.plan), plates.clamps(self.part, self.setup,
                                                                                                    self.plan)
            self.clamp_state = s.get("clamps", "clamped")
            self.load = None
        else:
            self.load = V.Load.from_json(tk["load"])
            self.centre = np.asarray(self.pose["centre_mm"], float)

    @property
    def open(self) -> bool:
        return self.vise == "open"

    @property
    def jaw_open(self) -> bool:
        """Is the jaw open at the load's opening (the clean, the load's and the seat's start)?"""
        return self.vise in ("open", "set", "placed")

    def parallels(self) -> dict[str, np.ndarray]:
        """Each parallel's base centre: on the vise's seat, or standing in its slot in the rack when the vise is open."""
        return RACK.slots(self.load) if self.open else self.load.parallels()

    def stop(self) -> np.ndarray | None:
        """The stop's base centre, for a part stood on the vise's floor: beside the part, or where it waits."""
        if self.load.stop() is None:
            return None
        return V.STOP_HOME if self.open else self.load.stop()

    # --- the scene ---------------------------------------------------------------------------------------------
    def xml(self, body_xml: str, hand_body: str = "R_hand") -> str:
        """The body model's MJCF with the cell and what is on the table."""
        if self.is_plate:
            xml = SB.with_body(body_xml, self.plate, self.clamps, self.clamp_state)
            c = " ".join(f"{v / 1000:.7f}" for v in self.plate.centre)
            # as the setting session's (sim/pendant.py): near-rigid, as stiff as the step allows
            return xml.replace("<equality>\n", '<equality>\n    <weld name="clamped" body1="blank" body2="vf2_table" '
                               f'anchor="{c}" relpose="0 0 0 1 0 0 0" solref="0.002 1" '
                               'solimp="0.99 0.999 0.001"/>\n', 1)
        at = self.load.stage if self.vise in ("open", "set") else self.centre
        xml = cell.with_body(body_xml, at, self.parallels(), hand_body, self.load, stop_mm=self.stop())
        return xml.replace("<worldbody>\n", "<worldbody>\n" + RACK.xml(), 1) if self.jaw_open else xml

    def start(self, m: mujoco.MjModel, d: mujoco.MjData) -> None:
        """Before the take: the jaw closed on the part and locked, or locked open at the load's opening with the
        parallels (or the stop) free where they wait, turned as they stand there. A plate's weld holds it as built."""
        if self.is_plate:
            return
        lock = m.equality("screw_lock").id
        if self.open:
            m.eq_data[lock, 0] = d.qpos[m.jnt_qposadr[m.joint("crank").id]]
            d.eq_active[lock] = 1
            for n in self.load.parallels_y:            # the keepers hold them in the vise for the load take
                d.eq_active[m.equality(f"keep_{n}").id] = 0
                a = m.jnt_qposadr[m.joint(n).id]
                d.qpos[a + 3:a + 7] = [np.cos(RACK.YAW / 2), 0.0, 0.0, np.sin(RACK.YAW / 2)]
            if self.stop() is not None:
                d.eq_active[m.equality("keep_stop").id] = 0
                a = m.jnt_qposadr[m.joint("stop").id]
                d.qpos[a + 3:a + 7] = [np.cos(RACK.YAW / 2), 0.0, 0.0, np.sin(RACK.YAW / 2)]
            mujoco.mj_forward(m, d)
            return
        if self.jaw_open:                                # set or placed: locked open, the keepers holding what is set
            m.eq_data[lock, 0] = d.qpos[m.jnt_qposadr[m.joint("crank").id]]
            d.eq_active[lock] = 1
            mujoco.mj_forward(m, d)
            return
        jaw = (self.load.opening0 - self.load.size[1] - JAW_GAP_MM) * 0.001
        crank = jaw / m.eq_data[m.equality("lead_screw").id, 1]
        d.qpos[m.jnt_qposadr[m.joint("jaw_slide").id]] = jaw
        d.qpos[m.jnt_qposadr[m.joint("crank").id]] = crank
        m.eq_data[lock, 0] = crank
        d.eq_active[lock] = 1
        mujoco.mj_forward(m, d)

    # --- what the record draws ---------------------------------------------------------------------------------
    def glbs(self, model: mujoco.MjModel) -> dict[str, list[dict]]:
        out = glbs_in_bodies(model, "vf2", vf2.render_links())
        if not self.is_plate:                            # the D688, as the vise takes draw it
            for body, entries in V.render_glbs().items():
                out.setdefault(body, []).extend(entries)
        return out

    def stock_glb(self) -> Path | None:
        """The cutting simulation's stock GLB the part is drawn from (the module's doc), or None if none has run."""
        takes = data_root() / "takes"
        setup = next(s for s in self.plan["setups"] if s["id"] == self.setup)
        runs = [takes / f"{self.part}-{self.setup}-{o['id']}" / "stock" for o in setup["operations"]]
        runs = [r for r in runs if any(r.glob("*.glb"))]
        if not runs:
            return None
        run = runs[0] if self.stock_at == "in" else runs[-1]
        frames = sorted(int(p.stem) for p in run.glob("*.glb") if re.fullmatch(r"\d+", p.stem))
        return run / f"{frames[0] if self.stock_at == 'in' else frames[-1]}.glb"

    def meshes(self, folder: Path) -> dict[str, dict]:
        """The parallels (and stop) as boxes at the load's size, and the part as its stock (stock_glb), each written
        into the take's folder; a plate, nothing (drawn from its geoms). A setup none of whose cycles has run yet draws
        the finished part (parts/<part>/finished.glb, the STEP in metres: moonshot/library/bench_links.py), its holes
        and all, if the part has one; else the box."""
        if self.is_plate:
            return {}
        return V.render_meshes(self.load, folder) | self.part_mesh(folder)

    def part_mesh(self, folder: Path) -> dict[str, dict]:
        """The part's mesh (meshes' doc), written into the take's folder as its blank's: {} where there is none, the
        box drawn instead."""
        src, scale = self.stock_glb(), 1.0
        if src is None:
            src, scale = data_root() / "parts" / self.part / "finished.glb", 1000.0
            if not src.exists():
                return {}
        import trimesh
        mesh = trimesh.load(src, force="mesh")
        mesh.apply_scale(scale)
        R, mid = np.asarray(self.pose["R"], float), np.asarray(self.pose["envelope_mm"], float).mean(1)
        T = np.eye(4)
        T[:3, :3], T[:3, 3] = R, -R @ mid
        mesh.apply_transform(T)
        (Path(folder) / "blank").mkdir(parents=True, exist_ok=True)
        mesh.export(Path(folder) / "blank" / "0.glb")
        return {"blank": {"dir": "blank", "frames": [0]}}


def redraw(folder: Path) -> Path | None:
    """A per-setup take's part drawn again from the stock as it is now (Table.meshes), its record and physics as
    they were; returns the stock GLB it is drawn from (None: the finished part or the box)."""
    tk = json.loads((Path(folder) / "take.json").read_text(encoding="utf-8"))
    table = Table(tk)
    table.meshes(Path(folder))
    return table.stock_glb()


if __name__ == "__main__":
    for name in sys.argv[1:]:
        print(name, "drawn from", redraw(data_root() / "takes" / name) or "the finished part", flush=True)
