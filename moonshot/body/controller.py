"""Drives the body model's motors toward target angles no faster than each joint can move (plan §3.1).

A position servo alone would jump to a new target as fast as its strength allows. Like a robot joint controller,
this slews each motor's setpoint toward its target at the joint's measured top speed (anatomy.json body
speed_max_deg_s), so a planner can't make an arm move faster than a person's. Joints with no recorded top speed
(the fingers) are not capped; that is a known gap, not a claim that fingers are unlimited.
"""
from __future__ import annotations

import math

import mujoco
import numpy as np

from moonshot.body.skeleton import BodyModel


class Controller:
    def __init__(self, body: BodyModel, model: mujoco.MjModel, data: mujoco.MjData):
        self.model, self.data = model, data
        self.acts, self.max_step, self.rest, self.unit = [], [], [], []
        for j in body.joints.values():
            if not j.driven:
                continue
            self.acts.append(model.actuator(f"a_{j.name}").id)
            to_q = math.radians if j.kind == "hinge" else (lambda x: x * 0.001)
            self.unit.append(to_q)
            self.rest.append(j.rest)
            self.max_step.append(to_q(j.speed) * model.opt.timestep if j.speed else math.inf)
        self.names = [j.name for j in body.joints.values() if j.driven]
        self.index = {n: i for i, n in enumerate(self.names)}
        self.target = np.array([data.ctrl[a] for a in self.acts], dtype=float)

    def set(self, anatomical: dict[str, float]) -> None:
        """New targets, in anatomical degrees (mm for the shoulder girdle), by joint name."""
        for name, value in anatomical.items():
            i = self.index[name]
            lo, hi = self.model.actuator_ctrlrange[self.acts[i]]
            self.target[i] = float(np.clip(self.unit[i](value - self.rest[i]), lo, hi))

    def step(self) -> None:
        """Move each setpoint one timestep toward its target, then step the physics."""
        for i, a in enumerate(self.acts):
            delta = self.target[i] - self.data.ctrl[a]
            self.data.ctrl[a] += float(np.clip(delta, -self.max_step[i], self.max_step[i]))
        mujoco.mj_step(self.model, self.data)

    def run(self, seconds: float) -> None:
        for _ in range(round(seconds / self.model.opt.timestep)):
            self.step()
