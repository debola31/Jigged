"""The physics of closing the doors and starting the cycle, and of opening the doors (moonshot/motion/door_cycle.py):
the VF-2 cell with the part in the vise; the doors are passive slides with friction and damping, so only the hands
move them, and Cycle Start registers from the index's force on the button (vf2.Control.touch).

Each hand holds its door's bar wrapped round it (motion/door_cycle.py), so contact alone moves the door either way:
opening, the fingers behind the bar draw it out; closing, the palm on its outer face pushes it home. No constraint
holds a hand to a bar. The arm is fed what moving the door along its planned path takes (its friction, its track's
damping and its inertia), where the hand meets the bar, and more as the door trails its path, as people lean into a
door that is slow to move.

The run writes, beside the take record, checks.json (per frame, what the arms touch, each hand's wrench, the active
constraints and the bodies pushed from outside the physics, the VF-2's axes; the never-held E-stop) and the vise's
keys in sim.npz, which moonshot/validate/take.py reads.

    python -m moonshot.sim.door_cycle           # runs the three takes in the data root and writes their records
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import mujoco
import numpy as np

from moonshot.motion import door_cycle as DC
from moonshot.motion.primitives import min_jerk
from moonshot.sim.record import glbs_in_bodies, hand_wrench
from moonshot.sim.runner import SIDES, TakeRunner
from moonshot.world import cell, vf2
from moonshot.world import vise as V

PROGRAM = [(cell.LOAD_X_MM, y, 0.0, 1000.0) for y in (60.0, 0.0) * 6]   # the first moves, slow to show it runs
DOORS = ("door_left", "door_right")
NEVER_HELD = ["vf2_estop"]      # pressing it would stop the machine (as moonshot/sim/pendant.py's)
LAG_N_PER_MM, LAG_MAX_N = 0.5, 25.0     # a hand leans into a door trailing its path: this much more per mm, at most


def clamped_home(load: V.Load) -> np.ndarray:
    return np.array([V.VISE["x"], V.VISE["fixed_face_y"] - load.half[1],
                     V.VISE["seat_z"] + load.parallel_h + load.half[2]])


class _Cell(TakeRunner):
    station = "vf2"
    doors_open_mm = 0.0
    never_held = NEVER_HELD

    def __init__(self, folder):
        super().__init__(folder)
        self.checks = {k: [] for k in ("touching", "hand_wrench", "hand_wrench_L", "active_constraints",
                                       "applied_forces")}
        self.checks["machine_axes"] = {f"vf2_{a}": [] for a in ("x", "y", "z", "spindle")}
        self.vise = {k: [] for k in ("blank", "para", "opening")}

    def scene(self, body_xml: str) -> str:
        load = V.REFERENCE
        return cell.with_body(body_xml, clamped_home(load), load.parallels(), "R_hand", load)

    def start(self) -> None:
        """The table at the loading spot, the doors as the step finds them, the jaw closed on the part and locked."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in DOORS:
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001
        load = V.REFERENCE
        jaw = (load.opening0 - load.size[1] - 0.1) * 0.001
        lead = m.eq_data[m.equality("lead_screw").id, 1]
        crank = jaw / lead
        d.qpos[m.jnt_qposadr[m.joint("jaw_slide").id]] = jaw
        d.qpos[m.jnt_qposadr[m.joint("crank").id]] = crank
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0] = crank
        d.eq_active[lock] = 1

    def before_step(self, t: float) -> None:
        self.ctl.apply()

    def glbs(self):
        out = glbs_in_bodies(self.model, "vf2", vf2.render_links())
        for body, entries in V.render_glbs().items():
            out.setdefault(body, []).extend(entries)
        return out

    def meshes(self, folder):
        return V.render_meshes(V.REFERENCE, folder)

    def on_frame(self, k: int) -> None:
        self.record_checks()

    def touched(self) -> list[str]:
        """Everything either arm touches this frame but the person, by geom name."""
        m, d = self.model, self.data
        arms = self.side_bodies["R"] | self.side_bodies["L"]
        out = set()
        for i in range(d.ncon):
            g1, g2 = d.contact[i].geom1, d.contact[i].geom2
            for a, b in ((g1, g2), (g2, g1)):
                if m.geom_bodyid[a] in arms and m.body(m.geom_bodyid[b]).name not in self.person:
                    out.add(m.geom(b).name)
        return sorted(out)

    def record_checks(self) -> None:
        """This frame of what the per-frame checks read that the take record doesn't carry (as the vise take's
        export_sim): what the arms touch, each hand's wrench (the left's in the mirrored world, as sim.npz has the
        left arm), the active constraints and the bodies pushed from outside the physics, the VF-2's axes; and the
        vise's part, parallels and jaw opening, sim.npz's vise keys."""
        m, d, c = self.model, self.data, self.checks
        c["touching"].append(self.touched())
        c["hand_wrench"].append(hand_wrench(m, d, "R_hand"))
        f, tq = np.array(hand_wrench(m, d, "L_hand")).reshape(2, 3)
        c["hand_wrench_L"].append([-f[0], f[1], f[2], tq[0], -tq[1], -tq[2]])      # a reflection in x
        c["active_constraints"].append([m.equality(i).name for i in range(m.neq) if d.eq_active[i]])
        c["applied_forces"].append([m.body(b).name for b in range(m.nbody) if d.xfrc_applied[b].any()])
        for a in ("x", "y", "z"):
            c["machine_axes"][f"vf2_{a}"].append(round(float(d.qpos[self.ctl.q[a]]) * 1000, 4))
        spindle = m.jnt_dofadr[m.joint("vf2_spindle").id]
        c["machine_axes"]["vf2_spindle"].append(round(float(d.qvel[spindle]) * 60 / (2 * math.pi), 1))
        self.vise["blank"].append(d.body("blank").xpos * 1000)
        self.vise["para"].append(np.array([d.body(p).xpos * 1000 for p in ("para_a", "para_b")]))
        jaw = d.qpos[m.jnt_qposadr[m.joint("jaw_slide").id]]
        self.vise["opening"].append(V.REFERENCE.opening0 - jaw * 1000)

    def export(self, folder: Path | None = None) -> None:
        """The take record and sim.npz (TakeRunner.export); with the frames record_checks kept, also the vise's keys
        in sim.npz and checks.json, which moonshot/validate/take.py reads. Nothing is lifted, so load_N is empty."""
        folder = Path(folder or self.folder)
        super().export(folder)
        if not self.checks["touching"]:
            return
        sim = dict(np.load(folder / "sim.npz"))
        np.savez(folder / "sim.npz", **sim, **{k: np.array(v) for k, v in self.vise.items()})
        (folder / "checks.json").write_text(json.dumps(self.checks | {"load_N": {}, "never_held": self.never_held}),
                                            encoding="utf-8")

    def force_on(self, geom: str) -> dict[str, float]:
        """Each hand's normal force on a geom now (N)."""
        m, d = self.model, self.data
        g, f, c6 = m.geom(geom).id, {s: 0.0 for s in SIDES}, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            if g in (c.geom1, c.geom2):
                other = m.body(m.geom_bodyid[c.geom2 if c.geom1 == g else c.geom1]).name
                if other[:2] in ("R_", "L_"):
                    mujoco.mj_contactForce(m, d, i, c6)
                    f[other[0]] += abs(c6[0])
        return f


