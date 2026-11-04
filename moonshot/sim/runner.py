"""A two-handed take's plan (moonshot/motion/step_take.py) run in MuJoCo: the body tracks it on both arms, and each
hand squeezes what it grips. What every step's physics has in common; a step adds its scene and its events.

Each motor gets the planned position, with the planned motion's own torques fed forward (rigid-body inverse
dynamics, as moonshot/body/controller.py's `track`), so the body follows the plan within its strength. A hand with
effort on a grip pushes its pads into the grip's object (the vise take's squeeze, per hand: each pad's joint
direction from its Jacobian) and stiffens, as people co-contract while they work (Gribble et al. 2003); a load the
step knows its hand meets (`hand_force`) is fed forward through the arm; and a steady error in where a hand is, in
place and turn, is corrected slowly, as by sight (`correction`, as the vise take's).

A step subclasses TakeRunner: `scene(body_xml)` returns the MJCF with its station and objects, `grip_geoms` names
each grip's object geom, `before_step(t)` runs the machine's control and the step's own logic, and `station`,
`glbs()` say what the take record draws. `run()` returns the per-frame record and writes nothing; `export(folder)`
writes the take record (moonshot/contracts/take_record.py).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import mujoco
import numpy as np
from scipy.interpolate import CubicSpline
from scipy.spatial.transform import Rotation

from moonshot.body.skeleton import H0, build
from moonshot.motion import kinematics as BM
from moonshot.sim.record import Recorder
from moonshot.sim.reference import ARM as REF_ARM

SIDES = ("R", "L")
ARM = ["sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev", "sc_prot", "sc_elev"]
TRUNK = ["trunk_flex", "trunk_lat", "trunk_rot"]
PAD = {"thumb": "dis1", "index": "dis2", "middle": "dis3", "ring": "dis4", "little": "dis5"}
SQUEEZE_DEG = 5.5          # as the vise take's (moonshot/sim/vise_take.py)
STIFFEN = 4.0
STIFFEN_ARM = 3.0
SETTLE_STEPS = 300


FIST_MM = np.array([70.0, 0.0, -20.0])     # the middle of a closed fist, in the hand frame (long, radial, dorsal)
APPROACH_S = 0.4                           # a welded tool and the hand stop colliding this long before the grip closes
RELEASE_S = 1.2                            # ... and start again this long after it opens, once the hand is off it: at
                                           # once, the fingers inside the handle threw the gun out of its holster;
                                           # at 0.6 s the retreating fingers dragged it back out
# people correct a steady error in where their hand is by sight, slowly (as the vise take, moonshot/sim/vise_take.py)
VISUAL_TAU = 0.25                          # s
VISUAL_MAX = np.array([0.08, 0.5])         # at most this far (m) and this much turn (rad)
DAMPING = 0.02                             # damped least squares for the arm's wrist corrections


class TakeRunner:
    station = ""
    grip_geoms: dict[str, str] = {}
    # grips whose object the closed hand holds by a declared soft constraint, as the vise take does the crank's knob:
    # the capsule fingers can't conform to it. grip -> the held body; welded grips also hold its orientation (a tool
    # held in the fist), the rest only its place (a knob spins in the fist; a door's bar turns with its door)
    encloses: dict[str, str] = {}
    welded: set[str] = set()
    controls: set[str] = set()               # a welded tool's geoms the fingers still touch (its trigger)
    # where hand_force acts, in the hand frame (long, radial, dorsal; mm from the wrist): None, at the wrist, so the
    # arm is fed it but the wrist isn't; a point on the hand, so the wrist is fed the torque the force makes about it
    HAND_FORCE_AT: np.ndarray | None = None

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.tk = json.loads((self.folder / "take.json").read_text(encoding="utf-8"))
        self.rd = np.load(self.folder / "reference.npz")
        self.lumbar = np.array(self.tk["lumbar"], float)
        self.body = build(pelvis_mm=tuple(self.lumbar))
        self.grip_events = [e for e in self.tk["events"] if e["kind"] == "grip" and e.get("grip") in self.encloses]
        xml = self.scene(self.body.xml)
        # a held tool is stiff in the hand (4 ms, 4 steps): at 20 ms the index's push on the gun's trigger moved the gun
        # 30 mm in the hand, enough to miss its holster's bore; a held mechanism's knob or bar stays soft
        eq = "".join(f'    <{"weld" if e["grip"] in self.welded else "connect"} name="enclose_{e["grip"]}" '
                     f'body1="{self.encloses[e["grip"]]}" body2="{e["side"]}_hand" anchor="0 0 0" active="false" '
                     f'solref="{0.004 if e["grip"] in self.welded else 0.02} 1" solimp="0.9 0.95 0.002"/>\n'
                     for e in {e["grip"]: e for e in self.grip_events}.values())
        xml = xml.replace("<equality>\n", "<equality>\n" + eq, 1)
        m = self.model = mujoco.MjModel.from_xml_string(xml)
        self.data, self.plan = mujoco.MjData(m), mujoco.MjData(m)
        self.fps, self.t = int(self.rd["fps"]), self.rd["t"]
        self.names = [str(x) for x in self.rd["names"]]
        th = self.rd["theta"]
        cols = {n: th[:, i] for i, n in enumerate(TRUNK)}
        cols |= {f"R_{n}": th[:, 3 + i] for i, n in enumerate(ARM)} | {f"L_{n}": th[:, 12 + i] for i, n in enumerate(ARM)}
        cols |= {f"{s}_{n}": self.rd[f"{s}_q"][:, i] for s in SIDES for i, n in enumerate(self.names)}
        cols |= {f"pelvis_{a}": self.rd["dp"][:, i] for i, a in enumerate("xyz")}
        self.splines = []
        for name, values in cols.items():
            j = self.body.joints[name]
            q = np.radians(values - j.rest) if j.kind == "hinge" else (values - j.rest) / 1000
            self.splines.append((m.jnt_qposadr[m.joint(name).id], m.jnt_dofadr[m.joint(name).id], CubicSpline(self.t, q)))
        body_joints = {m.joint(n).id for n in self.body.joints}
        self.acts = np.array([a for a in range(m.nu) if m.actuator_trnid[a, 0] in body_joints])
        jid = m.actuator_trnid[self.acts, 0]
        self.act_dof, self.act_q = m.jnt_dofadr[jid], m.jnt_qposadr[jid]
        self.kp0 = m.actuator_gainprm[self.acts, 0].copy()
        self.kv = -m.actuator_biasprm[self.acts, 2].copy()
        act_names = [m.actuator(a).name[2:] for a in self.acts]
        self.hand_acts = {s: np.array([i for i, n in enumerate(act_names) if n.startswith(f"{s}_") and n[2:] not in ARM],
                                      dtype=int) for s in SIDES}
        self.arm_acts = {s: np.array([i for i, n in enumerate(act_names) if n[2:] in ARM and n.startswith(f"{s}_")],
                                     dtype=int) for s in SIDES}
        self.digit_dofs = {s: {dg: [m.jnt_dofadr[j] for j in range(m.njnt) if m.joint(j).name.startswith(f"{s}_{dg}_")]
                               for dg in PAD} for s in SIDES}
        self.body_q = np.array([m.jnt_qposadr[m.joint(n).id] for n in self.body.joints])
        self.body_dof = np.array([m.jnt_dofadr[m.joint(n).id] for n in self.body.joints])
        root = m.body_rootid[m.body("R_hand").id]
        self.person = {m.body(b).name for b in range(1, m.nbody) if m.body_rootid[b] == root}
        self.squeeze: dict[tuple[str, str], dict] = {}
        self._held_apart: dict[str, int] = {}
        self._apart: dict[int, dict] = {}
        self.arm_dofs = {s: np.array([m.jnt_dofadr[m.joint(f"{s}_{n}").id] for n in ARM]) for s in SIDES}
        self.side_bodies = {s: {b for b in range(m.nbody) if m.body(b).name.startswith(f"{s}_")} for s in SIDES}
        self.visual = {s: np.zeros(6) for s in SIDES}
        self._touch, self._steps = {s: False for s in SIDES}, 0

    # --- for a step to fill in ---------------------------------------------------------------------------
    def scene(self, body_xml: str) -> str:
        return body_xml

    def start(self) -> None:
        """The scene's state before the take starts (the body is already at its first pose)."""

    def before_step(self, t: float) -> None:
        pass

    def on_frame(self, k: int) -> None:
        pass

    def glbs(self) -> dict[str, list[dict]]:
        return {}

    def meshes(self, folder: Path) -> dict[str, dict]:
        """Bodies drawn from meshes the step writes into the take's folder (take_record.py "meshes")."""
        return {}

    def planned_relpose(self, grip: str):
        """For a welded grip: the hand body's pose in the object's frame as the grip plans it (metres, rotation),
        so the weld holds the object where the grip puts it in the hand, not wherever the hand happens to be when the
        fingers close, as the vise take holds the knob. None: hold it as it is."""
        return None

    def hand_force(self, side: str, t: float) -> np.ndarray | None:
        """The force (N, world) the step expects this hand to exert on what it works at t: fed forward through the
        arm, as people anticipate a load they know (a door's friction and weight)."""
        return None

    # --- the plan --------------------------------------------------------------------------------------
    def at(self, t: float):
        m = self.model
        q, v, a = np.zeros(m.nq), np.zeros(m.nv), np.zeros(m.nv)
        for qadr, dof, s in self.splines:
            q[qadr], v[dof], a[dof] = s(t), s(t, 1), s(t, 2)
        return q, v, a

    def effort(self, side: str, t: float) -> tuple[float, str]:
        k = min(len(self.t) - 1, int(round(t * self.fps)))
        return float(self.rd[f"{side}_effort"][k]), str(self.rd[f"{side}_grip"][k])

    def squeeze_dirs(self, side: str, grip: str) -> dict[str, np.ndarray]:
        """Per digit near the grip's object: the unit joint direction that drives its pad into it."""
        m, d = self.model, self.data
        obj, ft, out = m.geom(self.grip_geoms[grip]).id, np.zeros(6), {}
        for dg, seg in PAD.items():
            g = m.geom(f"{side}_g_{seg}").id
            dist = mujoco.mj_geomDistance(m, d, g, obj, 0.025, ft)
            if dist >= 0.025:
                continue
            n = (ft[3:] - ft[:3]) * (1.0 if dist >= 0 else -1.0)
            n /= np.linalg.norm(n) + 1e-12
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, ft[:3], m.geom_bodyid[g])
            v = np.zeros(m.nv)
            idx = self.digit_dofs[side][dg]
            v[idx] = jacp[:, idx].T @ n
            if np.linalg.norm(v) > 0:
                out[dg] = v / np.linalg.norm(v)
        return out

    def enclose(self, t: float) -> None:
        """Hold each enclosing grip's object in the hand from just after the fingers close to just before they open,
        where the fist is when it closes: no jump at the start."""
        m, d = self.model, self.data
        for e in self.grip_events:
            if e["grip"] in self.welded:                 # apart from the final approach on, so the hand reaches its grip
                # 1: held, the controls still touched; 2: letting go, the controls too (the index inside the trigger
                # when the gun is let go fired it out of its holster at 1500 N)
                mode = (2 if t >= e["t1"] - 0.05 else 1) if e["t0"] - APPROACH_S <= t < e["t1"] + RELEASE_S else 0
                ob = m.body(self.encloses[e["grip"]]).id
                if mode != self._held_apart.get(e["grip"], 0):
                    self.hold_apart(ob, mode)
                    self._held_apart[e["grip"]] = mode
            eq = m.equality(f"enclose_{e['grip']}").id
            want = e["t0"] + 0.1 <= t < e["t1"] - 0.05
            if want and not d.eq_active[eq]:
                hb, ob = m.body(f"{e['side']}_hand").id, m.body(self.encloses[e["grip"]]).id
                Rh = d.xmat[hb].reshape(3, 3) @ H0
                P = d.xpos[hb] + Rh @ FIST_MM * 0.001
                Ro, Rb = d.xmat[ob].reshape(3, 3), d.xmat[hb].reshape(3, 3)
                if e["grip"] in self.welded:            # the hand's pose in the object's frame: as planned, or as now
                    rel = self.planned_relpose(e["grip"])
                    p_rel, R_rel = rel if rel is not None else (Ro.T @ (d.xpos[hb] - d.xpos[ob]), Ro.T @ Rb)
                    m.eq_data[eq, 0:3] = 0.0                # at the hand's origin: then relpose is the hand's pose
                    m.eq_data[eq, 3:6] = p_rel
                    qr = np.zeros(4)
                    mujoco.mju_mat2Quat(qr, np.ascontiguousarray(R_rel).reshape(-1))
                    m.eq_data[eq, 6:10] = qr
                else:
                    m.eq_data[eq, 0:3] = Ro.T @ (P - d.xpos[ob])
                    m.eq_data[eq, 3:6] = Rb.T @ (P - d.xpos[hb])
                d.eq_active[eq] = 1
            elif not want and d.eq_active[eq]:
                d.eq_active[eq] = 0

    def hold_apart(self, body: int, mode: int) -> None:
        """While a welded grip holds a tool (mode 1), the hand's skin and the tool don't collide (the constraint stands
        for their contact), except the tool's controls (a trigger) the fingers work; while the hand lets go (mode 2),
        not the controls either; the tool still collides with everything else. Mode 0: as the scene has them."""
        m = self.model
        for g, (ct, ca) in self._apart.pop(body, {}).items():
            m.geom_contype[g], m.geom_conaffinity[g] = ct, ca
        if mode:
            gs = [g for g in range(m.ngeom) if m.geom_bodyid[g] == body
                  and (mode == 2 or m.geom(g).name not in self.controls)]
            self._apart[body] = {g: (m.geom_contype[g], m.geom_conaffinity[g]) for g in gs}
            m.geom_contype[gs], m.geom_conaffinity[gs] = 4, 1          # skin is contype 2, conaffinity 1

    def step(self, t: float) -> None:
        m, d, p = self.model, self.data, self.plan
        if self.grip_events:
            self.enclose(t)
        q, v, a = self.at(min(t, float(self.t[-1])))
        p.qpos[:] = d.qpos
        p.qpos[self.body_q] = q[self.body_q]
        p.qvel[:], p.qacc[:] = 0, 0
        p.qvel[self.body_dof], p.qacc[self.body_dof] = v[self.body_dof], a[self.body_dof]
        flags = m.opt.disableflags
        m.opt.disableflags = flags | int(mujoco.mjtDisableBit.mjDSBL_CONSTRAINT)
        mujoco.mj_inverse(m, p)
        m.opt.disableflags = flags
        tau = p.qfrc_inverse[self.act_dof].copy()
        for side in SIDES:
            F = self.hand_force(side, t)
            if F is not None:
                jacp, hb = np.zeros((3, m.nv)), m.body(f"{side}_hand").id
                if self.HAND_FORCE_AT is None:
                    mujoco.mj_jacBody(m, p, jacp, None, hb)
                else:                                       # where the hand meets what it works: the wrist's load too
                    # the left hand's body is the right's mirrored: its frame's dorsal axis points palmar
                    v = self.HAND_FORCE_AT * (1.0 if side == "R" else np.array([1.0, 1.0, -1.0]))
                    at = p.xpos[hb] + p.xmat[hb].reshape(3, 3) @ H0 @ v * 0.001
                    mujoco.mj_jac(m, p, jacp, None, at, hb)
                tau += (jacp.T @ F)[self.act_dof]
        target = p.qpos.copy()
        k = np.ones(len(self.acts))
        for side in SIDES:
            effort, grip = self.effort(side, t)
            if grip in self.grip_geoms and effort > 0:
                if (side, grip) not in self.squeeze:
                    self.squeeze[(side, grip)] = self.squeeze_dirs(side, grip)
                dq = sum(self.squeeze[(side, grip)].values(), np.zeros(m.nv)) * math.radians(SQUEEZE_DEG) * effort
                target[self.body_q] += dq[self.body_dof]
            k[self.hand_acts[side]] = 1.0 + STIFFEN * effort
            k[self.arm_acts[side]] = 1.0 + STIFFEN_ARM * effort
        target[self.body_q] += self.correction(t)[self.body_dof]
        # co-contraction stiffens a joint and damps it alike: damping grows with the stiffness's square root, so a
        # braced arm keeps its damping ratio instead of ringing after each move
        kv = self.kv * np.sqrt(k)
        m.actuator_gainprm[self.acts, 0] = self.kp0 * k
        m.actuator_biasprm[self.acts, 1] = -self.kp0 * k
        m.actuator_biasprm[self.acts, 2] = -kv
        d.ctrl[self.acts] = target[self.act_q] + (tau + kv * p.qvel[self.act_dof]) / (self.kp0 * k)
        self.before_step(t)
        mujoco.mj_step(m, d)

    def touching(self, side: str) -> bool:
        """Does the side's arm touch anything but the person and what it holds by a constraint?"""
        m, d = self.model, self.data
        held = {m.body(self.encloses[e["grip"]]).id for e in self.grip_events
                if e["side"] == side and d.eq_active[m.equality(f"enclose_{e['grip']}").id]}
        mine = self.side_bodies[side]
        for i in range(d.ncon):
            b1, b2 = m.geom_bodyid[d.contact[i].geom1], m.geom_bodyid[d.contact[i].geom2]
            if (b1 in mine) != (b2 in mine) and (b2 if b1 in mine else b1) not in held:
                return True
        return False

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """How far (m, and rad as a rotation vector, world) a tool the side holds is from where the step plans it, if
        the step plans its path; None: correct the hand itself. The weld fixes the tool in the hand as the plan has it
        at the grip, and the planned hand turns a little on the way, so on plan the hand can carry the tool 10 mm off
        its path: people watch the tool's tip, not their hand."""
        return None

    def correction(self, t: float) -> np.ndarray:
        """Joint offsets (nv) that move each hand toward where the plan has it, by the steady error seen so far, in
        place and in turn; paused while the arm touches something, where it would wind up against the contact, or
        holds a mechanism. While it holds a tool whose path the step plans (held_error), the eye is on the tool."""
        m, d, p = self.model, self.data, self.plan
        dt, dq = m.opt.timestep, np.zeros(m.nv)
        for side in SIDES:
            hb = m.body(f"{side}_hand").id
            Rp, Ra = p.xmat[hb].reshape(3, 3), d.xmat[hb].reshape(3, 3)
            err = self.held_error(side, t)
            if err is None:
                err = np.r_[p.xpos[hb] - d.xpos[hb], Rotation.from_matrix(Rp @ Ra.T).as_rotvec()]
            v = self.visual[side]
            if self._steps % 10 == 0:                            # contacts change slowly next to a 1 ms step
                # paused too while the hand holds a mechanism (a door's bar, the crank's knob): there being past the
                # plan is the point, as the vise take pauses while cranking; a welded tool is part of the hand
                holding = any(e["side"] == side and e["grip"] not in self.welded
                              and d.eq_active[m.equality(f"enclose_{e['grip']}").id] for e in self.grip_events)
                self._touch[side] = holding or self.touching(side)
            if not self._touch[side]:
                v += err * dt / VISUAL_TAU
            for i, cap in enumerate(VISUAL_MAX):
                n = np.linalg.norm(v[3 * i:3 * i + 3])
                if n > cap:
                    v[3 * i:3 * i + 3] *= cap / n
            if not v.any():
                continue
            jacp, jacr = np.zeros((3, m.nv)), np.zeros((3, m.nv))
            mujoco.mj_jacBody(m, p, jacp, jacr, hb)
            idx = self.arm_dofs[side]
            J = np.vstack([jacp[:, idx], jacr[:, idx] * 0.1])            # a radian weighs like 100 mm
            dq[idx] += J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(6), np.r_[v[:3], v[3:] * 0.1])
        self._steps += 1
        return dq

    # --- the run ---------------------------------------------------------------------------------------
    def hands(self) -> dict[str, dict]:
        """Each hand as the take record has it, from the simulation: the left in the mirrored world."""
        m, d, b = self.model, self.data, self.body
        out = {}
        for s in SIDES:
            anat = lambda n: b.joints[n].rest + math.degrees(d.qpos[m.jnt_qposadr[m.joint(n).id]])   # noqa: E731
            fr = {k: (d.body(f"{s}_{seg}").xmat.reshape(3, 3).copy(), d.body(f"{s}_{seg}").xpos * 1000)
                  for k, seg in (("H", "hand"), ("S", "humerus"), ("forearm", "forearm"))}
            if s == "L":
                fr = {k: (BM.mirror_frames(R), BM.mirror_points(p, self.lumbar)) for k, (R, p) in fr.items()}
            out[s] = {"q": [anat(f"{s}_{n}") for n in self.names], "H": fr["H"][0] @ H0, "W": fr["H"][1],
                      "S": fr["S"][1], "E": fr["forearm"][1], "forearm": fr["forearm"][0] @ H0}
        return out

    def anatomical(self, name: str) -> float:
        """A joint's angle now as the body model names it: degrees for a hinge, mm for the girdle's slides."""
        m, j = self.model, self.body.joints[name]
        q = self.data.qpos[m.jnt_qposadr[m.joint(name).id]]
        return j.rest + (math.degrees(q) if j.kind == "hinge" else q * 1000)

    def run(self, seconds: float | None = None, log=print) -> int:
        m, d = self.model, self.data
        for qadr, dof, s in self.splines:
            d.qpos[qadr], d.qvel[dof] = s(0.0), s(0.0, 1)
        self.start()
        mujoco.mj_forward(m, d)
        for _ in range(SETTLE_STEPS):
            self.step(0.0)
        spf = int(round(1.0 / (self.fps * m.opt.timestep)))
        n = len(self.t) if seconds is None else min(len(self.t), int(seconds * self.fps))
        self.recorder = Recorder(m, self.person, SIDES)
        self.theta = {s: [] for s in SIDES}
        for k in range(n):
            for s in range(spf):
                self.step((k + s / spf) / self.fps)
            self.recorder.frame(d, self.hands(), self.rd["eye"][k], self.rd["look"][k], self.rd["up"][k])
            self.theta["R"].append([self.anatomical(a if a.startswith("trunk") else f"R_{a}") for a in REF_ARM])
            self.theta["L"].append([self.anatomical(f"L_{a}") for a in REF_ARM[3:]])
            self.on_frame(k)
            if log and k % (5 * self.fps) == 0:
                log(f"frame {k}/{n}")
        return n

    def export(self, folder: Path | None = None) -> None:
        """The take record, and beside it sim.npz in the vise runner's keys (moonshot/sim/vise_take.py export_sim) for
        the checks that read one: the right arm under the plain keys, the left with an _L suffix, in the mirrored
        world as in the take record."""
        folder = Path(folder or self.folder)
        self.recorder.write(folder, self.fps, self.lumbar[0], {s: self.names for s in SIDES}, self.station,
                            self.glbs(), self.meshes(folder))
        hands, n = self.recorder.hands, len(self.theta["R"])
        sim = {"t": np.arange(n) / self.fps, "fps": self.fps, "names": np.array(self.names),
               "theta": np.array(self.theta["R"]), "theta_L": np.array(self.theta["L"]),
               "eye": self.rd["eye"][:n], "look": self.rd["look"][:n], "up": self.rd["up"][:n]}
        for s, suffix in (("R", ""), ("L", "_L")):
            sim |= {f"{k}{suffix}": np.array(hands[s][k]) for k in ("q", "H", "W", "S", "E", "forearm")}
        np.savez(folder / "sim.npz", **sim)
