"""trainual's accepted vise setup take, as a planned trajectory for the body model (plan §5.4, step 1).

The take's reference.npz holds the solved motion at 30 fps: 12 trunk and right-arm angles (`theta`, trainual's
motion/body_model.py order), 26 hand angles (`q`), and the pelvis shift (`dp`, mm). Cubic splines through them
give position, velocity and acceleration at any instant, which is what the controller's `track` needs.
At the same angles the body model puts the elbow exactly where trainual's kinematics did and the wrist within
1.2 mm, so the two describe the same body.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import mujoco
import numpy as np
from scipy.interpolate import CubicSpline

from moonshot.body.skeleton import BodyModel
from moonshot.config import data_root

ARM = ["trunk_flex", "trunk_lat", "trunk_rot", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex",
       "wr_dev", "sc_prot", "sc_elev"]


def take_dir() -> Path:
    return data_root() / "reference" / "setup-take"


class ReferenceTake:
    def __init__(self, body: BodyModel, model: mujoco.MjModel, folder: Path | None = None):
        folder = folder or take_dir()
        ref = np.load(folder / "reference.npz")
        self.take = json.loads((folder / "take.json").read_text(encoding="utf-8"))
        self.t = ref["t"]
        self.duration = float(self.t[-1])
        self.lumbar_m = np.array(self.take["lumbar"]) / 1000
        cols = {(n if n.startswith("trunk") else f"R_{n}"): ref["theta"][:, i] for i, n in enumerate(ARM)}
        cols |= {f"R_{n}": ref["q"][:, i] for i, n in enumerate(map(str, ref["names"]))}
        cols |= {f"pelvis_{a}": ref["dp"][:, i] for i, a in enumerate("xyz")}
        self.nq, self.nv = model.nq, model.nv
        self.splines = []
        for name, values in cols.items():
            j = body.joints[name]
            q = np.radians(values - j.rest) if j.kind == "hinge" else (values - j.rest) / 1000
            self.splines.append((model.jnt_qposadr[model.joint(name).id], model.jnt_dofadr[model.joint(name).id],
                                 CubicSpline(self.t, q)))

    def at(self, t: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Planned qpos, qvel, qacc at time t (seconds). Joints the take doesn't move (the left arm) stay at 0."""
        q, v, a = np.zeros(self.nq), np.zeros(self.nv), np.zeros(self.nv)
        for qadr, dof, s in self.splines:
            q[qadr], v[dof], a[dof] = s(t), s(t, 1), s(t, 2)
        return q, v, a
