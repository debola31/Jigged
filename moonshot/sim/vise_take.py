"""trainual's accepted vise setup take, run on the full body model (plan §5.4, step 1, stage 2).

trainual ran this take with a free-floating hand pinned to a wrist target. Here the whole arm carries the hand,
so every wrist correction trainual made becomes joint angles through the arm's Jacobian, and the motors' strength
limits apply throughout. The phase logic is trainual's sim/run_take.py, per event kind:
- grip: the touching fingers squeeze along their pads' into-surface directions, scaled by the take's effort, with
  finger stiffness rising with effort (co-contraction);
- hold_object / place_correct: the blank is held by friction alone; once lifted, the hand corrects for where the
  blank really sits in the grip (visually guided placement), eased out after letting go;
- press: force control, the wrist target driven along the press normal until the contact force reaches the
  verb's force (integral control);
- enclose: the knob is kept in the closed hand by a declared soft constraint (capsule fingers can't conform
  around it as flesh does);
- crank: closed loop from the knob's real angle, at most 8 deg ahead; the snug ends on a clamp-force loop. The
  arm follows the knob by replaying the planned motion at the planned time for the knob's commanded angle;
- lock: the lead screw self-locks while the hand isn't driving it; free_parallel: a keeper clip is released.

    python -m moonshot.sim.vise_take       # prints the per-verb report beside trainual's sim-report.json
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import mujoco
import numpy as np

from moonshot.body.skeleton import H0, build, set_finger_contact
from moonshot.contracts.thresholds import threshold
from moonshot.sim.reference import ReferenceTake, take_dir
from moonshot.world import vise as V

SQUEEZE_DEG = 7.5
STIFFEN = 4.0
STIFFEN_ARM = 3.0         # the arm co-contracts too during effortful manipulation: up to 4x its resting stiffness
VISUAL_TAU = 0.3          # visual correction: steady wrist error is corrected with this time constant (s)
VISUAL_MAX = 0.015        # ... by at most this much (m)
TOUCH_TAU = 0.07          # while pressing, sideways slip under the fingertip is felt and corrected this fast (s);
                          # tactile slip responses take ~70 ms (Johansson & Westling 1984)
LEAD_MAX_DEG = 8.0
TIGHTEN_LEAD_DEG = 4.0
ANGLOCK = 0.05            # Kurt's AngLock: a downward push on the moving jaw of this fraction of the clamp force
SNUG_GAIN = 0.01          # snug force loop: lead (deg/s) per newton short of the snug clamp force
PRESS_KI = 20.0           # press: the pushed force grows 20 N/s per newton it falls short of the target
CRANK_KI = 10.0           # crank: the hand's push on the knob grows 10 N/s per degree the knob lags its command
CRANK_F_MAX = 80.0        # the most the hand pushes on the knob (N)
DAMPING = 0.02            # damped least squares for the arm's wrist corrections (m)
DIGITS = {"thumb": ["met1", "pro1", "dis1"], "index": ["pro2", "int2", "dis2"], "middle": ["pro3", "int3", "dis3"],
          "ring": ["pro4", "int4", "dis4"], "little": ["pro5", "int5", "dis5"],
          "palm": ["palm", "met2", "met3", "met4", "met5"]}
PAD = {"thumb": "dis1", "index": "dis2", "middle": "dis3", "ring": "dis4", "little": "dis5"}
ARM_JOINTS = ["sc_prot", "sc_elev", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev"]
AIM_LEAD_S = 0.3          # aim the fingertip this long before a fingertip check starts
PRECISION = {"tip_para_a", "tip_para_b"}   # fingertip touches on a 3.1 mm parallel: precision grips
CARRYING = {"blank_faces"}       # grips that carry an object's weight, so regulate grip force
GRIP_GAIN = 0.3                  # squeeze (rad/s) per newton short of a digit's target force
NEAR_M = 0.02                    # a finger this close to the gripped object bends the contact way
TOUCH_N = 0.2                    # a digit with less force than this on the object isn't touching it
SKIN_MU = 0.6                    # skin on aluminium (Seo & Armstrong 2009, moonshot/body/data/anatomy.json grip)
GRIP_OBJECT = {"blank_faces": "blank", "blank_slide": "blank", "blank_press": "blank", "knob": "knob",
               "tip_para_a": "para_a", "tip_para_b": "para_b"}


def min_jerk(x: float) -> float:
    c = min(1.0, max(0.0, x))
    return c * c * c * (10 - 15 * c + 6 * c * c)


class ViseTake:
    def __init__(self, folder: Path | None = None):
        folder = folder or take_dir()
        self.tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.rd = np.load(folder / "reference.npz")
        self.body = build(pelvis_mm=tuple(self.tk["lumbar"]))
        parallels = {n: np.array(p) for n, p in self.tk["parallels"].items()}
        # the blank starts at STAGE; reference.npz frame 0 wrongly has it in the vise (frames 1+ and trainual's sim agree)
        vbody, veq = V.worldbody(V.STAGE, parallels, "R_hand")
        xml = self.body.xml
        head, _, tail = xml.rpartition("\n  </default>")
        xml = head + "\n" + V.STEEL_DEFAULT + "\n  </default>" + tail
        xml = xml.replace("<worldbody>\n", "<worldbody>\n" + vbody, 1).replace("<equality>\n", "<equality>\n" + veq, 1)
        self.xml = xml
        m = self.model = mujoco.MjModel.from_xml_string(xml)
        self.data, self.plan = mujoco.MjData(m), mujoco.MjData(m)
        self.ref = ReferenceTake(self.body, m, folder)
        self.t = self.rd["t"]
        self.fps = int(self.rd["fps"])
        # motors
        self.acts = np.arange(m.nu)
        jid = m.actuator_trnid[:, 0]
        self.act_dof, self.act_q = m.jnt_dofadr[jid], m.jnt_qposadr[jid]
        self.kp0 = m.actuator_gainprm[:, 0].copy()
        self.kv = -m.actuator_biasprm[:, 2].copy()
        names = [m.actuator(a).name[2:] for a in range(m.nu)]
        self.hand_acts = np.array([a for a, n in enumerate(names) if n.startswith("R_") and
                                   n[2:] not in ARM_JOINTS], dtype=int)
        self.arm_dofs = np.array([m.jnt_dofadr[m.joint(f"R_{j}").id] for j in ARM_JOINTS])
        self.act_of_dof = {int(self.act_dof[a]): a for a in range(m.nu)}
        self.digit_dofs = {dg: [m.jnt_dofadr[m.joint(n).id] for n in (m.joint(i).name for i in range(m.njnt))
                                if n.startswith(f"R_{dg}_") and int(m.jnt_dofadr[m.joint(n).id]) in self.act_of_dof]
                           for dg in PAD}
        self.geom = {n: m.geom(n).id for n in ("blank", "knob", "moving_jaw", "para_a", "para_b")}
        self.body_id = {n: m.body(n).id for n in ("blank", "knob", "para_a", "para_b", "R_hand")}
        self.geom_digit = {m.geom(f"R_g_{b}").id: dg for dg, bs in DIGITS.items() for b in bs}
        self.q_crank, self.q_jaw = m.jnt_qposadr[m.joint("crank").id], m.jnt_qposadr[m.joint("jaw_slide").id]
        # the body's joints in qpos and in qvel: the objects' free joints make the two index sets differ
        self.body_q = np.array([m.jnt_qposadr[m.joint(n).id] for n in self.body.joints])
        self.body_dof = np.array([m.jnt_dofadr[m.joint(n).id] for n in self.body.joints])
        # the take's events
        ev = self.tk["events"]
        self.iv = {k: self._intervals(ev, k) for k in ("grip", "hold_object", "place_correct", "press", "enclose",
                                                       "crank", "free_parallel")}
        self.cranks = self.iv["crank"]
        self.squeeze, self.phi_hold, self.snug_lead, self.press_i, self.crank_f = {}, {}, {}, {}, {}
        self.grip_scale: dict[str, dict[str, float]] = {}
        self.visual = np.zeros(3)
        self.aim: dict[int, np.ndarray] = {}
        self.intended = np.zeros(3)
        self.contact_label: set[str] = set()
        self.letgo, self.reach_off = {}, {}
        self.offset, self.offset_t = None, 0.0
        z = self.rd["blank"][:, 2].copy()
        z[0] = z[1]                                        # frame 0's glitch (see above)
        self.t_lift = float(self.t[np.argmax(z > V.STAGE[2] + 1.0)])
        top = int(np.argmax(z))
        self.t_down = float(self.t[top + np.argmax(z[top:] <= z[-1] + 0.5)])

    @staticmethod
    def _intervals(events, kind):
        """trainual stores each interval as an opening and a closing event; pair them in order."""
        out, open_ = [], []
        for e in events:
            if e["kind"] != kind:
                continue
            if e["t0"] is not None and e["t1"] is not None:
                out.append(dict(e))
            elif e["t0"] is not None:
                open_.append(dict(e))
            else:
                start = open_.pop(0)
                start["t1"] = e["t1"]
                out.append(start)
        return out + open_

    # --- the plan at any time -------------------------------------------------------------------------
    def phi(self) -> float:
        return V.CRANK0_DEG + math.degrees(self.data.qpos[self.q_crank])

    def crank_at(self, tt):
        for i, e in enumerate(self.cranks):
            if e["t0"] <= tt < e["t1"]:
                return i, e
        return None, None

    def planned_crank(self, tt):
        return float(np.interp(tt, self.t, self.rd["crank"]))

    def crank_cmd(self, tt, i, e):
        cp = e["plan"]
        if tt > cp["t1"]:
            if "snug_N" in cp:
                return self.phi() + self.snug_lead.get(i, 0.5)
            return self.phi() + TIGHTEN_LEAD_DEG * min_jerk((tt - cp["t1"]) / 0.3)
        plan = self.planned_crank(tt)
        return min(plan, self.phi() + LEAD_MAX_DEG) if tt > cp["t0"] else plan

    def plan_time(self, tt):
        """The time in the plan whose pose the body should take: during a crank, the planned time at which the
        knob was at the commanded angle, so the arm follows the real knob."""
        i, e = self.crank_at(tt)
        if e is None:
            return tt
        k0, k1 = (int(np.searchsorted(self.t, x)) for x in (e["t0"], e["t1"]))
        ang, ts = self.rd["crank"][k0:k1], self.t[k0:k1]
        keep = np.concatenate([[True], np.diff(ang) > 1e-6])
        return float(np.interp(self.crank_cmd(tt, i, e), ang[keep], ts[keep]))

    def aim_fingertip(self, parallel: str) -> np.ndarray:
        """Aim the index pad onto the parallel's top face before a fingertip check, by sight: the sideways shift (m)
        that brings the pad's nearest point onto the face's centre line, clear of the strip's ends."""
        m, d, ft = self.model, self.data, np.zeros(6)
        mujoco.mj_geomDistance(m, d, m.geom("R_g_dis2").id, m.geom(parallel).id, 0.2, ft)
        R, c = d.body(parallel).xmat.reshape(3, 3), d.body(parallel).xpos
        local = R.T @ (ft[:3] - c)
        half_len = m.geom(parallel).size[0]
        goal = np.array([np.clip(local[0], -half_len + 0.015, half_len - 0.015), 0.0, local[2]])
        shift = R @ (goal - local)
        shift[2] = 0.0                                     # the press itself owns the vertical
        return shift

    def wrist_offset(self, tt) -> np.ndarray:
        """Wrist corrections in metres: visually guided placement, aiming a fingertip onto a parallel, and leaving /
        reaching the real knob."""
        off = np.zeros(3)
        if self.offset is not None:
            end = self.iv["place_correct"][0]["t1"]
            off += self.offset * min_jerk((tt - self.offset_t) / 0.4) * (1 - min_jerk((tt - end) / 0.5))
        for i, e in enumerate(self.iv["press"]):
            if e["contact"] in ("para_a", "para_b") and e["t0"] - AIM_LEAD_S <= tt < e["t1"] + 0.3:
                if i not in self.aim:
                    self.aim[i] = self.aim_fingertip(e["contact"])
                off += self.aim[i] * min_jerk((tt - (e["t0"] - AIM_LEAD_S)) / 0.25) * (1 - min_jerk((tt - e["t1"]) / 0.3))
        for j, e in enumerate(self.cranks):
            if tt >= e["t1"] and j in self.letgo:
                off += self.letgo[j] * (1 - min_jerk((tt - e["t1"]) / 0.6))
            if j > 0 and e["t0"] - 1.2 <= tt < e["t0"]:
                if j not in self.reach_off:
                    self.reach_off[j] = (V.knob_center(self.phi()) - V.knob_center(e["plan"]["phi0"])) * 0.001
                off += self.reach_off[j] * min_jerk((tt - (e["t0"] - 1.2)) / 0.8)
        return off

    # --- control -------------------------------------------------------------------------------------
    def grip_squeeze(self, label) -> dict[str, np.ndarray]:
        """Per gripping digit: the unit joint direction that drives its pad into the gripped object (its Jacobian)."""
        m, d = self.model, self.data
        obj = self.geom[GRIP_OBJECT[label]]
        out = {}
        ft = np.zeros(6)
        for dg, seg in PAD.items():
            g = m.geom(f"R_g_{seg}").id
            if mujoco.mj_geomDistance(m, d, g, obj, 0.025, ft) >= 0.025:
                continue                                   # this digit isn't on the object
            n = ft[3:] - ft[:3]
            n = n / (np.linalg.norm(n) + 1e-12)
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, ft[:3], m.geom_bodyid[g])
            v = np.zeros(m.nv)
            idx = self.digit_dofs[dg]
            v[idx] = jacp[:, idx].T @ n
            if np.linalg.norm(v) > 0:
                out[dg] = v / np.linalg.norm(v)
        return out

    def set_contact_coupling(self, label: str) -> None:
        """Each frame: fingers near the gripped object bend their fingertip joints the contact way; the rest move
        freely. Judged per frame, because a grip's label starts while the hand is still reaching."""
        m, d = self.model, self.data
        near = set()
        if label in GRIP_OBJECT:
            obj, ft = self.geom[GRIP_OBJECT[label]], np.zeros(6)
            near = {dg for dg, seg in PAD.items() if dg != "thumb" and
                    mujoco.mj_geomDistance(m, d, m.geom(f"R_g_{seg}").id, obj, NEAR_M, ft) < NEAR_M}
        if near != self.contact_label:
            for finger in ("index", "middle", "ring", "little"):
                set_finger_contact(m, self.body, "R", finger, finger in near)
            self.contact_label = near

    def grip_targets(self, digits) -> dict[str, float]:
        """Normal force per digit for a carrying grip: each side presses the slip force times the safety margin
        people use (thresholds physics.grip_safety_margin, Guillery 2013; Hiramatsu 2015), the thumb opposing the
        fingers, which share their side's force."""
        lo, hi = threshold("physics.grip_safety_margin").band
        side = (lo + hi) / 2 * V.BLANK_KG * 9.81 / (2 * SKIN_MU)
        fingers = [dg for dg in digits if dg != "thumb"]
        return {dg: side if dg == "thumb" else side / max(1, len(fingers)) for dg in digits}

    def squeeze_offset(self, grip: str, effort: float, dt: float) -> np.ndarray:
        """The grip's joint offset. A carrying grip regulates each digit's force to its target (integral control
        on the squeeze), as people regulate grip force; pushing grips keep trainual's fixed squeeze."""
        if grip not in self.squeeze:
            self.squeeze[grip] = self.grip_squeeze(grip)
            self.grip_scale[grip] = {}
        dirs, scale = self.squeeze[grip], self.grip_scale[grip]
        base = math.radians(SQUEEZE_DEG) * effort
        if grip not in CARRYING:
            return sum(dirs[dg] * base for dg in dirs)
        force, _, _ = self.contacts()
        touching = [dg for dg in dirs if force.get(dg, 0.0) > TOUCH_N]
        out = np.zeros(self.model.nv)
        targets = self.grip_targets(touching)
        for dg in dirs:
            if dg in targets:                  # on the object: regulate its force
                start = scale.get(dg, base)
                err = targets[dg] * effort - force.get(dg, 0.0)
                scale[dg] = float(np.clip(start + GRIP_GAIN * err * dt, 0.0, math.radians(30)))
            # off the object: hold the last regulated squeeze (no windup, and no letting go); never touched: base
            out += dirs[dg] * max(scale.get(dg, 0.0), base)
        return out

    def arm_ik(self, dx: np.ndarray) -> np.ndarray:
        """Joint offsets moving the wrist by dx (m), through the right arm, at the planned pose."""
        m, p = self.model, self.plan
        jacp = np.zeros((3, m.nv))
        mujoco.mj_jacBody(m, p, jacp, None, self.body_id["R_hand"])
        J = jacp[:, self.arm_dofs]
        dq = np.zeros(m.nv)
        dq[self.arm_dofs] = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(3), dx)
        return dq

    def hand_touching(self) -> bool:
        """Is any part of the hand or arm in contact with anything? (Then touch, not sight, guides it.)"""
        d, m = self.data, self.model
        for i in range(d.ncon):
            b1, b2 = m.geom_bodyid[d.contact[i].geom1], m.geom_bodyid[d.contact[i].geom2]
            if m.body(b1).name.startswith("R_") or m.body(b2).name.startswith("R_"):
                return True
        return False

    def visual_correction(self, tt: float) -> np.ndarray:
        """People correct a steady error in where their hand is by sight, slowly. While pressing, only sideways
        (force owns the press direction); paused while cranking or holding the knob, where being past the plan is
        the point, and while the hand otherwise touches anything, where it would wind up against the contact."""
        press = next((e for e in self.iv["press"] if e["t0"] - 0.05 <= tt < e["t1"] + 0.15), None)
        cranking = any(e["t0"] <= tt < e["t1"] for e in self.iv["enclose"]) or self.crank_at(tt)[1] is not None
        err = self.intended - self.data.body("R_hand").xpos
        if press is not None:                  # pressing: hold position sideways; force owns the press direction
            n = np.asarray(press["normal"], float)
            err = err - n * (n @ err)
        if press is not None or (not cranking and not self.hand_touching()):
            self.visual += err * self.model.opt.timestep / (TOUCH_TAU if press is not None else VISUAL_TAU)
            n = np.linalg.norm(self.visual)
            if n > VISUAL_MAX:
                self.visual *= VISUAL_MAX / n
        return self.visual

    def hand_forces(self, tt: float) -> np.ndarray:
        """The torques for forces the hand applies on purpose: a press along its normal, and the push that turns
        the crank. People press and crank by pushing, not by misplacing the hand against a stiff arm, so these are
        planned forces, each trimmed by feedback (the integrals in `run`) and capped by the motors' strength."""
        m, d = self.model, self.data
        hand = self.body_id["R_hand"]
        tau = np.zeros(m.nu)

        def push(point, force, body=hand):
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, point, body)
            return jacp[:, self.act_dof].T @ force

        for i, e in enumerate(self.iv["press"]):
            if e["t0"] - 0.05 <= tt < e["t1"] + 0.15:
                fade = 1 - min_jerk((tt - e["t1"]) / 0.15) if tt > e["t1"] else 1.0
                mag = max(0.0, e["force"] * min_jerk((tt - e["t0"]) / 0.25) + self.press_i.get(i, 0.0)) * fade
                force = -np.asarray(e["normal"]) * mag
                if e["contact"] in ("para_a", "para_b"):
                    # a fingertip check presses with the finger itself: the force at the index pad, through the
                    # index's joints as well as the arm's, so the finger reaches down while the hand stays put
                    ft = np.zeros(6)
                    mujoco.mj_geomDistance(m, d, m.geom("R_g_dis2").id, self.geom[e["contact"]], 0.2, ft)
                    tau += push(ft[:3], force, m.body("R_dis2").id)
                else:
                    tau += push(self.contact_point(self.geom[e["contact"]]), force)
        ci, ce = self.crank_at(tt)
        if ce is not None and self.crank_f.get(ci, 0.0) > 0:
            p = math.radians(self.phi())
            tangent = np.array([math.cos(p), 0.0, -math.sin(p)])      # d(knob_center)/d(phi), closing
            tau += push(d.body("knob").xpos, tangent * self.crank_f[ci])
        return tau

    def contact_point(self, geom: int) -> np.ndarray:
        """Where the hand touches a geom (mean contact position), else the wrist."""
        d = self.data
        pts = [d.contact[i].pos for i in range(d.ncon) if geom in (d.contact[i].geom1, d.contact[i].geom2)
               and ({d.contact[i].geom1, d.contact[i].geom2} - {geom}) & self.geom_digit.keys()]
        return np.mean(pts, axis=0) if pts else d.body("R_hand").xpos.copy()

    def anticipated_load(self, tt: float, grip: str, effort: float) -> np.ndarray:
        """The torques that carry a held object's expected weight. People raise load force in step with grip force,
        expecting the object's weight (Guillery 2013's loading phase), so it is fed forward rather than discovered as
        sag. Applied at where the object sits in the hand, mapped through the planned pose."""
        if grip not in CARRYING or effort <= 0 or not any(e["t0"] <= tt < e["t1"] for e in self.iv["hold_object"]):
            return 0.0
        if sum(self.contacts()[0].values()) < 2 * TOUCH_N:
            return 0.0                                     # not actually holding it: nothing to carry
        m, d, p = self.model, self.data, self.plan
        hand = self.body_id["R_hand"]
        rel = d.xmat[hand].reshape(3, 3).T @ (d.body("blank").xpos - d.xpos[hand])
        point = p.xpos[hand] + p.xmat[hand].reshape(3, 3) @ rel
        jacp = np.zeros((3, m.nv))
        mujoco.mj_jac(m, p, jacp, None, point, hand)
        return jacp[:, self.act_dof].T @ np.array([0.0, 0.0, V.BLANK_KG * 9.81 * effort])

    def set_plan(self, tp: float) -> np.ndarray:
        """Pose the planning data at plan time tp (objects where they really are); returns its planned qvel."""
        q, v, a = self.ref.at(tp)
        p = self.plan
        p.qpos[:] = self.data.qpos
        p.qpos[self.body_q] = q[self.body_q]
        p.qvel[:], p.qacc[:] = 0, 0
        p.qvel[self.body_dof], p.qacc[self.body_dof] = v[self.body_dof], a[self.body_dof]
        return p.qvel.copy()

    def step(self, tt: float, grip: str, effort: float) -> None:
        m, d, p = self.model, self.data, self.plan
        v = self.set_plan(self.plan_time(tt))
        # the planned motion's own torques: rigid-body inverse dynamics, no contacts or constraints
        flags = m.opt.disableflags
        m.opt.disableflags = flags | int(mujoco.mjtDisableBit.mjDSBL_CONSTRAINT)
        mujoco.mj_inverse(m, p)
        m.opt.disableflags = flags
        tau = p.qfrc_inverse[self.act_dof].copy()
        tau += self.anticipated_load(tt, grip, effort)
        tau += self.hand_forces(tt)
        target = p.qpos.copy()
        dq = np.zeros(m.nv)
        intended = self.wrist_offset(tt)
        self.intended = p.body("R_hand").xpos + intended          # the plan plus the deliberate corrections
        off = intended + self.visual_correction(tt)
        if off.any():
            dq += self.arm_ik(off)
        if grip and effort > 0:
            sq = self.squeeze_offset(grip, effort, m.opt.timestep)
            if isinstance(sq, np.ndarray):
                dq += sq
        target[self.body_q] += dq[self.body_dof]
        precise = grip in PRECISION                    # accuracy demands raise co-contraction (Gribble et al. 2003)
        k = np.full(m.nu, 1.0 + STIFFEN_ARM * (1.0 if precise and effort > 0 else effort))
        k[self.hand_acts] = 1.0 + STIFFEN * effort
        m.actuator_gainprm[:, 0] = self.kp0 * k
        m.actuator_biasprm[:, 1] = -self.kp0 * k
        d.ctrl[:] = target[self.act_q] + (tau + self.kv * v[self.act_dof]) / (self.kp0 * k)
        mujoco.mj_step(m, d)

    # --- measurement ---------------------------------------------------------------------------------
    def contacts(self):
        """(per-digit force on the objects, blank-to-moving-jaw clamp force, deepest digit contact in mm)."""
        m, d = self.model, self.data
        f, clamp, depth, c6 = {}, 0.0, 0.0, np.zeros(6)
        objs = {self.geom[n] for n in ("blank", "knob", "para_a", "para_b")}
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = c.geom1, c.geom2
            if {g1, g2} & objs and ({g1, g2} - objs) & self.geom_digit.keys():
                mujoco.mj_contactForce(m, d, i, c6)
                dg = self.geom_digit[(({g1, g2} - objs)).pop()]
                f[dg] = f.get(dg, 0.0) + abs(c6[0])
                depth = max(depth, -c.dist * 1000)
            if {g1, g2} == {self.geom["blank"], self.geom["moving_jaw"]}:
                mujoco.mj_contactForce(m, d, i, c6)
                clamp += abs(c6[0])
        return f, clamp, depth

    def press_force(self, geom, normal):
        """The hand's whole force on one geom along the push (-normal)."""
        m, d = self.model, self.data
        total, c6 = 0.0, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            if geom in (c.geom1, c.geom2):
                other = c.geom2 if c.geom1 == geom else c.geom1
                if other in self.geom_digit:
                    mujoco.mj_contactForce(m, d, i, c6)
                    fw = c.frame.reshape(3, 3).T @ c6[:3]
                    fw = fw if c.geom2 == geom else -fw
                    total += float(-fw @ np.asarray(normal))
        return total

    def hand_frame(self):
        return self.data.body("R_hand").xmat.reshape(3, 3) @ H0, self.data.body("R_hand").xpos * 1000

    # --- the run -------------------------------------------------------------------------------------
    def run(self, seconds: float | None = None, log=print) -> dict:
        m, d = self.model, self.data
        for qadr, dof, s in self.ref.splines:              # the body at the take's first pose; objects as built
            d.qpos[qadr], d.qvel[dof] = s(0.0), s(0.0, 1)
        mujoco.mj_forward(m, d)
        for _ in range(300):                               # settle the objects and the hand at rest
            self.step(0.0, "", 0.0)
        mujoco.mj_forward(m, d)
        rd, fps = self.rd, self.fps
        spf = int(round(1.0 / (fps * m.opt.timestep)))
        n = len(self.t) if seconds is None else min(len(self.t), int(seconds * fps))
        enc, lock = m.equality("enclose").id, m.equality("screw_lock").id
        keep = {nm: m.equality(f"keep_{nm}").id for nm in ("para_a", "para_b")}
        rec = {k: [] for k in ("blank", "blank_R", "crank", "opening", "force", "clamp", "depth", "para", "press",
                               "slip", "lag", "pushing")}
        hold_rel, t0w = None, time.time()
        hold0 = self.iv["hold_object"][0]
        for k in range(n):
            tk = k / fps
            want_enc = any(e["t0"] <= tk < e["t1"] for e in self.iv["enclose"])
            if want_enc and not d.eq_active[enc]:
                kb = self.body_id["knob"]
                pk = d.xpos[kb] + d.xmat[kb].reshape(3, 3) @ m.eq_data[enc, 0:3]
                hb = self.body_id["R_hand"]
                m.eq_data[enc, 3:6] = d.xmat[hb].reshape(3, 3).T @ (pk - d.xpos[hb])
                d.eq_active[enc] = 1
            elif not want_enc and d.eq_active[enc]:
                d.eq_active[enc] = 0
            driven = any(e["t0"] - 0.15 <= tk < e["t1"] for e in self.cranks)
            if not driven and not d.eq_active[lock]:
                m.eq_data[lock, 0] = d.qpos[self.q_crank]
                d.eq_active[lock] = 1
            elif driven and d.eq_active[lock]:
                d.eq_active[lock] = 0
            for e in self.iv["free_parallel"]:
                if tk >= e["t0"] and d.eq_active[keep[e["name"]]]:
                    d.eq_active[keep[e["name"]]] = 0
            for j, e in enumerate(self.cranks):
                if tk >= e["t1"] and j not in self.phi_hold:
                    self.phi_hold[j] = self.phi()
                    kk = min(len(self.t) - 1, int(round(e["t1"] * fps)))
                    real = self.ref_wrist(self.plan_time_for_phi(e, self.phi_hold[j]))
                    self.letgo[j] = real - rd["W"][kk] * 0.001
            if self.offset is None and self.iv["place_correct"] and tk >= self.iv["place_correct"][0]["t0"]:
                self.offset, self.offset_t = self.measure_offset(k), tk
            grip = str(rd["grip"][k])
            effort = float(rd["effort"][k])
            self.set_contact_coupling(grip)
            for s in range(spf):
                tt = (k + s / spf) / fps
                for i, e in enumerate(self.iv["press"]):
                    if e["t0"] <= tt < e["t1"]:
                        F = self.press_force(self.geom[e["contact"]], e["normal"])
                        err = e["force"] * min_jerk((tt - e["t0"]) / 0.25) - F
                        if F > TOUCH_N:            # trim only while touching: no windup into empty space
                            self.press_i[i] = float(np.clip(self.press_i.get(i, 0.0) + PRESS_KI * err * m.opt.timestep,
                                                            -e["force"], 2 * e["force"]))
                _, Fj, _ = self.contacts()
                d.xfrc_applied[m.body("moving_jaw").id, 2] = -ANGLOCK * Fj
                ci, ce = self.crank_at(tt)
                if ce is not None:
                    lag_deg = self.crank_cmd(tt, ci, ce) - self.phi()
                    self.crank_f[ci] = float(np.clip(self.crank_f.get(ci, 0.0) + CRANK_KI * lag_deg * m.opt.timestep,
                                                     0.0, CRANK_F_MAX))
                if ce is not None and "snug_N" in ce["plan"] and tt > ce["plan"]["t1"]:
                    lead = self.snug_lead.get(ci, 0.5) + SNUG_GAIN * (ce["plan"]["snug_N"] - Fj) * m.opt.timestep
                    self.snug_lead[ci] = float(np.clip(lead, -1.0, LEAD_MAX_DEG))
                self.step(tt, grip if grip in GRIP_OBJECT else "", effort)
            f, clamp, depth = self.contacts()
            rec["blank"].append(d.body("blank").xpos * 1000)
            rec["blank_R"].append(d.body("blank").xmat.reshape(3, 3).copy())
            rec["crank"].append(self.phi())
            rec["opening"].append(V.OPENING0 - d.qpos[self.q_jaw] * 1000)
            rec["force"].append(f)
            rec["clamp"].append(clamp)
            rec["depth"].append(depth)
            rec["para"].append(np.array([d.body(nm).xpos * 1000 for nm in ("para_a", "para_b")]))
            rec["lag"].append(float(np.linalg.norm(d.body("R_hand").xpos - self.intended) * 1000))
            rec["pushing"].append(any(e["t0"] - 0.05 <= tk < e["t1"] + 0.15 for e in self.iv["press"]) or
                                  any(e["t0"] <= tk < e["t1"] for e in self.iv["enclose"]) or
                                  self.crank_at(tk)[1] is not None)
            pf = 0.0
            for e in self.iv["press"]:
                if e["t0"] - 0.1 <= tk < e["t1"] + 0.1:
                    pf = self.press_force(self.geom[e["contact"]], e["normal"])
            rec["press"].append(pf)
            H, W = self.hand_frame()
            rel = H.T @ (rec["blank"][-1] - W)
            if hold0["t0"] + 0.6 < tk < self.t_down - 0.3:
                hold_rel = rel if hold_rel is None else hold_rel
                rec["slip"].append(float(np.linalg.norm(rel - hold_rel)))
            else:
                rec["slip"].append(0.0)
            if k % 60 == 0:
                log(f"frame {k}/{n} ({time.time() - t0w:.0f} s): blank {np.round(rec['blank'][-1], 0)} "
                    f"crank {rec['crank'][-1]:.0f} opening {rec['opening'][-1]:.1f} "
                    f"hand {sum(f.values()):.1f} N clamp {clamp:.0f} N")
        self.rec = rec
        return self.report(n)

    def plan_time_for_phi(self, e, phi):
        k0, k1 = (int(np.searchsorted(self.t, x)) for x in (e["t0"], e["t1"]))
        ang, ts = self.rd["crank"][k0:k1], self.t[k0:k1]
        keep = np.concatenate([[True], np.diff(ang) > 1e-6])
        return float(np.interp(phi, ang[keep], ts[keep]))

    def ref_wrist(self, tp):
        q, _, _ = self.ref.at(tp)
        scratch = mujoco.MjData(self.model)
        scratch.qpos[:] = self.data.qpos
        scratch.qpos[self.body_q] = q[self.body_q]
        mujoco.mj_kinematics(self.model, scratch)
        return scratch.body("R_hand").xpos.copy()

    def measure_offset(self, k):
        """Where the blank really sits in the hand vs the plan, as a wrist correction in world metres."""
        Wp, Hp = self.rd["W"][k], self.rd["H"][k]
        p_plan = Hp.T @ (self.rd["blank"][k] - Wp)
        H, W = self.hand_frame()
        p_act = H.T @ (self.data.body("blank").xpos * 1000 - W)
        return Hp @ (p_plan - p_act) * 0.001

    def report(self, n) -> dict:
        rec, t, fps = self.rec, self.t[:n], self.fps
        B, P = np.array(rec["blank"]), np.array(rec["para"])
        force = np.array([[f.get(dg, 0.0) for dg in ("thumb", "index", "middle", "ring", "little", "palm")]
                          for f in rec["force"]])
        lift = (t > self.t_lift + 0.15) & (t < self.t_down - 0.3)
        clips = {c["verb"]: c for c in self.tk["clips"]}
        lag, pushing = np.array(rec["lag"]), np.array(rec["pushing"], bool)
        settled = t > 0.5                                  # the first half second is the body settling into its start
        out = {"frames": int(n), "seconds": round(float(t[-1]), 2),
               "max_lag_free_motion_mm": round(float(lag[settled & ~pushing].max(initial=0)), 2),
               "max_deviation_while_pushing_mm": round(float(lag[pushing].max(initial=0)), 2),
               "max_contact_depth_mm": round(float(max(rec["depth"])), 2)}
        if lift.any():
            out["grab_hold"] = {"lifted_by_friction": bool(np.all(B[lift][:, 2] > V.STAGE[2] + 5)),
                                "grip_N_thumb_median": round(float(np.median(force[lift, 0])), 2),
                                "grip_N_fingers_median": round(float(np.median(force[lift, 1:5].sum(1))), 2),
                                "max_slip_mm": round(float(np.max(rec["slip"])), 2)}
        kd = int(self.t_down * fps) + 8
        if kd < n:
            out["place"] = {"set_down_vs_planned_mm": [round(float(x), 2) for x in B[kd] - self.rd["blank"][kd]],
                            "tilt_deg": round(float(np.degrees(np.arccos(np.clip(rec["blank_R"][kd][2, 2], -1, 1)))), 2)}
        sl = clips["slide"]
        if int(sl["t1"] * fps) <= n:
            out["slide"] = {"moved_mm": round(float(B[int(sl["t1"] * fps) - 1][1] - B[int(sl["t0"] * fps)][1]), 2),
                            "gap_to_fixed_jaw_after_mm": round(float(V.VISE["fixed_face_y"] -
                                                                     (B[int(sl["t1"] * fps) - 1][1] + V.HALF[1])), 2)}
        press = [e for e in self.iv["press"] if e["contact"] == "blank"
                 and clips["push"]["t0"] <= e["t0"] < clips["push"]["t1"]][0]
        pm = (t >= press["t0"] + 0.3) & (t < press["t1"])
        if pm.any():
            out["push"] = {"target_N": press["force"], "press_N_median": round(float(np.median(np.array(rec["press"])[pm])), 1)}
        if self.cranks and int(self.cranks[0]["t1"] * fps) + 6 < n:
            out["rotate"] = {"turns": round(float((rec["crank"][-1] - V.CRANK0_DEG) / 360), 3),
                             "opening_final_mm": round(float(rec["opening"][-1]), 2),
                             "clamp_N_snug": round(float(rec["clamp"][int(self.cranks[0]["t1"] * fps) + 6]), 0),
                             "clamp_N_final": round(float(rec["clamp"][-1]), 0)}
        msr = [e for e in self.iv["press"] if e["contact"] != "blank" and int(e["t1"] * fps) < n]
        if msr:
            out["measure"] = [{"parallel": e["contact"],
                               "press_N_median": round(float(np.median(np.array(rec["press"])[(t >= e["t0"] + 0.2) & (t < e["t1"])])), 2),
                               "parallel_moved_mm": round(float(np.linalg.norm(
                                   P[int(e["t1"] * fps), ["para_a", "para_b"].index(e["contact"])] -
                                   P[int(e["t0"] * fps), ["para_a", "para_b"].index(e["contact"])])), 3)} for e in msr]
        return out


def main(argv: list[str]) -> None:
    seconds = float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None
    run = ViseTake()
    rep = run.run(seconds)
    ref = json.loads((take_dir() / "sim-report.json").read_text(encoding="utf-8"))
    print(json.dumps({"new_core": rep, "trainual": ref}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
