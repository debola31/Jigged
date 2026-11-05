"""Muscles under 100%: a take's physics run replayed through MyoSuite's arm (plan §3.1, §5.1).

MyoSuite's MyoArm (myo_sim 0.2.3, MoBL-ARMS: 7 arm and 20 hand joints, 63 muscles) is posed each frame by the run's
own joint angles. Inverse dynamics gives the torque the motion, gravity and the hand's load need, and static
optimisation the least effort, the smallest sum of squared activations, whose muscle forces make it. At a given
length and speed MuJoCo's active muscle force is linear in activation (gain * act), so each frame is one bounded
linear least squares. Activations are bounded at ACT_MAX, not 1.0, so a superhuman frame says by how much.

Only the active force counts. MoBL's passive forces are calibrated to the edges of its own ranges, not people's: a
hanging arm sits at its shoulder's lower limit, where its middle deltoid pulls 575 N passively, and cancelling that
took 54% of a finger extensor.

The replay never uses the body model's motors or the physics run's forces, only its angles and the load on its
hand (plan §6, rule 2). Known gaps: MyoArm's thorax is fixed, so the trunk's own motion is lost and only its tilt
kept, as gravity turned into the thorax's frame; the grip's squeeze arrives as one net load at the wrist, so the
finger muscles see no grip; the thumb and the hand's posture are mapped joint for joint, approximately.

    python -m moonshot.validate.muscle <take dir>     # per-frame peak activation and the hardest-working muscle
"""
from __future__ import annotations

import json
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path

import mujoco
import numpy as np
from scipy.interpolate import CubicSpline
from scipy.optimize import lsq_linear
from scipy.signal import butter, filtfilt
from scipy.spatial.transform import Rotation

from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check

ACT_MAX = 3.0
TORQUE_WEIGHT = 100.0           # per N m of torque the muscles miss, against 1 per unit of activation
LOWPASS_HZ = 6.0                # the run's angles are smoothed before differentiating, as motion capture's are
TRUNK_TO_WRIST = ["trunk_flex", "trunk_lat", "trunk_rot", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron",
                  "wr_flex", "wr_dev"]  # sim.npz theta[:, :10], trainual's order
# MyoArm joint <- the sum of our angles (degrees), plus an offset fitted over random poses so their segments point the
# same way. MoBL-ARMS measures axial rotation after unwinding the plane of elevation (its shoulder1_r2 = -elv_angle),
# so its rotation is ours plus the plane.
ARM = {"elv_angle_r": ("sh_plane",), "shoulder_elv_r": ("sh_elev",), "shoulder_rot_r": ("sh_rot", "sh_plane"),
       "elbow_flexion_r": ("elbow",), "pro_sup_r": ("pron",), "flexion_r": ("wr_flex",), "deviation_r": ("wr_dev",)}
OFFSET_DEG = {"elv_angle_r": 1.4, "shoulder_elv_r": -0.4, "shoulder_rot_r": 4.7, "elbow_flexion_r": -1.9,
              "pro_sup_r": 14.8, "flexion_r": 3.4, "deviation_r": -1.9}
# MyoArm hand joint <- (our hand joint, sign); MoBL's thumb flexes negative. Our thumb's roll and the palm's cupping
# have no MoBL joint.
HAND = {"mcp2_flexion_r": ("index_mcp_flex", 1), "mcp2_abduction_r": ("index_mcp_abd", 1),
        "pm2_flexion_r": ("index_pip", 1), "md2_flexion_r": ("index_dip", 1),
        "mcp3_flexion_r": ("middle_mcp_flex", 1), "mcp3_abduction_r": ("middle_mcp_abd", 1),
        "pm3_flexion_r": ("middle_pip", 1), "md3_flexion": ("middle_dip", 1),
        "mcp4_flexion_r": ("ring_mcp_flex", 1), "mcp4_abduction_r": ("ring_mcp_abd", 1),
        "pm4_flexion": ("ring_pip", 1), "md4_flexion_r": ("ring_dip", 1),
        "mcp5_flexion_r": ("little_mcp_flex", 1), "mcp5_abduction_r": ("little_mcp_abd", 1),
        "pm5_flexion_r": ("little_pip", 1), "md5_flexion_r": ("little_dip", 1),
        "cmc_flexion": ("thumb_cmc_flex", -1), "cmc_abduction": ("thumb_cmc_abd", 1),
        "mp_flexion_r": ("thumb_mcp_flex", -1), "ip_flexion_r": ("thumb_ip", -1)}
