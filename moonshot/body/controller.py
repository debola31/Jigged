"""Drives the body model's motors: like a robot joint controller, and like the nervous system, it anticipates.

Every motor is a position servo capped at its joint's strength (moonshot/body/skeleton.py), and that strength
follows the joint's angle and speed as people's does (`StrengthCaps`, from strength.json's curves). A servo that only
reacts to error lags under load: driving trainual's vise take that way left the wrist a median 20 mm behind its
plan. So each motor's command also carries the torque the motion is expected to need, still capped by the motor's
strength, so feedforward can never make the body stronger than a person:

- `set` + `step`: a new target per joint, approached no faster than the joint's measured top speed
  (anatomy.json body speed_max_deg_s), with gravity and velocity forces fed forward.
- `track`: a planned trajectory (position, velocity, acceleration per joint), with full inverse dynamics fed
  forward. On the reference take this keeps the wrist within 0.1 mm of plan. A plan's speeds are not capped
  here; the production speed check judges them (plan §5.2).

Joints with no recorded top speed (the fingers) are not capped by `step`; a known gap, not a claim.
"""
from __future__ import annotations

import math

import mujoco
import numpy as np

from moonshot.body.skeleton import BodyModel


class StrengthCaps:
    """Each motor capped at its strength for its joint's angle and speed now: the peak (strength.json joints) times
    its curve (skeleton.StrengthCurve). MuJoCo's forcerange is one fixed pair per motor, so `apply` resets it from the
    curves before each step; a scene that steps MuJoCo itself (a take) calls it before each mj_step."""

    def __init__(self, body: BodyModel, model: mujoco.MjModel):
        self.model = model
        driven = [j for j in body.joints.values() if j.driven]
        self.acts = np.array([model.actuator(f"a_{j.name}").id for j in driven])
        jid = model.actuator_trnid[self.acts, 0]
        self.qadr, self.dof = model.jnt_qposadr[jid], model.jnt_dofadr[jid]
        self.rest = np.array([j.rest for j in driven])
        self.peak = np.array([j.strength for j in driven])                  # against, along
        # each motor's own side's wrist; the trunk's and pelvis's curves have no wrist term, so either serves
        wrists = {s: body.joints[f"{s}_wr_flex"] for s in "RL"}
        side = [j.name[0] if j.name[:2] in ("R_", "L_") else "R" for j in driven]
        self.wrist_q = np.array([model.jnt_qposadr[model.joint(wrists[s].name).id] for s in side])
        self.wrist_rest = np.array([wrists[s].rest for s in side])
        groups: dict = {}                                                   # (direction, curve) -> motors
        for i, j in enumerate(driven):
            for direction in (0, 1):
                groups.setdefault((direction, j.curves[direction]), []).append(i)
        self.groups = {k: np.array(v) for k, v in groups.items()}

    def apply(self, data: mujoco.MjData) -> None:
        angle = np.degrees(data.qpos[self.qadr]) + self.rest               # slides' curves are flat: units moot
        speed = np.degrees(data.qvel[self.dof])
        wrist = np.degrees(data.qpos[self.wrist_q]) + self.wrist_rest
        scale = np.ones_like(self.peak)
        for (direction, curve), i in self.groups.items():
            scale[i, direction] = curve.at(angle[i], speed[i] if direction else -speed[i], wrist[i])
        fr = self.model.actuator_forcerange
        fr[self.acts, 0] = -self.peak[:, 0] * scale[:, 0]
        fr[self.acts, 1] = self.peak[:, 1] * scale[:, 1]


class Controller:
    def __init__(self, body: BodyModel, model: mujoco.MjModel, data: mujoco.MjData):
        self.model, self.data = model, data
        driven = [j for j in body.joints.values() if j.driven]
        self.names = [j.name for j in driven]
        self.index = {n: i for i, n in enumerate(self.names)}
        self.acts = np.array([model.actuator(f"a_{n}").id for n in self.names])
        jid = model.actuator_trnid[self.acts, 0]
        self.dof, self.qadr = model.jnt_dofadr[jid], model.jnt_qposadr[jid]
        self.range = model.jnt_range[jid].copy()
        self.kp = model.actuator_gainprm[self.acts, 0].copy()
        self.kv = -model.actuator_biasprm[self.acts, 2].copy()
        self.unit = [math.radians if j.kind == "hinge" else (lambda x: x * 0.001) for j in driven]
        self.rest = [j.rest for j in driven]
        self.max_step = np.array([self.unit[i](j.speed) * model.opt.timestep if j.speed else math.inf
                                  for i, j in enumerate(driven)])
        self.target = data.qpos[self.qadr].copy()
        self.setpoint = self.target.copy()
        self._plan = mujoco.MjData(model)
        self.caps = StrengthCaps(body, model)

    def set(self, anatomical: dict[str, float]) -> None:
        """New targets, in anatomical degrees (mm for the girdle and pelvis), clamped to each joint's range."""
        for name, value in anatomical.items():
            i = self.index[name]
            self.target[i] = float(np.clip(self.unit[i](value - self.rest[i]), *self.range[i]))

    def step(self) -> None:
        """Move each setpoint one timestep toward its target at the joint's top speed, feed gravity forward, step."""
        self.setpoint += np.clip(self.target - self.setpoint, -self.max_step, self.max_step)
        d = self.data
        d.ctrl[self.acts] = self.setpoint + d.qfrc_bias[self.dof] / self.kp
        self.caps.apply(d)
        mujoco.mj_step(self.model, d)

    def run(self, seconds: float) -> None:
        for _ in range(round(seconds / self.model.opt.timestep)):
            self.step()

    def track(self, qpos: np.ndarray, qvel: np.ndarray, qacc: np.ndarray) -> None:
        """One timestep along a planned trajectory (full-length model vectors), with inverse dynamics fed forward."""
        p = self._plan
        p.qpos[:], p.qvel[:], p.qacc[:] = qpos, qvel, qacc
        mujoco.mj_inverse(self.model, p)
        self.setpoint = qpos[self.qadr].copy()
        self.data.ctrl[self.acts] = self.setpoint + (p.qfrc_inverse[self.dof] + self.kv * qvel[self.dof]) / self.kp
        self.caps.apply(self.data)
        mujoco.mj_step(self.model, self.data)

    def planned_body_pos(self, body: str) -> np.ndarray:
        """Where the plan put a body at the last `track` step (world, metres)."""
        return self._plan.body(body).xpos.copy()
