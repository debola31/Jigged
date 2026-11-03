"""A two-handed bench take, run on the full body model (plan §5.4): the physics both of nist-ftc-10's bench steps
share. The plan is moonshot/motion/bench.py's (reference.npz and take.json); the scene is moonshot/world/bench_cell.py.

What moonshot/sim/vise_take.py does for the right hand, for both, and no more than these takes need:
- every motor tracks the plan, the motion's own torques fed forward (inverse dynamics, no contacts);
- grip: each gripping digit squeezes along the direction that drives its pad into what it holds, scaled by the
  grip's effort, and the hand stiffens with effort (co-contraction);
- carry: the declared shortcut, a soft weld from the right hand to the tool, switched on where the grip was planned
  in the hand and off when the tool is set down (moonshot/world/bench_cell.py);
- press: a force the hand applies on purpose along a planned direction, at its contact (or at a carried tool's
  working part), trimmed by integral control on the measured contact force, as people press.

    run = BenchRun(folder, loose, carried, skip); run.run(); run.export()   # sim.npz, checks.json, the take record
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import mujoco
import numpy as np

from moonshot.body.skeleton import H0, MIRROR, build, set_finger_contact
from moonshot.motion import kinematics as BM
from moonshot.sim.record import Recorder
from moonshot.sim.reference import ARM, ReferenceTake
from moonshot.world import bench_cell as BC

SQUEEZE_DEG = 5.5         # as the vise take's, with capsules 2.5 mm inside the pads
STIFFEN = 4.0
STIFFEN_ARM = 3.0
PRESS_KI = 20.0           # the pushed force grows 20 N/s per newton it falls short
NEAR_M = 0.02
TOUCH_N = 0.2
DAMPING = 0.02            # damped least squares for the hand's corrections (m)
TOUCH_TAU = 0.07          # a tool's point is kept on its path by touch this fast (s): tactile slip responses take ~70 ms
                          # (Johansson & Westling 1984), as in the vise take
TOUCH_RELEASE_S = 0.2     # after a press, its touch correction fades with this time constant (s)
HOLD_AFTER_S = 0.8        # a steadying hand holds where it landed until this long after its press, clear of the part
SIGHT_LEAD_S = 0.6        # before a tool's point lands, it is guided by sight for this long (s) ...
SIGHT_TAU = 0.15          # ... correcting where it is going this fast (s)
POINT_N_PER_M = 300.0     # and pushing it there: 3 N for a centimetre off (proposed); at 5 it added enough sideways
                          # push to the press to slide the steadied part
GUIDE_MAX = 0.015         # ... by at most this much (m)
DIGITS = {"thumb": ["met1", "pro1", "dis1"], "index": ["pro2", "int2", "dis2"], "middle": ["pro3", "int3", "dis3"],
          "ring": ["pro4", "int4", "dis4"], "little": ["pro5", "int5", "dis5"],
          "palm": ["palm", "met2", "met3", "met4", "met5"]}
PAD = {"thumb": "dis1", "index": "dis2", "middle": "dis3", "ring": "dis4", "little": "dis5"}
ARM_JOINTS = ARM[3:]


def min_jerk(x: float) -> float:
    c = min(1.0, max(0.0, x))
    return c * c * c * (10 - 15 * c + 6 * c * c)


class BenchRun:
    def __init__(self, folder: Path, loose: str, carried: tuple[str, ...] = (), skip: tuple[str, ...] = (),
                 grip_objects: dict[str, tuple[str, ...]] | None = None):
        """grip_objects: each grip's name -> the bodies its digits squeeze into."""
        self.folder = Path(folder)
        self.tk = json.loads((self.folder / "take.json").read_text(encoding="utf-8"))
        self.rd = np.load(self.folder / "reference.npz")
        self.body = build(pelvis_mm=tuple(self.tk["lumbar"]))
        self.xml = BC.with_body(self.body.xml, loose, carried, skip)
        m = self.model = mujoco.MjModel.from_xml_string(self.xml)
        self.data, self.plan = mujoco.MjData(m), mujoco.MjData(m)
        self.ref = ReferenceTake(self.body, m, self.folder)
        self.t, self.fps = self.rd["t"], int(self.rd["fps"])
        self.acts = np.arange(m.nu)
        jid = m.actuator_trnid[self.acts, 0]
        self.act_dof, self.act_q = m.jnt_dofadr[jid], m.jnt_qposadr[jid]
        self.kp0 = m.actuator_gainprm[self.acts, 0].copy()
        self.kv = -m.actuator_biasprm[self.acts, 2].copy()
        names = [m.actuator(a).name[2:] for a in self.acts]
        self.side_acts = {s: (np.array([a for a, n in enumerate(names) if n.startswith(f"{s}_") and n[2:] in ARM_JOINTS]),
                              np.array([a for a, n in enumerate(names) if n.startswith(f"{s}_") and n[2:] not in ARM_JOINTS]))
                          for s in ("R", "L")}
        self.act_of_dof = {int(dof): a for a, dof in enumerate(self.act_dof)}
        self.digit_dofs = {(s, dg): [int(m.jnt_dofadr[j]) for j in range(m.njnt) if m.joint(j).name.startswith(f"{s}_{dg}_")
                                     and int(m.jnt_dofadr[j]) in self.act_of_dof] for s in ("R", "L") for dg in PAD}
        self.geom_digit = {m.geom(f"{s}_g_{b}").id: (s, dg) for s in ("R", "L") for dg, bs in DIGITS.items() for b in bs}
        self.body_geoms = {m.body(b).name: [g for g in range(m.ngeom) if m.geom_bodyid[g] == b] for b in range(m.nbody)}
        self.grip_objects = grip_objects or {}
        self.body_q = np.array([m.jnt_qposadr[m.joint(n).id] for n in self.body.joints])
        self.body_dof = np.array([m.jnt_dofadr[m.joint(n).id] for n in self.body.joints])
        self.person = {m.body(b).name for b in range(1, m.nbody) if m.body_rootid[b] == m.body("pelvis").id}
        ev = self.tk["events"]
        self.grips = [e for e in ev if e["kind"] == "grip"]
        self.carries = [e for e in ev if e["kind"] == "carry"]
        self.presses = [e for e in ev if e["kind"] == "press"]
        self.press_i: dict[int, float] = {}
        self.squeeze: dict[tuple, dict] = {}
        self.contact_label = {"R": set(), "L": set()}
        self.correction: dict[str, tuple] = {}
        self.guide = np.zeros(3)
        self.anchors: dict[int, np.ndarray] = {}
        self.contact_bits = {g: (int(m.geom_contype[g]), int(m.geom_conaffinity[g])) for g in range(m.ngeom)}
        self.side_arm_dofs = {s: np.array([m.jnt_dofadr[m.joint(f"{s}_{j}").id] for j in ARM_JOINTS]) for s in ("R", "L")}
        self.arm_dofs = self.side_arm_dofs["R"]
        self.dof_q = np.zeros(m.nv, dtype=int)                 # each hinge or slide dof's qpos address
        for j in range(m.njnt):
            if m.jnt_type[j] in (mujoco.mjtJoint.mjJNT_HINGE, mujoco.mjtJoint.mjJNT_SLIDE):
                self.dof_q[m.jnt_dofadr[j]] = m.jnt_qposadr[j]

    # --- the plan ------------------------------------------------------------------------------------------------
    def set_plan(self, tt: float) -> np.ndarray:
        q, v, a = self.ref.at(tt)
        p = self.plan
        p.qpos[:] = self.data.qpos
        p.qpos[self.body_q] = q[self.body_q]
        p.qvel[:], p.qacc[:] = 0, 0
        p.qvel[self.body_dof], p.qacc[self.body_dof] = v[self.body_dof], a[self.body_dof]
        return p.qvel.copy()

    def grip_at(self, side: str, tt: float) -> str:
        g = self.rd["grip" if side == "R" else "L_grip"]
        return str(g[min(len(g) - 1, int(round(tt * self.fps)))])

    def effort_at(self, side: str, tt: float) -> float:
        return float(np.interp(tt, self.t, self.rd["effort" if side == "R" else "L_effort"]))

    # --- control -------------------------------------------------------------------------------------------------
    def object_geoms(self, grip: str) -> list[int]:
        return [g for b in self.grip_objects.get(grip, ()) for g in self.body_geoms[b]]

    def nearest(self, geom: int, objs: list[int], within: float):
        """(distance, fromto) from a geom to the nearest of objs, or (within, None)."""
        best, ft = (within, None), np.zeros(6)
        for o in objs:
            dist = mujoco.mj_geomDistance(self.model, self.data, geom, o, within, ft)
            if dist < best[0]:
                best = (dist, ft.copy())
        return best

    def grip_squeeze(self, side: str, grip: str) -> dict[str, np.ndarray]:
        """Per digit on the gripped object: the unit joint direction driving its pad into it (its Jacobian)."""
        m, d = self.model, self.data
        out, objs = {}, self.object_geoms(grip)
        for dg, seg in PAD.items():
            g = m.geom(f"{side}_g_{seg}").id
            dist, ft = self.nearest(g, objs, 0.025)
            if ft is None:
                continue
            n = (ft[3:] - ft[:3]) * (1.0 if dist >= 0 else -1.0)
            n = n / (np.linalg.norm(n) + 1e-12)
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, ft[:3], m.geom_bodyid[g])
            v = np.zeros(m.nv)
            idx = self.digit_dofs[(side, dg)]
            v[idx] = jacp[:, idx].T @ n
            if np.linalg.norm(v) > 0:
                out[dg] = v / np.linalg.norm(v)
        return out

    def set_contact_coupling(self, side: str, grip: str) -> None:
        m, near = self.model, set()
        if grip:
            objs = self.object_geoms(grip)
            near = {dg for dg, seg in PAD.items() if dg != "thumb" and
                    self.nearest(m.geom(f"{side}_g_{seg}").id, objs, NEAR_M)[1] is not None}
        if near != self.contact_label[side]:
            for finger in ("index", "middle", "ring", "little"):
                set_finger_contact(m, self.body, side, finger, finger in near)
            self.contact_label[side] = near

    def press_point(self, e: dict) -> tuple[np.ndarray, int]:
        """Where a press pushes: a carried tool's working geom's contact with the part, else the hand's contacts with
        it; else the tool's geom or the wrist. (world point, the hand body the force acts through)."""
        m, d = self.model, self.data
        hand = m.body(f"{e['side']}_hand").id
        targets = set(self.body_geoms[e["contact"]])
        pts = []
        for i in range(d.ncon):
            c = d.contact[i]
            pair = {c.geom1, c.geom2}
            if not pair & targets:
                continue
            other = (pair - targets).pop() if len(pair - targets) == 1 else None
            if other is None:
                continue
            if e.get("at") and m.geom(other).name == e["at"]:
                pts.append(c.pos.copy())
            elif not e.get("at") and self.geom_digit.get(other, ("", ""))[0] == e["side"]:
                pts.append(c.pos.copy())
        if pts:
            return np.mean(pts, axis=0), hand
        if e.get("at"):
            return d.geom_xpos[m.geom(e["at"]).id].copy(), hand
        return d.xpos[hand].copy(), hand

    def press_force(self, e: dict) -> float:
        """The press's measured force along its push (-normal): the tool's working geom's, or the side's digits',
        contacts with what it presses."""
        m, d = self.model, self.data
        targets, n = set(self.body_geoms[e["contact"]]), np.asarray(e["normal"], float)
        total, c6 = 0.0, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            g1, g2 = c.geom1, c.geom2
            if not ({g1, g2} & targets) or ({g1, g2} <= targets):
                continue
            other = g2 if g1 in targets else g1
            mine = m.geom(other).name == e["at"] if e.get("at") else self.geom_digit.get(other, ("", ""))[0] == e["side"]
            if not mine:
                continue
            mujoco.mj_contactForce(m, d, i, c6)
            fw = c.frame.reshape(3, 3).T @ c6[:3]           # on geom2, from geom1
            fw = fw if g2 in targets else -fw               # on the pressed object
            total += float(-fw @ n)
        return total

    def hand_forces(self, tt: float) -> np.ndarray:
        """The torques of every press active at tt: its planned force (eased in, and out after it ends) plus its
        integral trim, at its point, through its arm's (and hand's) joints."""
        m, d = self.model, self.data
        tau = np.zeros(len(self.acts))
        for i, e in enumerate(self.presses):
            if not e["t0"] <= tt < e["t1"] + 0.15:
                continue
            fade = 1 - min_jerk((tt - e["t1"]) / 0.15) if tt > e["t1"] else 1.0
            mag = max(0.0, e["force"] * min_jerk((tt - e["t0"]) / 0.25) + self.press_i.get(i, 0.0)) * fade
            point, body = self.press_point(e)
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, point, body)
            tau += jacp[:, self.act_dof].T @ (-np.asarray(e["normal"], float) * mag)
        return tau + self.point_push(tt)

    def steady_hold(self, tt: float) -> np.ndarray:
        """Joint offsets for a hand holding a part still by pressing on it: once it has landed it holds where it is,
        its arm's joints kept that far from their plan for the press and until it is clear (HOLD_AFTER_S, then eased
        out over 0.3 s), so the plan's few
        millimetres elsewhere don't drag the part. With the plan alone the hand pulled the part 11 mm across the bench,
        and on a rubber mat still crept it 4.6 mm; relaxed, it sagged as it landed and slid the part 7 mm."""
        m, d = self.model, self.data
        dq = np.zeros(m.nv)
        for i, e in enumerate(self.presses):
            if e.get("at") or not e["t0"] <= tt < e["t1"] + HOLD_AFTER_S + 0.3:
                continue
            dofs = self.side_arm_dofs[e["side"]]
            if i not in self.anchors:
                self.anchors[i] = d.qpos[self.dof_q[dofs]] - self.plan.qpos[self.dof_q[dofs]]
            dq[dofs] += self.anchors[i] * (1 - min_jerk((tt - e["t1"] - HOLD_AFTER_S) / 0.3))
        return dq

    def point_push(self, tt: float) -> np.ndarray:
        """Where a press works a carried tool's point along a path, the hand pushes that point toward where it should
        be, as seen and then felt: a spring of POINT_N_PER_M from SIGHT_LEAD_S before it lands, sideways to the press
        once it does (the press's force owns its direction). Joint positions alone left it 10-15 mm off: the arm's
        joints each track to a degree or two, which adds up over the arm."""
        m, d = self.model, self.data
        e = next((e for e in self.presses if e.get("point") and e["t0"] - SIGHT_LEAD_S <= tt < e["t1"]), None)
        if e is None:
            return np.zeros(len(self.acts))
        k = min(len(self.t) - 1, int(round(tt * self.fps)))
        pt = np.asarray(e["point"], float) * 0.001
        planned = self.rd[f"obj_{e['obj']}"][k] * 0.001 + self.rd[f"obj_{e['obj']}_R"][k] @ pt
        ob = m.body(e["obj"]).id
        real = d.xpos[ob] + d.xmat[ob].reshape(3, 3) @ pt
        err = planned - real
        if tt >= e["t0"]:
            n = np.asarray(e["normal"], float)
            err = err - n * (n @ err)
        jacp = np.zeros((3, m.nv))
        mujoco.mj_jac(m, d, jacp, None, real, m.body(f"{e['side']}_hand").id)
        return jacp[:, self.act_dof].T @ (err * POINT_N_PER_M)

    def step(self, tt: float) -> None:
        m, d, p = self.model, self.data, self.plan
        v = self.set_plan(tt)
        flags = m.opt.disableflags
        m.opt.disableflags = flags | int(mujoco.mjtDisableBit.mjDSBL_CONSTRAINT)
        mujoco.mj_inverse(m, p)
        m.opt.disableflags = flags
        tau = p.qfrc_inverse[self.act_dof].copy() + self.hand_forces(tt)
        target = p.qpos.copy()
        dq = self.carry_offset(tt) + self.steady_hold(tt)
        k = np.ones(len(self.acts))
        for side in ("R", "L"):
            grip, effort = self.grip_at(side, tt), self.effort_at(side, tt)
            arm, hand = self.side_acts[side]
            # placing a tool's point is precise work: the arm co-contracts fully (Gribble et al. 2003), as the vise
            # take's does for a fingertip check
            precise = any(e.get("point") and e["side"] == side and e["t0"] - SIGHT_LEAD_S <= tt < e["t1"]
                          for e in self.presses)
            k[arm], k[hand] = 1.0 + STIFFEN_ARM * (1.0 if precise else effort), 1.0 + STIFFEN * effort
            if grip and effort > 0:
                key = (side, grip, self.grip_span(side, tt))
                if key not in self.squeeze:
                    self.squeeze[key] = self.grip_squeeze(side, grip)
                dq += sum((u * math.radians(SQUEEZE_DEG) * effort for u in self.squeeze[key].values()), np.zeros(m.nv))
        target[self.body_q] += dq[self.body_dof]
        m.actuator_gainprm[self.acts, 0] = self.kp0 * k
        m.actuator_biasprm[self.acts, 1] = -self.kp0 * k
        d.ctrl[self.acts] = target[self.act_q] + (tau + self.kv * v[self.act_dof]) / (self.kp0 * k)
        mujoco.mj_step(m, d)

    def grip_span(self, side, tt):
        """Which of the side's grip events tt falls in: its squeeze directions are measured once per grip."""
        return next((i for i, e in enumerate(self.grips) if e["side"] == side and e["t0"] <= tt < e["t1"] + 0.2), -1)

    def switch_carries(self, tt: float) -> None:
        """A carry weld turns on holding the tool where it really is in the hand, and off when it is set down. Where
        that differs from the plan's grip is measured as it closes, for the hand to correct by sight (`carry_offset`),
        as the vise take's hand does for the blank."""
        m, d, p = self.model, self.data, self.plan
        for e in self.carries:
            eq = m.equality(f"carry_{e['obj']}").id
            want = e["t0"] <= tt < e["t1"]
            if want and not d.eq_active[eq]:
                hb, ob = m.body("R_hand").id, m.body(e["obj"]).id
                Rh, Ro = d.xmat[hb].reshape(3, 3), d.xmat[ob].reshape(3, 3)
                rel_act = (Rh.T @ Ro, Rh.T @ (d.xpos[ob] - d.xpos[hb]))
                qrel = np.zeros(4)
                mujoco.mju_mat2Quat(qrel, rel_act[0].flatten())
                m.eq_data[eq, 0:3] = 0.0                                  # the tool's origin, where it is in the hand
                m.eq_data[eq, 3:6] = rel_act[1]
                m.eq_data[eq, 6:10] = qrel
                d.eq_active[eq] = 1
                # held, the tool no longer collides with the skin: welded to the hand, the hand's own capsules pushing
                # on it only twist it in the weld (10 deg at the tip of the deburring tool). It still meets the bench
                # and the part; the skin's depth in it is checked (moonshot/validate/skin.py)
                for g in self.body_geoms[e["obj"]]:
                    m.geom_contype[g], m.geom_conaffinity[g] = 0, 1
                # where the plan has the tool in the hand: its planned pose in the planned hand
                self.set_plan(tt)
                mujoco.mj_kinematics(m, p)
                k = min(len(self.t) - 1, int(round(tt * self.fps)))
                po, Rp = self.rd[f"obj_{e['obj']}"][k] * 0.001, self.rd[f"obj_{e['obj']}_R"][k]
                Rhp = p.xmat[hb].reshape(3, 3)
                rel_plan = (Rhp.T @ Rp, Rhp.T @ (po - p.xpos[hb]))
                # the hand's own correction C, in its frame, so that hand_plan * C * rel_act = hand_plan * rel_plan
                Rc = rel_plan[0] @ rel_act[0].T
                self.correction[e["obj"]] = (Rc, rel_plan[1] - Rc @ rel_act[1], tt, e["t1"])
            elif not want and d.eq_active[eq]:
                d.eq_active[eq] = 0
                for g in self.body_geoms[e["obj"]]:
                    m.geom_contype[g], m.geom_conaffinity[g] = self.contact_bits[g]

    def carry_offset(self, tt: float) -> np.ndarray:
        """Joint offsets moving the right hand from its planned pose by each active carry's correction, whole until the
        tool is let go and eased out over 0.4 s after: what the tool really sits like in the hand, fixed by sight. It
        starts whole, as it is where the hand already is when it closes; eased out while still held, it swung the tool
        off its rest as it was set down. Through the arm's 9 joints at the planned pose, position and turn together
        (damped least squares)."""
        m, p = self.model, self.plan
        hb = m.body("R_hand").id
        dq = np.zeros(m.nv)
        err = np.r_[self.touch_guide(tt), np.zeros(3)]
        for Rc, pc, t0, t1 in self.correction.values():
            if not t0 <= tt < t1 + 0.4:
                continue
            w = 1 - min_jerk((tt - t1) / 0.4)
            Rh = p.xmat[hb].reshape(3, 3)
            rv = np.zeros(3)
            q = np.zeros(4)
            mujoco.mju_mat2Quat(q, Rc.flatten())
            mujoco.mju_quat2Vel(rv, q, 1.0)
            err += np.r_[Rh @ pc, Rh @ rv] * w
        if err.any():
            jacp, jacr = np.zeros((3, m.nv)), np.zeros((3, m.nv))
            mujoco.mj_jacBody(m, p, jacp, jacr, hb)
            J = np.r_[jacp, jacr][:, self.arm_dofs]
            dq[self.arm_dofs] += J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(6), err)
        return dq

    def touch_guide(self, tt: float) -> np.ndarray:
        """While a press works a carried tool's point along a path, the hand keeps that point on its planned path: by
        sight over the SIGHT_LEAD_S before it lands (within SIGHT_TAU), then by touch, sideways to the press (the
        force owns the press's direction), within TOUCH_TAU, as the vise take's fingertip is kept on a parallel. Let go
        of over TOUCH_RELEASE_S once the press is over."""
        m, d, dt = self.model, self.data, self.model.opt.timestep
        e = next((e for e in self.presses if e.get("point") and e["t0"] - SIGHT_LEAD_S <= tt < e["t1"]), None)
        if e is None:
            self.guide *= 1 - dt / TOUCH_RELEASE_S
            return self.guide
        k = min(len(self.t) - 1, int(round(tt * self.fps)))
        pt = np.asarray(e["point"], float) * 0.001
        planned = self.rd[f"obj_{e['obj']}"][k] * 0.001 + self.rd[f"obj_{e['obj']}_R"][k] @ pt
        ob = m.body(e["obj"]).id
        err = planned - (d.xpos[ob] + d.xmat[ob].reshape(3, 3) @ pt)
        if tt < e["t0"]:
            self.guide += err * dt / SIGHT_TAU
        else:
            n = np.asarray(e["normal"], float)
            self.guide += (err - n * (n @ err)) * dt / TOUCH_TAU
        size = np.linalg.norm(self.guide)
        if size > GUIDE_MAX:
            self.guide *= GUIDE_MAX / size
        return self.guide

    # --- measurement ---------------------------------------------------------------------------------------------
    def touching(self, side: str) -> list[str]:
        m, d = self.model, self.data
        out = set()
        for i in range(d.ncon):
            g1, g2 = d.contact[i].geom1, d.contact[i].geom2
            for a, b in ((g1, g2), (g2, g1)):
                if m.geom(a).name.startswith(f"{side}_") and m.body(m.geom_bodyid[b]).name not in self.person:
                    out.add(m.geom(b).name)
        return sorted(out)

    def anat(self, name: str) -> float:
        m, d, j = self.model, self.data, self.body.joints[name]
        q = d.qpos[m.jnt_qposadr[m.joint(name).id]]
        return j.rest + (math.degrees(q) if j.kind == "hinge" else q * 1000)

    def pose_record(self) -> dict:
        """Both hands as NIMBLE poses them (the left as the mirrored world's right hand), and the body's angles."""
        d, lumbar = self.data, np.array(self.tk["lumbar"], float)
        names = [str(x) for x in self.rd["names"]]
        out = {"theta": [self.anat(n) for n in ARM[:3]] + [self.anat(f"{s}_{n}") for s in ("R", "L") for n in ARM[3:]],
               "dp": [self.anat(f"pelvis_{a}") for a in "xyz"]}
        for s in ("R", "L"):
            frame = (lambda R: R) if s == "R" else (lambda R: MIRROR @ R @ MIRROR)               # noqa: E731
            point = (lambda p: p) if s == "R" else (lambda p: BM.mirror_points(p, lumbar))       # noqa: E731
            out[s] = {"q": [self.anat(f"{s}_{n}") for n in names],
                      "H": frame(d.body(f"{s}_hand").xmat.reshape(3, 3)) @ H0,
                      "W": point(d.body(f"{s}_hand").xpos * 1000), "S": point(d.body(f"{s}_humerus").xpos * 1000),
                      "E": point(d.body(f"{s}_forearm").xpos * 1000),
                      "forearm": frame(d.body(f"{s}_forearm").xmat.reshape(3, 3)) @ H0}
        return out

    # --- the run -------------------------------------------------------------------------------------------------
    def run(self, seconds: float | None = None, log=print, measure=None) -> None:
        """measure(run, frame): the step's own per-frame measurement, after each frame's physics."""
        m, d = self.model, self.data
        for qadr, dof, s in self.ref.splines:
            d.qpos[qadr], d.qvel[dof] = s(0.0), s(0.0, 1)
        mujoco.mj_forward(m, d)
        for _ in range(500):                                  # the objects settle, and the body at its start
            self.step(0.0)
        spf = int(round(1.0 / (self.fps * m.opt.timestep)))
        n = len(self.t) if seconds is None else min(len(self.t), int(seconds * self.fps))
        self.recorder = Recorder(m, self.person, arms=("R", "L"))
        self.rec = {"pose": [], "touching": [], "press": [], "lag": []}
        t0w = time.time()
        for k in range(n):
            for s in range(spf):
                tt = (k + s / spf) / self.fps
                self.switch_carries(tt)
                if s == 0:
                    for side in ("R", "L"):
                        self.set_contact_coupling(side, self.grip_at(side, tt))
                for i, e in enumerate(self.presses):
                    if e["t0"] <= tt < e["t1"]:
                        F = self.press_force(e)
                        err = e["force"] * min_jerk((tt - e["t0"]) / 0.25) - F
                        if F > TOUCH_N:                       # trim only while touching: no windup into empty space
                            self.press_i[i] = float(np.clip(self.press_i.get(i, 0.0) + PRESS_KI * err * m.opt.timestep,
                                                            -e["force"], 2 * e["force"]))
                self.step(tt)
            pose = self.pose_record()
            self.rec["pose"].append(pose)
            self.recorder.frame(d, {"R": pose["R"], "L": pose["L"]}, self.rd["eye"][k], self.rd["look"][k],
                                self.rd["up"][k])
            self.rec["touching"].append(sorted(set(self.touching("R")) | set(self.touching("L"))))
            tk = k / self.fps
            self.rec["press"].append({i: self.press_force(e) for i, e in enumerate(self.presses)
                                      if e["t0"] <= tk < e["t1"]})
            self.set_plan(tk)
            mujoco.mj_kinematics(m, self.plan)
            self.rec["lag"].append([float(np.linalg.norm(d.body(f"{s}_hand").xpos - self.plan.body(f"{s}_hand").xpos)
                                          * 1000) for s in ("R", "L")])
            if measure:
                measure(self, k)
            if k % 60 == 0:
                log(f"frame {k}/{n} ({time.time() - t0w:.0f} s): lag R {self.rec['lag'][-1][0]:.1f} "
                    f"L {self.rec['lag'][-1][1]:.1f} mm; press {({i: round(f, 1) for i, f in self.rec['press'][-1].items()})}")
        self.n = n

    def press_median(self, i: int, lead: float = 0.3) -> float:
        """A press's median measured force over its span, its first lead seconds aside."""
        e = self.presses[i]
        vals = [f[i] for k, f in enumerate(self.rec["press"]) if i in f and k / self.fps >= e["t0"] + lead]
        return round(float(np.median(vals)), 2) if vals else 0.0

    def export(self, station: str, never_held: list[str], solids: list[str], glbs: dict[str, list[dict]],
               report: dict) -> None:
        """sim.npz (the vise take's keys for the right arm, L_* for the left, theta with both arms), checks.json (what
        moonshot/validate/take.py reads), the take record, and report.json (the run's measured outcomes)."""
        rec, rd, n, out = self.rec, self.rd, self.n, self.folder
        P = rec["pose"]
        arrays = {"t": rd["t"][:n], "theta": np.array([p["theta"] for p in P]), "dp": np.array([p["dp"] for p in P]),
                  "eye": rd["eye"][:n], "look": rd["look"][:n], "up": rd["up"][:n], "names": rd["names"], "fps": rd["fps"]}
        for s in ("R", "L"):
            pre = "" if s == "R" else "L_"
            arrays |= {pre + key: np.array([p[s][key] for p in P]) for key in ("q", "H", "W", "S", "E", "forearm")}
        np.savez(out / "sim.npz", **arrays)
        (out / "checks.json").write_text(json.dumps({"touching": rec["touching"], "never_held": never_held,
                                                     "solids": solids, "arms": ["R", "L"]}), encoding="utf-8")
        self.recorder.write(out, self.fps, self.tk["lumbar"][0], {s: [str(x) for x in rd["names"]] for s in ("R", "L")},
                            station, glbs)
        lag = np.array(rec["lag"])
        report = {"frames": n, "seconds": round(float(rd["t"][n - 1]), 2),
                  "max_lag_mm": {"R": round(float(lag[:, 0].max()), 2), "L": round(float(lag[:, 1].max()), 2)}} | report
        (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
