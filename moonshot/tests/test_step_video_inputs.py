"""A step's video is never written over a video it is cut from (moonshot/render/step_video.py
refuse_feeding_itself), and the plans' routing never asks it to (moonshot/planning/takes.py): on 2026-11-05 the
assemble wrote ll-1005337 op10's unload, door-open joined to the plate's own take, over that take's video, because
the take's folder was the step's. A step that is one whole take, the step's own folder (nist-ftc-10's deburr), is
that video already, and copying it onto itself is nothing."""
import json
from pathlib import Path

import pytest

from moonshot.planning.steps import expand
from moonshot.planning.takes import PLATE_TAKES, spans
from moonshot.planning.validate import PLANS, load_plan
from moonshot.render import step_video as SV

PARTS = sorted(f.stem for f in PLANS.glob("*.json"))


def _take(takes: Path, name: str, clips=None) -> Path:
    (takes / name).mkdir(parents=True, exist_ok=True)
    (takes / name / "take.json").write_text(json.dumps({"clips": clips or []}), encoding="utf-8")
    (takes / name / "final.mp4").write_bytes(b"")
    return takes / name / "final.mp4"


def test_a_join_onto_one_of_its_own_inputs_is_refused(tmp_path):
    out = _take(tmp_path, "ll-1005337-op10-unload")
    cuts = [(_take(tmp_path, "door-open"), 0.0, None), (out, 0.0, None)]
    with pytest.raises(ValueError, match="one of its own takes"):
        SV.make(cuts, out, "no blender needed: it refuses first")
    assert out.read_bytes() == b"", "the take's own video is untouched"


def test_a_span_of_its_own_take_is_refused_too(tmp_path):
    out = _take(tmp_path, "x-op10-load")
    with pytest.raises(ValueError):
        SV.refuse_feeding_itself([(out, 1.0, 4.0)], out)


def test_a_step_that_is_its_own_whole_take_is_copied_onto_itself(tmp_path):
    out = _take(tmp_path, "nist-ftc-10-deburr")
    assert SV.make([(out, 0.0, None)], out, "unused") == out


def test_assemble_refuses_before_calling_a_step_unchanged(tmp_path, monkeypatch):
    """The joined video is newer than its inputs, so without the guard a second assemble would call it unchanged and
    leave the take's own video lost."""
    out = _take(tmp_path, "p-op10-unload")
    monkeypatch.setattr(SV, "expand", lambda plan: [{"id": "op10-unload"}])
    monkeypatch.setattr(SV, "load_plan", lambda part: {})
    monkeypatch.setattr(SV, "cuts", lambda part, s, name, takes: [(tmp_path / "door-open" / "final.mp4", 0.0, None),
                                                                   (out, 0.0, None)])
    _take(tmp_path, "door-open")
    with pytest.raises(ValueError):
        SV.assemble("p", takes=tmp_path, blender="unused")


@pytest.mark.parametrize("part", PARTS)
def test_no_step_is_routed_onto_a_take_it_plays_unless_it_is_that_whole_take(part):
    for s in expand(load_plan(part)):
        sp = spans(part, s)
        own = f"{part}-{s['id']}"
        if len(sp) == 1 and sp[0][1] is None and sp[0][2] is None:
            continue                                     # one whole take, the step's own: its video is the step's
        assert own not in [t for t, _, _ in sp], (s["id"], sp)


@pytest.mark.parametrize("part", [p for p in PARTS if any("clamps" in s.get("workholding", {})
                                                          for s in load_plan(p)["setups"])])
def test_a_plate_steps_own_takes_are_named_apart_from_the_step(part):
    """Even a plate step that is one whole take (the clean, the load, the seat, the shift): one rule, simply kept."""
    for s in expand(load_plan(part)):
        if "clamps" in s["facts"] and s["id"].split("-", 1)[1] in (*PLATE_TAKES, "unload"):
            assert f"{part}-{s['id']}" not in [t for t, _, _ in spans(part, s)], s["id"]
