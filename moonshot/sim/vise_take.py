"""trainual's accepted vise setup take, run on the full body model (plan §5.4, step 1, stage 2).

trainual ran this take with a free-floating hand pinned to a wrist target. Here the whole arm carries the hand,
so every wrist correction trainual made becomes joint angles through the arm's Jacobian, and the motors' strength
limits apply throughout. The phase logic is trainual's sim/run_take.py, per event kind:
- grip: the touching fingers squeeze along their pads' into-surface directions, scaled by the take's effort, with
  finger stiffness rising with effort (co-contraction);
- hold_object / place_correct: the blank is held by friction alone; once lifted, and again after the hold, the hand
  corrects for where the blank really sits in the grip (visually guided placement), eased out after letting go;
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
from scipy.spatial.transform import Rotation

from moonshot.body.controller import StrengthCaps
from moonshot.body.skeleton import H0, build, set_finger_contact
from moonshot.contracts.thresholds import threshold
from moonshot.sim.record import Recorder, TouchOnsets, glbs_in_bodies, hand_wrench
from moonshot.sim.reference import ReferenceTake, take_dir
from moonshot.world import cell, vf2
from moonshot.world import vise as V

SQUEEZE_DEG = 5.5        # with capsules 2.5 mm inside the pads; 7.5 was for capsules 4-5 mm inside them
STIFFEN = 4.0              # the hand's co-contraction at full effort, for the reference part; heavier parts brace more
STIFFEN_ARM = 3.0         # the arm co-contracts too during effortful manipulation: up to 4x its resting stiffness
VISUAL_TAU = 0.3          # visual correction: steady wrist error is corrected with this time constant (s)
VISUAL_MAX = 0.04         # ... by at most this much (m): at 15 mm op30's tall part arrived over the vise 28 mm off
                          # and was set down on the moving jaw
CARRY_TAU = 0.8           # ... and a carried part's place, seen against its plan, this slowly (s): at 0.3, through the arm's
                          # lag and the grip's give, op20's 1.2 kg part swung 15 mm either side of its path
SQUARE_TAU = 0.6          # a held part's turn about the vertical, seen against its plan, is squared up this fast (s),
SQUARE_MAX = 0.6          # by turning the hand about the part, by at most this much (rad): op30's tall part turned 27
                          # degrees in the hand and landed across both jaws
TOUCH_RELEASE_S = 0.2     # after a press, its touch correction fades with this time constant (s)
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
NEVER_HELD = ["lever"]           # mechanism parts the hand never touches: it holds the knob, which spins round the lever
GRIP_OBJECT = {"blank_faces": "blank", "blank_slide": "blank", "blank_press": "blank", "knob": "knob",
               "tip_para_a": "para_a", "tip_para_b": "para_b"}


def min_jerk(x: float) -> float:
    c = min(1.0, max(0.0, x))
    return c * c * c * (10 - 15 * c + 6 * c * c)


class ViseTake:
    def __init__(self, folder: Path | None = None):
        self.onsets: TouchOnsets | None = None             # from run(): when, between frames, each touch began
        folder = folder or take_dir()
        self.tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.rd = np.load(folder / "reference.npz")
        self.body = build(pelvis_mm=tuple(self.tk["lumbar"]))
        parallels = {n: np.array(p) for n, p in self.tk["parallels"].items()}
        # what is loaded; trainual's take.json predates the field, and its load is the reference
        self.load = V.Load.from_json(self.tk["load"]) if "load" in self.tk else V.REFERENCE
        # people co-contract harder for a heavier part (grip force and stiffness rise with load): with the square root
        # of its weight over the reference part's, so the reference take is unchanged
        self.stiffen = STIFFEN * max(1.0, self.load.mass_kg / V.REFERENCE.mass_kg) ** 0.5
        # the blank starts at the load's stage; reference.npz frame 0 wrongly has it in the vise (frames 1+ and
        # trainual's sim agree)
        # a lift-out take starts with the part in the vise, the jaw a turn open (moonshot/motion/setup_take.py start)
        self.in_vise = self.tk.get("start") == "vise"
        self.start_p = np.array(self.tk["home"]) if self.in_vise else self.load.stage
        self.xml = cell.with_body(self.body.xml, self.start_p, parallels, "R_hand", self.load)
        m = self.model = mujoco.MjModel.from_xml_string(self.xml)
        self.data, self.plan = mujoco.MjData(m), mujoco.MjData(m)
        self.machine = cell.start(m, self.data)          # idle: holds the table, and the vise on it, where it is
        if self.in_vise:                                  # the jaw a turn of the screw off the part, the screw locked
            jaw = (self.load.opening0 - self.load.size[1] - V.VISE["lead"]) * 0.001
            q = m.jnt_qposadr
            self.data.qpos[q[m.joint("jaw_slide").id]] = jaw
            self.data.qpos[q[m.joint("crank").id]] = jaw / m.eq_data[m.equality("lead_screw").id, 1]
        self.ref = ReferenceTake(self.body, m, folder)
        self.t = self.rd["t"]
        self.fps = int(self.rd["fps"])
        # the planned blank's acceleration (m/s^2): the inertial load the arm expects while carrying it
        self.blank_acc = np.gradient(np.gradient(self.rd["blank"] * 0.001, 1 / self.fps, axis=0), 1 / self.fps, axis=0)
        # the body's motors (the machine's are driven by its control)
        body_joints = {m.joint(n).id for n in self.body.joints}
        self.acts = np.array([a for a in range(m.nu) if m.actuator_trnid[a, 0] in body_joints])
        jid = m.actuator_trnid[self.acts, 0]
        self.act_dof, self.act_q = m.jnt_dofadr[jid], m.jnt_qposadr[jid]
        self.kp0 = m.actuator_gainprm[self.acts, 0].copy()
        self.kv = -m.actuator_biasprm[self.acts, 2].copy()
        self.caps = StrengthCaps(self.body, m)          # each motor capped at its strength for its angle and speed
        names = [m.actuator(a).name[2:] for a in self.acts]
        self.hand_acts = np.array([a for a, n in enumerate(names) if n.startswith("R_") and
                                   n[2:] not in ARM_JOINTS], dtype=int)
        # the corrections steer through the shoulder, elbow and wrist: the girdle's slides (sc_*), a few centimetres
        # of travel, are the cheapest joints for a translation, took most of each correction and sat on their stops
        # (the setting session's finding), and op30's hand stayed 28 mm off where the eye sent it
        self.arm_dofs = np.array([m.jnt_dofadr[m.joint(f"R_{j}").id] for j in ARM_JOINTS if not j.startswith("sc_")])
        self.act_of_dof = {int(dof): a for a, dof in enumerate(self.act_dof)}
        self.digit_dofs = {dg: [m.jnt_dofadr[m.joint(n).id] for n in (m.joint(i).name for i in range(m.njnt))
                                if n.startswith(f"R_{dg}_") and int(m.jnt_dofadr[m.joint(n).id]) in self.act_of_dof]
                           for dg in PAD}
        # a part stood on the vise's floor (nist-ftc-10 op50, on its end against a stop) has no parallels under it
        self.paras = [nm for nm in ("para_a", "para_b") if nm in self.load.parallels_y]
        self.geom = {n: m.geom(n).id for n in ("blank", "knob", "moving_jaw", *self.paras)}
        self.body_id = {n: m.body(n).id for n in ("blank", "knob", *self.paras, "R_hand")}
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
        self.touch = np.zeros(3)
        self.square = 0.0                                  # the hand's turn about the vertical squaring up the held part
        self.aim: dict[int, np.ndarray] = {}
        self.intended = np.zeros(3)
        self.contact_label: set[str] = set()
        self.letgo, self.reach_off = {}, {}
        self.offsets: list[tuple[float, np.ndarray]] = []   # (time, the wrist correction the part's place in the hand asks)
        # a part heavier than the reference is looked at again before it is set down: braced harder and turned less,
        # it settles in the hand during the hold (op10's moved 2 mm); the reference's doesn't, and a second sighting
        # only adds noise to its set-down
        hold = [c for c in self.tk["clips"] if c["verb"] == "hold"]
        heavier = self.load.mass_kg > V.REFERENCE.mass_kg
        self.resight_t = hold[0]["t1"] if hold and heavier else None
        z = self.rd["blank"][:, 2].copy()
        z[0] = z[1]                                        # frame 0's glitch (see above)
        self.t_lift = float(self.t[np.argmax(z > self.start_p[2] + 1.0)])
        top = int(np.argmax(z))
        self.t_down = float(self.t[top + np.argmax(z[top:] <= z[-1] + 0.5)])
        if self.in_vise:            # a lift-out's part is looked at again over the table, before it is set down: the
            self.resight_t = self.t_down - 1.2      # first sighting is taken as it leaves the jaws (11 mm off without)

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

    def aim_fingertip(self, parallel: str, normal) -> np.ndarray:
        """Aim the index pad onto the face of the parallel a fingertip check presses: the shift (m) that brings the
        pad's nearest point onto the face's centre line across the 3.1 mm strip, clear of the top's ends (pressing
        down) or of the end face's edges (pushing along it). The press itself owns its own direction."""
        m, d, ft = self.model, self.data, np.zeros(6)
        mujoco.mj_geomDistance(m, d, m.geom("R_g_dis2").id, m.geom(parallel).id, 0.2, ft)
        R, c = d.body(parallel).xmat.reshape(3, 3), d.body(parallel).xpos
        local = R.T @ (ft[:3] - c)
        half = m.geom(parallel).size
        n = np.asarray(normal, float)
        goal = local.copy()
        goal[1] = 0.0
        if abs(n[2]) > 0.5:                                # its top: clear of the strip's ends
            goal[0] = np.clip(local[0], -half[0] + 0.015, half[0] - 0.015)
        else:                                              # its end face: clear of the top and bottom edges
            goal[2] = np.clip(local[2], -half[2] + 0.004, half[2] - 0.004)
        shift = R @ (goal - local)
        return shift - n * (n @ shift)

    def wrist_offset(self, tt) -> np.ndarray:
        """Wrist corrections in metres: visually guided placement, aiming a fingertip onto a parallel, and leaving /
        reaching the real knob."""
        off = np.zeros(3)
        if self.offsets:
            end = self.iv["place_correct"][0]["t1"]
            prev = np.zeros(3)
            for t_m, o in self.offsets:                      # each sighting blends in over 0.4 s
                off += (o - prev) * min_jerk((tt - t_m) / 0.4) * (1 - min_jerk((tt - end) / 0.5))
                prev = o
        for i, e in enumerate(self.iv["press"]):
            if e["contact"] in ("para_a", "para_b") and e["t0"] - AIM_LEAD_S <= tt < e["t1"] + 0.3:
                if i not in self.aim:
                    self.aim[i] = self.aim_fingertip(e["contact"], e["normal"])
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
            dist = mujoco.mj_geomDistance(m, d, g, obj, 0.025, ft)
            if dist >= 0.025:
                continue                                   # this digit isn't on the object
            # pad to object; a pad already pressed in gets the segment out of the object, so it turns round
            n = (ft[3:] - ft[:3]) * (1.0 if dist >= 0 else -1.0)
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
        side = (lo + hi) / 2 * self.load.mass_kg * 9.81 / (2 * SKIN_MU)
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

    def arm_ik(self, dx: np.ndarray, turn: float = 0.0) -> np.ndarray:
        """Joint offsets moving the wrist by dx (m), and turning the hand by turn (rad) about the vertical, through the
        right arm, at the planned pose."""
        m, p = self.model, self.plan
        jacp, jacr = np.zeros((3, m.nv)), np.zeros((3, m.nv))
        mujoco.mj_jacBody(m, p, jacp, jacr if turn else None, self.body_id["R_hand"])
        dq = np.zeros(m.nv)
        if not turn:
            J = jacp[:, self.arm_dofs]
            dq[self.arm_dofs] = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(3), dx)
            return dq
        J = np.vstack([jacp[:, self.arm_dofs], jacr[:, self.arm_dofs] * 0.1])     # a radian weighs like 100 mm
        e = np.r_[dx, np.array([0.0, 0.0, turn]) * 0.1]
        dq[self.arm_dofs] = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(6), e)
        return dq

    def squaring(self, tt: float) -> float:
        """While the hand carries the part (lifted, until it is set down), its turn about the vertical against the plan
        is seen and the hand turned to square it up, slowly, as the eye corrects the hand's place (visual_correction);
        let go of after the set-down."""
        dt = self.model.opt.timestep
        held = any(e["t0"] + 0.3 <= tt < e["t1"] + 0.3 for e in self.iv["hold_object"])
        if held and tt >= self.t_down:                     # set down, still in the hand: held as squared until it is let
            return self.square                             # go (let go of sooner, the hand turned it back 20 degrees)
        if held:
            k = min(len(self.rd["blank_R"]) - 1, int(round(self.plan_time(tt) * self.fps)))
            Rp, Ra = self.rd["blank_R"][k], self.data.body("blank").xmat.reshape(3, 3)
            err = Rotation.from_matrix(Rp @ Ra.T).as_rotvec()[2]
            self.square = float(np.clip(self.square + err * dt / SQUARE_TAU, -SQUARE_MAX, SQUARE_MAX))
        else:
            self.square *= 1 - dt / TOUCH_RELEASE_S
        return self.square if abs(self.square) > 1e-6 else 0.0

    def stray_contacts(self, grip: str, tt: float) -> list[str]:
        """The hand touching something it isn't working on: plan near-misses (a fingertip grazing the table). They
        deflect a compliant arm, as they would a person's, so they are reported, not counted as tracking lag."""
        m, d = self.model, self.data
        allowed = {self.geom[GRIP_OBJECT[grip]]} if grip in GRIP_OBJECT else set()
        allowed |= {self.geom[e["contact"]] for e in self.iv["press"] if e["t0"] - 0.05 <= tt < e["t1"] + 0.15}
        allowed |= {self.geom["knob"]} if any(e["t0"] <= tt < e["t1"] for e in self.iv["enclose"]) else set()
        out = []
        for i in range(d.ncon):
            g1, g2 = d.contact[i].geom1, d.contact[i].geom2
            for a, b in ((g1, g2), (g2, g1)):
                if m.geom(a).name.startswith("R_") and not m.geom(b).name.startswith("R_") and b not in allowed:
                    out.append(f"{m.geom(a).name[2:]}/{m.geom(b).name}")
        return out

    def touching(self) -> list[str]:
        """Everything the right hand and arm touch this frame, by geom name."""
        m, d = self.model, self.data
        out = set()
        for i in range(d.ncon):
            g1, g2 = d.contact[i].geom1, d.contact[i].geom2
            for a, b in ((g1, g2), (g2, g1)):
                if m.geom(a).name.startswith("R_") and not m.geom(b).name.startswith("R_"):
                    out.add(m.geom(b).name)
        return sorted(out)

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
        the point, and while the hand otherwise touches anything, where it would wind up against the contact. While
        it carries the part the eye is on the part: the hand touches it throughout, and op30's arrived 28 mm off."""
        dt = self.model.opt.timestep
        press = next((e for e in self.iv["press"] if e["t0"] - 0.05 <= tt < e["t1"] + 0.15), None)
        cranking = any(e["t0"] <= tt < e["t1"] for e in self.iv["enclose"]) or self.crank_at(tt)[1] is not None
        err = self.intended - self.data.body("R_hand").xpos
        if press is not None:                  # pressing: hold position sideways by touch; force owns the normal
            n = np.asarray(press["normal"], float)
            self.touch += (err - n * (n @ err)) * dt / TOUCH_TAU
        else:                                  # the press is over: let go of its correction
            self.touch *= 1 - dt / TOUCH_RELEASE_S
        carrying = (self.t_lift + 0.2 <= tt < self.t_down - 0.2
                    and any(e["t0"] <= tt < e["t1"] for e in self.iv["hold_object"]))
        if carrying:                           # carrying the part: the eye is on the part, where it goes, not the hand
            k = min(len(self.rd["blank"]) - 1, int(round(self.plan_time(tt) * self.fps)))
            self.visual += (self.rd["blank"][k] * 0.001 - self.data.body("blank").xpos) * dt / CARRY_TAU
        elif press is None and not cranking and not self.hand_touching():
            self.visual += err * dt / VISUAL_TAU
        for v in (self.visual, self.touch):
            n = np.linalg.norm(v)
            if n > VISUAL_MAX:
                v *= VISUAL_MAX / n
        return self.visual + self.touch

    def hand_forces(self, tt: float) -> np.ndarray:
        """The torques for forces the hand applies on purpose: a press along its normal, and the push that turns
        the crank. People press and crank by pushing, not by misplacing the hand against a stiff arm, so these are
        planned forces, each trimmed by feedback (the integrals in `run`) and capped by the motors' strength."""
        m, d = self.model, self.data
        hand = self.body_id["R_hand"]
        tau = np.zeros(len(self.acts))

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
        """The torques that carry a held object's expected load: its weight, and the force its planned acceleration
        takes. People raise load force in step with grip force, expecting the object's weight (Guillery 2013's
        loading phase) and their own motion's inertial load (Flanagan & Wing 1993), so both are fed forward rather
        than discovered as sag and sway: without the inertia, a 1.4 kg part swung the arm 12-19 mm off its path and
        slipped 5 mm in the grip. Applied at where the object sits in the hand, mapped through the planned pose, and
        only while it is carried, before it rests on the parallels."""
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
        k = min(len(self.t) - 1, int(round(self.plan_time(tt) * self.fps)))
        return jacp[:, self.act_dof].T @ (self.load.mass_kg * (np.array([0.0, 0.0, 9.81]) + self.blank_acc[k]) * effort)

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
        turn = self.squaring(tt)
        if turn:                                           # turned about the part, so it stays where it is: the
            k = min(len(self.rd["blank"]) - 1, int(round(self.plan_time(tt) * self.fps)))   # planned hand round the
            r = p.body("R_hand").xpos - self.rd["blank"][k] * 0.001                          # planned part (the actual
            intended = intended + (np.array([[np.cos(turn), -np.sin(turn), 0], [np.sin(turn), np.cos(turn), 0],
                                             [0, 0, 1]]) @ r - r)                            # is turned already)
        self.intended = p.body("R_hand").xpos + intended          # the plan plus the deliberate corrections
        off = intended + self.visual_correction(tt)
        if off.any() or turn:
            dq += self.arm_ik(off, turn)
        if grip and effort > 0:
            sq = self.squeeze_offset(grip, effort, m.opt.timestep)
            if isinstance(sq, np.ndarray):
                dq += sq
        target[self.body_q] += dq[self.body_dof]
        precise = grip in PRECISION                    # accuracy demands raise co-contraction (Gribble et al. 2003)
        k = np.full(len(self.acts), 1.0 + STIFFEN_ARM * (1.0 if precise and effort > 0 else effort))
        k[self.hand_acts] = 1.0 + self.stiffen * effort
        m.actuator_gainprm[self.acts, 0] = self.kp0 * k
        m.actuator_biasprm[self.acts, 1] = -self.kp0 * k
        d.ctrl[self.acts] = target[self.act_q] + (tau + self.kv * v[self.act_dof]) / (self.kp0 * k)
        self.caps.apply(d)
        self.machine.apply()
        mujoco.mj_step(m, d)
        if self.onsets is not None:
            self.onsets.step(d)

    # --- measurement ---------------------------------------------------------------------------------
    def contacts(self):
        """(per-digit force on the objects, blank-to-moving-jaw clamp force, deepest digit contact in mm)."""
        m, d = self.model, self.data
        f, clamp, depth, c6 = {}, 0.0, 0.0, np.zeros(6)
        objs = {self.geom[n] for n in ("blank", "knob", *self.paras)}
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

    def lifting_force(self) -> float:
        """The hand's upward force on the blank (N, world z): its lifting force, against the part's weight."""
        m, d = self.model, self.data
        total, c6, blank = 0.0, np.zeros(6), self.geom["blank"]
        for i in range(d.ncon):
            c = d.contact[i]
            if blank in (c.geom1, c.geom2) and (c.geom2 if c.geom1 == blank else c.geom1) in self.geom_digit:
                mujoco.mj_contactForce(m, d, i, c6)
                fw = c.frame.reshape(3, 3).T @ c6[:3]
                total += float(fw[2] if c.geom2 == blank else -fw[2])
        return total

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
        dt = m.opt.timestep
        n = len(self.t) if seconds is None else min(len(self.t), int(seconds * fps))
        enc, lock = m.equality("enclose").id, m.equality("screw_lock").id
        keep = {nm: m.equality(f"keep_{nm}").id for nm in self.paras}
        rec = {k: [] for k in ("blank", "blank_R", "crank", "opening", "force", "clamp", "depth", "para", "press",
                               "slip", "lag", "pushing", "stray", "touching", "touch_lead", "pose", "hand_wrench",
                               "load_N", "active_constraints", "applied_forces")}
        right = np.array([m.geom(g).name.startswith("R_") for g in range(m.ngeom)])
        self.onsets = TouchOnsets(m, right, ~right)
        rec["machine_axes"] = {f"vf2_{a}": [] for a in ("x", "y", "z", "spindle")}
        spindle = m.jnt_dofadr[m.joint("vf2_spindle").id]
        hold_rel, t0w = None, time.time()
        hold0 = self.iv["hold_object"][0]
        root = m.body_rootid[m.body("R_hand").id]
        self.recorder = Recorder(m, {m.body(b).name for b in range(1, m.nbody) if m.body_rootid[b] == root})
        for k in range(n):
            tk = k / fps
            want_enc = any(e["t0"] <= tk < e["t1"] for e in self.iv["enclose"])
            if want_enc and not d.eq_active[enc]:
                # the knob held where the grip was planned in the hand, not wherever the hand happens to be: frozen
                # at the hand's real pose, the knob sat 5 mm nearer the lever than planned, and the index's base hit it
                kb, hb, p = self.body_id["knob"], self.body_id["R_hand"], self.plan
                self.set_plan(self.plan_time(tk))
                mujoco.mj_kinematics(m, p)
                pk = p.xpos[kb] + p.xmat[kb].reshape(3, 3) @ m.eq_data[enc, 0:3]
                m.eq_data[enc, 3:6] = p.xmat[hb].reshape(3, 3).T @ (pk - p.xpos[hb])
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
            if not self.offsets and self.iv["place_correct"] and tk >= self.iv["place_correct"][0]["t0"]:
                self.offsets.append((tk, self.measure_offset(k)))
            elif len(self.offsets) == 1 and self.resight_t is not None and tk >= self.resight_t:
                self.offsets.append((tk, self.measure_offset(k)))
            grip = str(rd["grip"][k])
            effort = float(rd["effort"][k])
            self.set_contact_coupling(grip)
            # the steps whose time falls in this frame, so physics time is the plan's: a fixed 33 steps a frame at
            # 1 ms ran the plan 1% slow against the body
            for s in range(round(k / (fps * dt)), round((k + 1) / (fps * dt))):
                tt = s * dt
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
            rec["opening"].append(self.load.opening0 - d.qpos[self.q_jaw] * 1000)
            rec["force"].append(f)
            rec["clamp"].append(clamp)
            rec["depth"].append(depth)
            rec["para"].append(np.array([d.body(nm).xpos * 1000 for nm in self.paras]).reshape(-1, 3))
            rec["pose"].append(self.pose_record())
            self.recorder.frame(d, {"R": rec["pose"][-1]}, rd["eye"][k], rd["look"][k], rd["up"][k])
            rec["lag"].append(float(np.linalg.norm(d.body("R_hand").xpos - self.intended) * 1000))
            rec["stray"].append(self.stray_contacts(grip, tk))
            rec["touching"].append(self.touching())
            rec["touch_lead"].append(self.onsets.frame())
            rec["hand_wrench"].append(hand_wrench(m, d, "R_hand"))
            rec["load_N"].append(round(self.lifting_force(), 3))
            rec["active_constraints"].append([m.equality(i).name for i in range(m.neq) if d.eq_active[i]])
            rec["applied_forces"].append([m.body(b).name for b in range(m.nbody) if d.xfrc_applied[b].any()])
            for a in ("x", "y", "z"):
                rec["machine_axes"][f"vf2_{a}"].append(round(float(d.qpos[self.machine.q[a]]) * 1000, 4))
            rec["machine_axes"]["vf2_spindle"].append(round(float(d.qvel[spindle]) * 60 / (2 * math.pi), 1))
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

    def pose_record(self) -> dict:
        """The body's pose this frame, in trainual's take terms (motion/body_model.py), for rendering."""
        m, d, b = self.model, self.data, self.body
        anat = lambda name: b.joints[name].rest + (math.degrees(d.qpos[m.jnt_qposadr[m.joint(name).id]])
                                                   if b.joints[name].kind == "hinge"
                                                   else d.qpos[m.jnt_qposadr[m.joint(name).id]] * 1000)  # noqa: E731
        from moonshot.sim.reference import ARM
        theta = [anat(n if n.startswith("trunk") else f"R_{n}") for n in ARM]
        names = [str(x) for x in self.rd["names"]]
        return {"q": [anat(f"R_{n}") for n in names], "theta": theta,
                "dp": [anat(f"pelvis_{a}") for a in "xyz"],
                "H": d.body("R_hand").xmat.reshape(3, 3) @ H0, "W": d.body("R_hand").xpos * 1000,
                "S": d.body("R_humerus").xpos * 1000, "E": d.body("R_forearm").xpos * 1000,
                "forearm": d.body("R_forearm").xmat.reshape(3, 3) @ H0}

    def export_sim(self, path: Path) -> None:
        """Write the run as trainual's sim.npz (sim/run_take.py's keys), so its skin bake and Cycles render take it,
        and beside it checks.json, what moonshot/validate/take.py reads that sim.npz doesn't carry. The camera is
        the reference's head path: the trunk follows the plan to within millimetres."""
        rec, rd = self.rec, self.rd
        n = len(rec["pose"])
        P = {k: np.array([p[k] for p in rec["pose"]]) for k in rec["pose"][0]}
        th = P["theta"]
        np.savez(path, t=rd["t"][:n], q=P["q"], H=P["H"], W=P["W"], S=P["S"], E=P["E"], forearm=P["forearm"],
                 theta=th, dp=P["dp"], arm=np.stack([th[:, 7], th[:, 8], th[:, 9], th[:, 6], np.zeros(n)], 1),
                 blank=np.array(rec["blank"]), blank_R=np.array(rec["blank_R"]), crank=np.array(rec["crank"]),
                 opening=np.array(rec["opening"]), para=np.array(rec["para"]), effort=rd["effort"][:n],
                 grip=rd["grip"][:n], clamp=np.array(rec["clamp"]), slip=np.array(rec["slip"]),
                 eye=rd["eye"][:n], look=rd["look"][:n], up=rd["up"][:n], names=rd["names"], fps=rd["fps"])
        (Path(path).parent / "checks.json").write_text(json.dumps(
            {k: rec[k] for k in ("touching", "touch_lead", "hand_wrench", "active_constraints", "applied_forces",
                                 "machine_axes")} |
            {"load_N": {"blank": rec["load_N"]}, "never_held": NEVER_HELD}), encoding="utf-8")
        glbs = glbs_in_bodies(self.model, "vf2", vf2.render_links())
        for body, entries in V.render_glbs().items():
            glbs.setdefault(body, []).extend(entries)
        self.recorder.write(Path(path).parent, self.fps, self.tk["lumbar"][0], {"R": [str(x) for x in rd["names"]]},
                            "vf2", glbs, V.render_meshes(self.load, Path(path).parent))

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
        # into the world by the hand as it is: turned to square the part up (squaring), the planned frame put the
        # correction 27 mm across the jaws
        return H @ (p_plan - p_act) * 0.001

    def report(self, n) -> dict:
        rec, t, fps = self.rec, self.t[:n], self.fps
        B, P = np.array(rec["blank"]), np.array(rec["para"])
        force = np.array([[f.get(dg, 0.0) for dg in ("thumb", "index", "middle", "ring", "little", "palm")]
                          for f in rec["force"]])
        lift = (t > self.t_lift + 0.15) & (t < self.t_down - 0.3)
        clips = {c["verb"]: c for c in self.tk["clips"]}
        lag, pushing = np.array(rec["lag"]), np.array(rec["pushing"], bool)
        stray = np.array([bool(x) for x in rec["stray"]])
        settled = t > 0.5                                  # the first half second is the body settling into its start
        pairs = sorted({p for x in rec["stray"] for p in x})
        out = {"frames": int(n), "seconds": round(float(t[-1]), 2),
               "max_lag_free_motion_mm": round(float(lag[settled & ~pushing & ~stray].max(initial=0)), 2),
               "stray_contact_s": round(float(stray.sum()) / fps, 2), "stray_contacts": pairs,
               "max_deviation_while_pushing_mm": round(float(lag[pushing].max(initial=0)), 2),
               "max_contact_depth_mm": round(float(max(rec["depth"])), 2)}
        if lift.any():
            # held up: over where it started; a lift-out's part ends on the table, below where it started in the vise,
            # so it is held up if it rose clear of where it started and never fell far under its planned path (it
            # starts up 20 mm behind the plan as the grip takes its weight, and rides ~11 mm low in the hand)
            if self.in_vise:
                held = (B[lift][:, 2].max() > self.start_p[2] + 5
                        and np.all(B[lift][:, 2] > self.rd["blank"][:n, 2][lift] - 40))
            else:
                held = np.all(B[lift][:, 2] > self.start_p[2] + 5)
            out["grab_hold"] = {"lifted_by_friction": bool(held),
                                "grip_N_thumb_median": round(float(np.median(force[lift, 0])), 2),
                                "grip_N_fingers_median": round(float(np.median(force[lift, 1:5].sum(1))), 2),
                                "max_slip_mm": round(float(np.max(rec["slip"])), 2)}
        kd = int(self.t_down * fps) + 8
        if kd < n:
            out["place"] = {"set_down_vs_planned_mm": [round(float(x), 2) for x in B[kd] - self.rd["blank"][kd]],
                            "tilt_deg": round(float(np.degrees(np.arccos(np.clip(rec["blank_R"][kd][2, 2], -1, 1)))), 2)}
        if self.in_vise:                                  # a lift-out has no slide, push, crank or parallels check
            return out
        sl = clips["slide"]
        if int(sl["t1"] * fps) <= n:
            out["slide"] = {"moved_mm": round(float(B[int(sl["t1"] * fps) - 1][1] - B[int(sl["t0"] * fps)][1]), 2),
                            "gap_to_fixed_jaw_after_mm": round(float(V.VISE["fixed_face_y"] -
                                                                     (B[int(sl["t1"] * fps) - 1][1] + self.load.half[1])), 2)}
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
                                   P[int(e["t1"] * fps), self.paras.index(e["contact"])] -
                                   P[int(e["t0"] * fps), self.paras.index(e["contact"])])), 3)} for e in msr]
        return out


def main(argv: list[str]) -> None:
    seconds = float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None
    run = ViseTake(Path(argv[argv.index("--take") + 1]) if "--take" in argv else None)
    rep = run.run(seconds)
    if "--export" in argv:
        run.export_sim(Path(argv[argv.index("--export") + 1]))
    ref = json.loads((take_dir() / "sim-report.json").read_text(encoding="utf-8"))
    print(json.dumps({"new_core": rep, "trainual": ref}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