# MyoArm's torso axes (x forward, y up, z right) -> ours (x right, y forward, z up), then the base rotation between
# its torso and the thorax its arm hangs from, fitted to the humerus over 60 random poses (6.7 deg, mostly about
# the vertical). With it and OFFSET_DEG the two arms' segments point within a few degrees (test_muscle_check.py).
F = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
BASE = Rotation.from_rotvec(np.radians([-2.34, -0.41, -6.25])).as_matrix()


@dataclass
class Replay:
    activation: np.ndarray          # (frames, muscles), fraction of maximum
    residual_nm: np.ndarray         # (frames,), torque the muscles couldn't make even at ACT_MAX
    muscles: list[str]


class MyoArm:
    """MyoSuite's right arm, and the frame-by-frame static optimisation on it."""

    def __init__(self):
        from myo_sim.build import compose        # MyoSuite's model builder (moonshot/requirements.txt)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)    # its arm is attached with no name prefix; harmless here
            self.m = m = compose.build_spec("myoarm_r").compile()
        m.dof_damping[:] = 0                    # up to 1.05 N m s/rad: a stabiliser for its simulation, not tissue
        # its phantom bodies (the shoulder's intermediate frames) weigh 1 g but carry 1 kg m^2 each, an artefact of
        # the OpenSim conversion that made a fast reach need 17 N m about the plane of elevation; nothing is there
        phantom = (m.body_mass <= 0.001) & (m.body_inertia.max(1) > 0.01)
        m.body_inertia[phantom] = 1e-7
        self.d = d = mujoco.MjData(m)
        if np.any(m.qpos0):
            raise ValueError("MyoArm's reference pose isn't all zeros; the mapping assumes it is")
        self.joints = [*ARM, *HAND]
        col = {m.joint(n).id: i for i, n in enumerate(self.joints)}
        # its scapula and clavicle follow shoulder elevation through joint equalities: full qvel = C @ ours
        self.C = np.zeros((m.nv, len(self.joints)))
        for j, i in col.items():
            self.C[m.jnt_dofadr[j], i] = 1.0
        for e in range(m.neq):
            if m.eq_type[e] != mujoco.mjtEq.mjEQ_JOINT or np.any(m.eq_data[e, [0, 2, 3, 4]]):
                raise ValueError(f"MyoArm equality {m.equality(e).name} isn't a linear joint coupling")
            self.C[m.jnt_dofadr[m.eq_obj1id[e]], col[int(m.eq_obj2id[e])]] = m.eq_data[e, 1]
        mujoco.mj_kinematics(m, d)
        self.from_ours = d.body("torso").xmat.reshape(3, 3) @ F.T @ BASE.T     # our thorax frame -> its world
        self.wrist = m.body("lunate_r").id
        self.range = {n: np.degrees(m.jnt_range[m.joint(n).id]) for n in HAND}
        self.muscles = [m.actuator(a).name for a in range(m.nu)]
        self.R = np.zeros((m.nu, m.nv))

    def angles(self, theta: np.ndarray, hand: dict[str, np.ndarray]) -> np.ndarray:
        """(frames, MyoArm joints) degrees, from our trunk-to-wrist angles and hand angles by name."""
        arm = dict(zip(TRUNK_TO_WRIST, theta.T))
        n = len(theta)
        cols = [sum(arm[a] for a in ours) + OFFSET_DEG[j] for j, ours in ARM.items()]
        for j, (ours, sign) in HAND.items():
            cols.append(np.clip(sign * hand.get(ours, np.zeros(n)), *self.range[j]))
        return np.stack(cols, 1)

    def replay(self, theta: np.ndarray, hand: dict[str, np.ndarray], fps: float, gravity: np.ndarray,
               load: np.ndarray) -> Replay:
        """theta: (frames, 10) trunk-to-wrist angles, degrees; hand: our hand angles by name; gravity: (frames, 3) in
        our thorax's frame, m/s^2; load: (frames, 6), the force (N) and torque (N m) the world applies to the hand
        about the wrist, in our thorax's frame."""
        m, d = self.m, self.d
        q = np.radians(self.angles(theta, hand))
        if len(q) > 15:                                           # filtfilt's padding needs 3 x (order + 1) frames
            q = filtfilt(*butter(4, LOWPASS_HZ / (fps / 2)), q, axis=0)
        t = np.arange(len(q)) / fps
        s = CubicSpline(t, q) if len(q) > 3 else None
        v, a = (s(t, 1), s(t, 2)) if s is not None else (np.zeros_like(q), np.zeros_like(q))
        act, res = np.zeros((len(q), m.nu)), np.zeros(len(q))
        for k in range(len(q)):
            act[k], res[k] = self._frame(q[k], v[k], a[k], self.from_ours @ gravity[k],
                                         self.from_ours @ load[k, :3], self.from_ours @ load[k, 3:])
        return Replay(act, res, self.muscles)

    def _frame(self, q, v, a, gravity, force, torque) -> tuple[np.ndarray, float]:
        m, d = self.m, self.d
        d.qpos[:], d.qvel[:], d.qacc[:] = self.C @ q, self.C @ v, self.C @ a
        m.opt.gravity[:] = gravity
        flags = m.opt.disableflags
        m.opt.disableflags = flags | int(mujoco.mjtDisableBit.mjDSBL_CONSTRAINT)     # its equalities: C instead
        mujoco.mj_inverse(m, d)
        m.opt.disableflags = flags
        need = d.qfrc_inverse.copy()
        given = np.zeros(m.nv)
        mujoco.mj_applyFT(m, d, force, torque, d.xpos[self.wrist], self.wrist, given)
        mujoco.mj_fwdPosition(m, d)
        mujoco.mj_fwdVelocity(m, d)
        d.act[:] = 0
        mujoco.mj_fwdActuation(m, d)
        bias = d.actuator_force.copy()
        d.act[:] = 1
        mujoco.mj_fwdActuation(m, d)
        gain = d.actuator_force - bias                            # active force at full activation, this length and speed
        mujoco.mju_sparse2dense(self.R, d.actuator_moment, d.moment_rownnz, d.moment_rowadr, d.moment_colind)
        A = (self.C.T @ self.R.T) * gain                          # activation -> our joints' torque
        y = self.C.T @ (need - given)
        sol = lsq_linear(np.vstack([TORQUE_WEIGHT * A, np.eye(m.nu)]),
                         np.concatenate([TORQUE_WEIGHT * y, np.zeros(m.nu)]), bounds=(0.0, ACT_MAX), method="bvls")
        return sol.x, float(np.linalg.norm(A @ sol.x - y))


