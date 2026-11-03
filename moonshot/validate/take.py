"""Every registered check, run on one physics take before it is rendered (docs/moonshot/physics.md). A take that fails
any of them, or lacks what one of them reads, isn't rendered: a check with nothing to read fails rather than skips,
because a skipped check is how the skin-depth check went unrun.

    python -m moonshot.validate.take <take dir>      # prints each check; exits 1 unless every one passes

The take directory holds the physics run as a take record (take.npz and scene.json,
moonshot/contracts/take_record.py), which any runner writes, and checks.json, what the checks read that the record
doesn't carry. The wrists and the skin's depth are measured from the record (moonshot/validate/skin.py), not read
from the render's bake, so the checks need nothing the render makes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from moonshot.validate.registry import Result, load_all
from moonshot.validate.skin import depth_mm

H0 = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])     # the record's hand frames are a segment's @ H0


def wrists(rec) -> list[list[float]]:
    """Every arm's wrist, every frame, as [flexion, deviation] degrees, from its forearm and hand frames: the hand is
    the forearm turned Ry(flexion) Rx(deviation) (moonshot/motion/kinematics.py), the left as the right of the mirrored
    world. The right arm's frames, then the left's."""
    out = []
    for arm in (str(a) for a in rec["arms"]):
        R = H0 @ np.swapaxes(rec[f"{arm}_forearm"], 1, 2) @ rec[f"{arm}_H"] @ H0.T
        out += np.degrees(np.stack([np.arctan2(-R[:, 2, 0], R[:, 0, 0]),
                                    np.arctan2(-R[:, 1, 2], R[:, 1, 1])], 1)).tolist()
    return out


def inputs(take: Path) -> dict:
    out = {"wrist_deg": wrists(np.load(take / "take.npz"))}
    if (take / "checks.json").exists():
        out |= json.loads((take / "checks.json").read_text(encoding="utf-8"))
    out["depth_mm"] = depth_mm(take)
    return out


def run(take: Path) -> dict[str, Result | str]:
    """Each check's result, or why it couldn't run."""
    data, out = inputs(take), {}
    for name, c in load_all().items():
        try:
            out[name] = c.run(data)
        except KeyError as e:
            out[name] = f"nothing to read: {e}"
    return out


def main(argv: list[str]) -> int:
    ok = True
    for name, r in run(Path(argv[0])).items():
        if isinstance(r, str):
            print(f"FAIL {name}: {r}")
            ok = False
        else:
            print(f"{'pass' if r.passed else 'FAIL'} {name}: worst {r.worst:.3f} {r.detail}")
            ok &= r.passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
