"""The look check (plan §5.3): Claude judges rendered frames against this rubric; you judge the same frames once, on
the first station, so the rubric is corrected where you disagree before Claude judges alone.

The pipeline makes no API calls for this: the Claude agent sessions on the hub look at the sampled frames. Each item
is pass or fail with a one-line reason; a draft passes when every item does.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Item:
    id: str
    question: str


RUBRIC = [
    Item("materials", "Do the materials read correctly: bare steel, cast iron, paint, aluminium, carbide, plastic, skin?"),
    Item("lighting", "Is the lighting plausible for a machine shop, with no blown highlights, noise or fireflies?"),
    Item("textures", "Are textures at the right scale, with no stretching, seams or obvious tiling?"),
    Item("scale", "Do the proportions and sizes match the real thing (hand to vise, vise to table)?"),
    Item("contact", "Does contact look real: shadows where fingers meet metal, skin compressed at the pads?"),
    Item("framing", "Is the action in frame and readable, with nothing important cut off or hidden?"),
]


def sample_frames(n_frames: int, contact: np.ndarray | None = None) -> dict[str, int]:
    """Frames to judge for one step: the first, the moment of most hand contact, and the last."""
    pick = {"first": 0, "last": n_frames - 1}
    if contact is not None and len(contact) == n_frames and np.any(contact > 0):
        pick["contact"] = int(np.argmax(contact))
    else:
        pick["contact"] = n_frames // 2
    return pick