class DoorClose(_Cell):
    """Closing, the palm on the bar's outer face pushes it along: contact alone moves the door."""
    doors_open_mm = DC.OPEN_MM
    grip_geoms = {"door_left": "vf2_door_left_pull", "door_right": "vf2_door_right_pull",
                  "open_left": "vf2_door_left_pull", "open_right": "vf2_door_right_pull"}
    encloses: dict[str, str] = {}
    # the door's load acts where the hand meets the bar, round its middle, not at the wrist: the wrist is fed its
    # torque too, where unfed it gave 18 deg under the pull and the replayed arm's ECU went past its maximum
    HAND_FORCE_AT = DC.wrap_frame().T @ -np.array([DC.WRAP_OUT, -DC.WRAP_BACK, DC.WRAP_UP])

    def __init__(self, folder=DC.TAKES / "door-close"):
        super().__init__(folder)
        m = self.model
        self.door_mm = {k: [] for k in DOORS}
        self.force = {k: {s: [] for s in SIDES} for k in DOORS}       # along the door's planned travel, N
        self.pulls = {e["side"]: e for e in self.tk["events"] if e["kind"] == "pull_door"}
        rec = vf2.record()
        self.door_kg = {k: rec["links"][k]["mass_kg"] for k in DOORS}
        dof = {k: m.jnt_dofadr[m.joint(f"vf2_{k}").id] for k in DOORS}
        self.door_friction = {k: float(m.dof_frictionloss[dof[k]]) for k in DOORS}
        self.door_damping = {k: float(m.dof_damping[dof[k]]) for k in DOORS}
        pull = {k: np.array(rec["affordances"][f"{k}_handle"]["pull"], float) for k in DOORS}
        # which way each door moves in this take (world), from its planned path
        self.door_dir = {e["door"]: pull[e["door"]] * np.sign(e["to_mm"] - e["from_mm"]) for e in self.pulls.values()}
        self.door_body = {k: m.body(f"vf2_{k}").id for k in DOORS}
        self.enclose_eq = {e["grip"]: m.equality(f"enclose_{e['grip']}").id for e in self.grip_events}

    def hand_force(self, side, t):
        """What it takes to move the door along its planned path (minimum jerk): its friction, its track's damping at
        the planned speed and the force that accelerates it; once the path has run the door home, the friction's
        worth into its stop. And as the door trails its path, LAG_N_PER_MM more, up to LAG_MAX_N, while the hand is on
        it (a hand that has come off the bar doesn't lean on air). A door is slowed by its friction, so the hand never
        pulls it back."""
        e = self.pulls.get(side)
        if e is None or not e["t0"] <= t < e["t1"]:
            return None
        door, T = e["door"], e["move_s"]
        x = min(1.0, (t - e["t0"]) / T)
        L = abs(e["to_mm"] - e["from_mm"]) * 0.001
        v = L * (30 * x ** 2 - 60 * x ** 3 + 30 * x ** 4) / T
        acc = L * (60 * x - 180 * x ** 2 + 120 * x ** 3) / T ** 2
        f = self.door_friction[door] + self.door_damping[door] * v + self.door_kg[door] * acc
        if self.on_door(side, door):
            planned = e["from_mm"] + (e["to_mm"] - e["from_mm"]) * min_jerk(x)
            lag = (planned - self.data.qpos[self.ctl.q[door]] * 1000) * np.sign(e["to_mm"] - e["from_mm"])
            f += min(LAG_MAX_N, LAG_N_PER_MM * max(0.0, lag))
        return self.door_dir[door] * max(0.0, f)

    def on_door(self, side: str, door: str) -> bool:
        """Is the side's hand on the door now: touching it, or held to its bar by the grip's constraint?"""
        m, d, body = self.model, self.data, self.door_body[door]
        held = (e for e in self.grip_events if e["side"] == side and self.encloses[e["grip"]] == f"vf2_{door}")
        if any(d.eq_active[self.enclose_eq[e["grip"]]] for e in held):
            return True
        mine = self.side_bodies[side]
        for i in range(d.ncon):
            b1, b2 = m.geom_bodyid[d.contact[i].geom1], m.geom_bodyid[d.contact[i].geom2]
            if (b1 == body and b2 in mine) or (b2 == body and b1 in mine):
                return True
        return False

    def force_along(self, door: str) -> dict[str, float]:
        """Each side's force on the door now along the way the take moves it (N): its contacts with the door's panel
        and bar, and the grip's constraint holding a hand to the bar."""
        m, d = self.model, self.data
        u, body, c6 = self.door_dir.get(door, np.zeros(3)), self.door_body[door], np.zeros(6)
        out = {s: 0.0 for s in SIDES}
        for i in range(d.ncon):
            c = d.contact[i]
            b1, b2 = m.geom_bodyid[c.geom1], m.geom_bodyid[c.geom2]
            if body not in (b1, b2):
                continue
            other = b2 if b1 == body else b1
            side = next((s for s in SIDES if other in self.side_bodies[s]), None)
            if side is None:
                continue
            mujoco.mj_contactForce(m, d, i, c6)
            fw = c.frame.reshape(3, 3).T @ c6[:3]                  # on geom2
            out[side] += float((fw if b2 == body else -fw) @ u)
        for e in self.grip_events:
            eq = self.enclose_eq[e["grip"]]
            if self.encloses[e["grip"]] == f"vf2_{door}" and d.eq_active[eq]:
                rows = [i for i in range(d.nefc) if d.efc_type[i] == mujoco.mjtConstraint.mjCNSTR_EQUALITY
                        and d.efc_id[i] == eq]
                out[e["side"]] += float(d.efc_force[rows] @ u)       # on body1, the door
        return out

    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        for door in DOORS:
            self.door_mm[door].append(float(self.data.qpos[self.ctl.q[door]] * 1000))
            for s, f in self.force_along(door).items():
                self.force[door][s].append(f)

    def outcome(self) -> dict:
        """Where the doors start and end (mm open), which hand pushed each one along most, and that hand's peak
        and median force along its door's travel while the door moved."""
        own = {e["door"]: e["side"] for e in self.pulls.values()}
        moving = {k: [abs(b - a) * self.fps > 1.0 for a, b in zip(v, v[1:])] for k, v in self.door_mm.items()}
        return {"door_open_mm_start": {k: round(v[0], 1) for k, v in self.door_mm.items()},
                "door_open_mm_end": {k: round(v[-1], 1) for k, v in self.door_mm.items()},
                "pulled_by": {k: max(SIDES, key=lambda s: sum(max(0.0, x) for x in f[s])) for k, f in self.force.items()},
                "hand_force_N_max": {k: round(max(f[own[k]]), 1) for k, f in self.force.items() if k in own},
                "hand_force_N_median_moving": {
                    k: round(float(np.median([x for x, mv in zip(f[own[k]][1:], moving[k]) if mv] or [0.0])), 1)
                    for k, f in self.force.items() if k in own}}