def thorax_frames(theta: np.ndarray) -> np.ndarray:
    """(frames, 3, 3): our thorax's orientation in the world, from the run's trunk angles."""
    from moonshot.body.skeleton import build
    body = build()
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    q = [m.jnt_qposadr[m.joint(n).id] for n in TRUNK_TO_WRIST[:3]]
    out = []
    for row in theta[:, :3]:
        d.qpos[q] = np.radians(row)                       # the trunk's joints rest at 0
        mujoco.mj_kinematics(m, d)
        out.append(d.body("thorax").xmat.reshape(3, 3).copy())
    return np.array(out)


def measure(take: Path, arm: MyoArm | None = None) -> dict:
    """What the muscle check reads, from a physics run: sim.npz's angles and checks.json's hand_wrench (the world's
    force and torque on the right hand about its wrist, world frame, per frame). Without hand_wrench there is
    nothing to replay the load from, so KeyError."""
    sim = np.load(take / "sim.npz")
    wrench = np.asarray(json.loads((take / "checks.json").read_text(encoding="utf-8"))["hand_wrench"], float)
    theta, fps = sim["theta"][:, :10], float(sim["fps"])
    R = thorax_frames(theta)
    to_thorax = lambda v: np.einsum("nji,nj->ni", R, v)      # noqa: E731  R^T v per frame
    gravity = to_thorax(np.tile([0.0, 0.0, -9.81], (len(theta), 1)))
    load = np.concatenate([to_thorax(wrench[:, :3]), to_thorax(wrench[:, 3:])], 1)
    hand = {str(n): sim["q"][:, i] for i, n in enumerate(sim["names"])}
    r = (arm or MyoArm()).replay(theta, hand, fps, gravity, load)
    return {"muscle_activation": r.activation.max(1).tolist(), "arm_speed_deg_s": arm_speed(theta, fps).tolist(),
            "fps": fps, "muscle_worst": [r.muscles[i] for i in r.activation.argmax(1)],
            "muscle_residual_nm": r.residual_nm.tolist()}


