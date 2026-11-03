"""Load the tools (moonshot/motion/tool_load.py) run in MuJoCo, on the pendant's runner (moonshot/sim/pendant.py): the
part clamped in the vise as the setting takes have it, the tool stand on the table, the carousel's holders in
their pockets, and the VF-2's drawbar (moonshot/world/vf2.py SPINDLE_BORE) reading its Tool Release button.

- A seat take: the holder a free body in its fork on the stand. The right hand closes on its body under the flange,
  and from then until the drawbar holds it the hand carries it by the declared grip assist `carry_holder`, a stiff weld
  where the holder sits in the hand as the fingers close (as the inspection bench's tools, moonshot/world/bench_cell.py;
  capsule fingers can't keep a 1.25 in body steady in a wrap), its skin and the holder not colliding meanwhile (the
  weld stands for their contact); it lifts the holder off the tines, slides it out and carries it in under the
  spindle, watching it (the hand's correction by sight is on the holder's planned path, as the blow-off take's is on
  the gun's, until the push starts), with its weight fed forward through the arm; then pushes it up into the bore
  while the left index holds the head's button (a held press: it keeps pushing once the button clicks, sim/pendant.py),
  and the drawbar's fingers, open while it is held, close under the knob when it is let go. Then the weld lets go, and
  only the drawbar holds the holder.
- A tool change take (00-change, NN-atc): keys at the pendant, the holder in the spindle part of it (it is clamped
  there), nothing loose. The changer's own motion isn't simulated: the machine counts the change (world/vf2.py
  Control.tool_change) and the next take starts from the carousel it leaves, across the cut.

    python -m moonshot.sim.tool_load nist-ftc-10 op50-tools [take]    # runs each take (or one) and writes its record

Writes beside each take record: checks.json (as the pendant's, and touching_R, the holder's load_N and weight_N, which
the grasp checks read) and outcome.json (the machine's pocket table and key presses; for a seat, where the holder
ended in the spindle and what holds it). moonshot/tests/gates/test_setting_takes.py reads them.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion.primitives import min_jerk
from moonshot.sim.pendant import PendantRunner
from moonshot.sim.runner import RELEASE_S
from moonshot.world import tooling as TL
from moonshot.world import vise as V
from moonshot.world.vise import Load

G = 9.81


class ToolLoadRun(PendantRunner):
    grip_geoms = {"dial": "vf2_jog_handle", "holder": "holder_body"}

    def __init__(self, folder: Path):
        super().__init__(folder)
        m, ld = self.model, self.tk["load"]
        self.kind = ld["kind"]
        c = self.machine
        c.pockets = {int(p): t for p, t in ld["pockets"].items()}
        c.current, c.spindle_tool = int(ld["current"]), ld["spindle"]
        c.mode = self.tk["setup"].get("mode", "")
        self.loose = m.body("holder").id if self.kind == "seat" else None
        self.holder_geoms = {g for g in range(m.ngeom) if self.loose is not None and m.geom_bodyid[g] == self.loose}
        self.right = {g for g in self.hand_geoms if m.geom(g).name.startswith("R_")}
        self.knob = m.geom("holder_knob_head").id if self.loose is not None else None
        self.finger_geoms = {m.geom(f"vf2_finger_{k}").id for k in range(3)}
        self.finger_q = [m.jnt_qposadr[m.joint(f"vf2_finger_{k}").id] for k in range(3)]
        self.spindle = m.body("vf2_spindle").id
        ev = {e["kind"]: e for e in self.tk["events"]}
        self.grip, self.carry, self.seat_ev = ev.get("grip"), ev.get("carry"), ev.get("seat")
        self.path = [(k[0], np.array(k[1:], float)) for k in ld.get("path", [])]
        self.kg = TL.holder_kg(ld["tool"]) if self.kind == "seat" else 0.0
        self.rec |= {"holder": [], "holder_quat": [], "load_N": [], "touching_R": [], "fingers": [], "clamp_N": [],
                     "released": []}
        self.weld = m.equality("carry_holder").id if self.loose is not None else None
        self._apart_on = False
        self.holder_kg_model = float(m.body_subtreemass[self.loose]) if self.loose is not None else 0.0

    # --- the scene --------------------------------------------------------------------------------------------------
    def scene(self, body_xml: str) -> str:
        xml = super().scene(body_xml)
        ld = self.tk["load"]
        n = len(self.tk["step"]["facts"]["tool_ids"])
        stand = {int(k): t for k, t in ld["stand"].items()}
        add = ""
        if ld["kind"] == "seat":
            add += TL.holder_body("holder", ld["tool"], TL.on_stand(ld["fork"]))
            stand.pop(ld["fork"])
        add += TL.stand_xml(n, stand)
        add += TL.carousel_xml({int(p): t for p, t in ld["pockets"].items() if t != "probe"}, int(ld["current"]))
        xml = xml.replace("<worldbody>\n", "<worldbody>\n" + add, 1)
        if ld["kind"] == "seat":                   # the carry's grip assist, switched by before_step
            xml = xml.replace("<equality>\n", '<equality>\n    <weld name="carry_holder" body1="holder" body2="R_hand" '
                              'active="false" solref="0.004 1" solimp="0.9 0.95 0.002"/>\n', 1)
        if ld["kind"] == "atc":                    # the holder clamped in the spindle, part of it until the change
            gauge = '<geom name="vf2_spindle_gauge" type="cylinder" size="0.022 0.005" contype="0" conaffinity="0" mass="5"/>'
            assert gauge in xml
            xml = xml.replace(gauge, gauge + f'<body name="holder">{TL.holder_geoms("holder", ld["tool"], collide=False)}'
                              f'</body>', 1)
        return xml

    def glbs(self) -> dict[str, list[dict]]:
        out = super().glbs()
        for body, drawn in V.render_glbs().items():
            out.setdefault(body, []).extend(drawn)
        ld = self.tk["load"]
        if ld["kind"] in ("seat", "atc"):
            out["holder"] = TL.render_glbs(ld["tool"])
        for k, t in ld["stand"].items():
            if not (ld["kind"] == "seat" and int(k) == ld["fork"]):
                out[f"stand_holder_{k}"] = TL.render_glbs(t)
        for p, t in ld["pockets"].items():
            if t != "probe":
                out[f"pocket_{p}"] = TL.render_glbs(t)
        return out

    def meshes(self, folder: Path) -> dict[str, dict]:
        return V.render_meshes(Load.from_json(self.tk["setup"]["load"]), folder)

    # --- the hand and the holder ------------------------------------------------------------------------------------
    def planned_holder(self, t: float) -> np.ndarray:
        """The holder's gauge line where the plan has it at t (mm, world)."""
        p = self.path[0][1]
        for (t0, a), (t1, b) in zip(self.path, self.path[1:]):
            if t >= t0:
                p = a + (b - a) * min_jerk((t - t0) / max(t1 - t0, 1e-9))
        return p

    def at(self, t: float):
        self._t = t                                # the plan's time this step, for what reads it without being given it
        return super().at(t)

    def carrying(self, t: float) -> bool:
        return self.carry is not None and self.carry["t0"] <= t < self.carry["t1"]

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """While the right hand carries the holder in, before the push: the eye on the holder's planned path."""
        if side != "R" or self.loose is None or not (self.carry["t0"] <= t < self.seat_ev["t0"]):
            return None
        m, d, p = self.model, self.data, self.plan
        hb = m.body("R_hand").id
        Rp, Ra = p.xmat[hb].reshape(3, 3), d.xmat[hb].reshape(3, 3)
        return np.r_[self.planned_holder(t) * 0.001 - d.xpos[self.loose], Rotation.from_matrix(Rp @ Ra.T).as_rotvec()]

    def touching(self, side: str) -> bool:
        """As the runner's, but the holder the right hand reaches for and carries in isn't a contact to stop
        correcting at: the hand closes on it where the plan has it (else the carry weld locks in a hand 30 mm off its
        grip, which then wedges the holder in its fork), and it is what the hand is steered by, until the push starts
        and the bore takes it."""
        t = getattr(self, "_t", 0.0)
        if side == "R" and self.loose is not None and self.grip and self.grip["t0"] - 0.6 <= t < self.seat_ev["t0"]:
            m, d = self.model, self.data
            mine = self.side_bodies[side]
            for i in range(d.ncon):
                b1, b2 = m.geom_bodyid[d.contact[i].geom1], m.geom_bodyid[d.contact[i].geom2]
                if (b1 in mine) != (b2 in mine) and (b2 if b1 in mine else b1) != self.loose:
                    return True
            return False
        return super().touching(side)

    def hand_force(self, side: str, t: float) -> np.ndarray | None:
        """The holder's weight while it is carried, as people anticipate a load they know."""
        if side == "R" and self.carrying(t):
            return np.array([0.0, 0.0, self.kg * G])
        return None

    def forces_on(self, geoms: set, by: set) -> np.ndarray:
        """The world force (N) the `by` geoms put on the `geoms` geoms, summed over their contacts."""
        m, d, f6, F = self.model, self.data, np.zeros(6), np.zeros(3)
        for i in range(d.ncon):
            c = d.contact[i]
            if c.geom2 in geoms and c.geom1 in by:
                sign = 1.0
            elif c.geom1 in geoms and c.geom2 in by:
                sign = -1.0
            else:
                continue
            mujoco.mj_contactForce(m, d, i, f6)
            F += sign * (c.frame.reshape(3, 3).T @ f6[:3])
        return F

    def carry_weld(self, t: float) -> None:
        """carry_holder on from just after the fingers close to when the drawbar has the holder, holding it where it
        sits in the hand then, so switching it on moves nothing; the hand's skin and the holder apart while it's on and
        until the hand is well off it (the runner's RELEASE_S)."""
        m, d = self.model, self.data
        want = self.carry["t0"] <= t < self.carry["t1"]
        if want and not d.eq_active[self.weld]:
            hb = m.body("R_hand").id
            Ro, Rh = d.xmat[self.loose].reshape(3, 3), d.xmat[hb].reshape(3, 3)
            m.eq_data[self.weld, 0:3] = 0.0
            m.eq_data[self.weld, 3:6] = Ro.T @ (d.xpos[hb] - d.xpos[self.loose])
            qr = np.zeros(4)
            mujoco.mju_mat2Quat(qr, np.ascontiguousarray(Ro.T @ Rh).reshape(-1))
            m.eq_data[self.weld, 6:10] = qr
            d.eq_active[self.weld] = 1
        elif not want and d.eq_active[self.weld]:
            d.eq_active[self.weld] = 0
        apart = self.carry["t0"] <= t < self.carry["t1"] + RELEASE_S
        if apart != self._apart_on:
            self.hold_apart(self.loose, 1 if apart else 0)
            self._apart_on = apart

    def before_step(self, t: float) -> None:
        if self.loose is not None:
            self.carry_weld(t)
        super().before_step(t)
        if (self.loose is not None and self.machine.spindle_tool is None and t >= self.seat_ev["t0"]
                and self._steps % 10 == 0 and self.seated()["clamped"]):
            self.machine.spindle_tool = self.tk["load"]["tool"]      # the machine now holds what the hand put in

    def lift_N(self) -> float:
        """The upward force the hand puts on the holder (N): through its contacts and the carry weld alike, from the
        holder's own motion, m (a + g), less what everything else (the stand, the bore, the drawbar) pushes on it."""
        m, d = self.model, self.data
        dof = m.jnt_dofadr[m.body_jntadr[self.loose]]
        others = set(range(m.ngeom)) - self.hand_geoms - self.holder_geoms
        return float(self.holder_kg_model * (d.qacc[dof + 2] + G) - self.forces_on(self.holder_geoms, others)[2])

    def seated(self) -> dict:
        """Where the loose holder is against the spindle's gauge point, and what holds it."""
        d = self.data
        rel = (d.xpos[self.loose] - d.xpos[self.spindle]) * 1000
        R = d.xmat[self.loose].reshape(3, 3)
        clamp = float(np.linalg.norm(self.forces_on({self.knob}, self.finger_geoms))) if self.knob is not None else 0.0
        return {"offset_mm": float(np.hypot(*rel[:2])), "s_mm": float(rel[2]),
                "tilt_deg": float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))), "clamp_N": clamp,
                "clamped": clamp > 1.0 and not self.machine.tool_release_held()}

    # --- each frame --------------------------------------------------------------------------------------------------
    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        m, d = self.model, self.data
        touching = set()
        for i in range(d.ncon):
            pair = {d.contact[i].geom1, d.contact[i].geom2}
            if pair & self.right and len(pair - self.hand_geoms) == 1:
                touching.add(m.geom((pair - self.hand_geoms).pop()).name)
        self.rec["touching_R"].append(sorted(touching))
        self.rec["fingers"].append([round(float(d.qpos[a]), 4) for a in self.finger_q])
        self.rec["released"].append(self.machine.tool_release_held())
        if self.loose is not None:
            self.rec["holder"].append((d.xpos[self.loose] * 1000).round(3).tolist())
            self.rec["holder_quat"].append(d.xquat[self.loose].round(6).tolist())
            self.rec["load_N"].append(round(self.lift_N(), 3))
            self.rec["clamp_N"].append(round(self.seated()["clamp_N"], 3))

    def outcome(self) -> dict:
        c = self.machine
        out = super().outcome() | {"kind": self.kind, "pockets": {str(p): t for p, t in sorted(c.pockets.items())},
                                   "current": c.current, "spindle_tool": c.spindle_tool, "changes": c.changes}
        rel = [i for i, r in enumerate(self.rec["released"]) if r]
        out["tool_release_held_s"] = [round(rel[0] / self.fps, 3), round(rel[-1] / self.fps, 3)] if rel else None
        if self.loose is not None:
            s = self.seated()
            tail = self.rec["touching_R"][-int(0.5 * self.fps):]
            out["seated"] = {k: round(v, 3) if isinstance(v, float) else v for k, v in s.items()} | {
                "hand_off_s": not any(any(n.startswith("holder") for n in t) for t in tail),
                "lifted_mm": round(float(max(h[2] for h in self.rec["holder"]) - self.rec["holder"][0][2]), 2)}
        return out

    def export(self, folder: Path | None = None) -> None:
        super().export(folder)
        folder = Path(folder or self.folder)
        ck = json.loads((folder / "checks.json").read_text(encoding="utf-8"))
        ck["touching_R"] = self.rec["touching_R"]
        if self.loose is not None:
            ck |= {"load_N": {"holder": self.rec["load_N"]}, "weight_N": {"holder": round(self.kg * G, 3)},
                   "clamp_N": self.rec["clamp_N"]}
        (folder / "checks.json").write_text(json.dumps(ck), encoding="utf-8")


def takes(part: str, step_id: str) -> list[Path]:
    root = data_root() / "takes" / part / step_id
    return sorted(p for p in root.iterdir() if (p / "take.json").exists() and (p / "reference.npz").exists())


def main(argv: list[str]) -> int:
    part, step_id = argv[0], argv[1]
    only = argv[2] if len(argv) > 2 else None
    for folder in takes(part, step_id):
        if only and folder.name != only:
            continue
        run = ToolLoadRun(folder)
        run.run(log=None)
        run.export(folder)
        out = run.outcome()
        print(folder.name, json.dumps({k: out[k] for k in ("pressed", "pockets", "current", "spindle_tool")
                                       if k in out} | ({"seated": out["seated"]} if "seated" in out else {})), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