class DoorOpen(DoorClose):
    """Opening, the fingers behind the bar draw it out: contact alone moves the door."""
    doors_open_mm = 0.0

    def __init__(self, folder=DC.TAKES / "door-open"):
        super().__init__(folder)


class CycleStart(_Cell):
    grip_geoms = {"cycle_start": "vf2_cycle_start_button"}
    RELEASE_N = 0.5                 # a button lets go below this, well under its actuation force,
    DEBOUNCE_S = 0.05               # and only once it has stayed below it this long, as controls debounce a switch

    def __init__(self, folder=DC.TAKES / "cycle-start"):
        super().__init__(folder)
        self.press_N: list[float] = []
        self.held, self.light_since = False, None

    def start(self) -> None:
        super().start()
        self.ctl.program = list(PROGRAM)

    def before_step(self, t: float) -> None:
        f = self.force_on("vf2_cycle_start_button")["R"]
        act = self.ctl.actuation
        if f >= act:
            self.held, self.light_since = True, None
        elif self.held and f <= self.RELEASE_N:
            self.light_since = t if self.light_since is None else self.light_since
            self.held = t - self.light_since < self.DEBOUNCE_S
        elif self.held:
            self.light_since = None
        self.ctl.touch({"cycle_start": max(f, act) if self.held else min(f, act * 0.99)})
        self.press_N.append(f)
        super().before_step(t)

    def outcome(self) -> dict:
        return {"events": list(self.ctl.events), "state": self.ctl.state, "press_N_max": round(max(self.press_N), 1)}


def main(argv: list[str]) -> int:
    for cls, name in ((DoorClose, "door-close"), (CycleStart, "cycle-start"), (DoorOpen, "door-open")):
        r = cls(DC.TAKES / name)
        r.run(log=print)
        r.export()
        out = r.outcome()
        (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