def arm_speed(theta: np.ndarray, fps: float) -> np.ndarray:
    """Per frame, the fastest trunk-to-wrist joint (deg/s)."""
    return np.abs(np.gradient(theta, 1.0 / fps, axis=0)).max(1)


@check("muscle_activation",
       good=["good/muscle_activation_easy.json"],
       bad=["bad/muscle_activation_over_max.json", "bad/muscle_activation_heavy_hold.json"])
def muscle_activation(take: dict) -> Result:
    """take: {"muscle_activation": per-frame peak activation over every muscle, "arm_speed_deg_s": per-frame fastest
    trunk-to-wrist joint, "fps"}. No muscle past its maximum; in a hold (every joint slower than
    body.muscle_hold_joint_speed_deg_s for at least body.muscle_hold_min_s) none past body.muscle_hold_activation_max."""
    act = np.asarray(take["muscle_activation"], float)
    still = np.asarray(take["arm_speed_deg_s"], float) < threshold("body.muscle_hold_joint_speed_deg_s").value
    if not len(act):
        raise ValueError("a take with no frames can't pass a per-frame check")
    if not np.isfinite(act).all():                 # a nan compares false with the bar, so it passed unseen
        bad = np.flatnonzero(~np.isfinite(act))
        raise ValueError(f"{bad.size} frames have no activation (the muscle solve failed), the first at {int(bad[0])}")
    over = np.flatnonzero(act > threshold("body.muscle_activation_max").value)
    shortest = threshold("body.muscle_hold_min_s").value * float(take["fps"])
    holds, heavy, k = [], [], 0
    while k < len(still):
        j = k
        while j < len(still) and still[j]:
            j += 1
        if j - k >= shortest:
            holds.append([k, j])
            heavy += [i for i in range(k, j) if act[i] > threshold("body.muscle_hold_activation_max").value]
        k = j + 1
    return Result(passed=not over.size and not heavy, worst=float(act.max()),
                  detail={"frames_over": int(over.size), "first_over": int(over[0]) if over.size else None,
                          "holds": holds, "frames_heavy_in_holds": len(heavy)})


def main(argv: list[str]) -> int:
    try:
        out = measure(Path(argv[0]))
    except KeyError:
        print("FAIL muscle_activation: the run's checks.json has no hand_wrench to replay the hand's load from")
        return 1
    act = np.array(out["muscle_activation"])
    k = int(act.argmax())
    print(f"peak activation {act[k]:.2f} at frame {k} ({out['muscle_worst'][k]}); "
          f"frames over 1.0: {int((act > 1).sum())}; worst unmade torque {max(out['muscle_residual_nm']):.2f} N m")
    r = muscle_activation(out)
    print(r)
    return 0 if r.passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
