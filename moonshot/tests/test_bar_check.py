"""moonshot/tools/bar_check.py: a PR moves the bar or meets it, never both."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("bar_check", Path(__file__).resolve().parents[1] / "tools" / "bar_check.py")
bar_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bar_check)

T = "moonshot/thresholds.toml"
BASE = '[physics.slip_mm]\nvalue = 2.0\nunit = "mm"\nsource = "proposed"\nreason = "r"\n'


def test_changing_a_gate_and_code_together_fails():
    ok, msg = bar_check.verdict([("M", "moonshot/tests/gates/test_x.py"), ("M", "moonshot/validate/penetration.py")])
    assert not ok and "Split it" in msg


def test_loosening_a_threshold_with_code_fails():
    moved = bar_check.thresholds_moved(BASE, BASE.replace("2.0", "3.0"))
    assert moved == ["physics.slip_mm"]
    assert not bar_check.verdict([("M", T), ("M", "moonshot/sim/run.py")], moved)[0]


def test_deleting_a_bad_take_with_code_fails():
    assert not bar_check.verdict([("D", "moonshot/tests/fixtures/bad/x.json"), ("A", "moonshot/sim/run.py")])[0]


def test_a_new_gate_with_the_code_it_gates_passes():
    assert bar_check.verdict([("A", "moonshot/tests/gates/test_body.py"), ("A", "moonshot/body/skeleton.py")])[0]


def test_a_new_threshold_with_its_code_passes():
    added = BASE + '[physics.lag_mm]\nvalue = 10.0\nunit = "mm"\nsource = "proposed"\nreason = "r"\n'
    moved = bar_check.thresholds_moved(BASE, added)
    assert moved == []
    assert bar_check.verdict([("M", T), ("A", "moonshot/sim/run.py")], moved)[0]


def test_moving_the_bar_alone_passes():
    assert bar_check.verdict([("M", "moonshot/tests/fixtures/bad/x.json"), ("M", "docs/moonshot/checklist.md")])[0]


def test_ordinary_tests_tools_and_docs_are_neither():
    moved, code = bar_check.classify([("M", "moonshot/tests/test_queue.py"), ("M", "moonshot/tools/bar_check.py"),
                                      ("M", "docs/moonshot/checklist.md"), ("M", "moonshot/orchestrate/queue.py")], [])
    assert moved == [] and code == ["moonshot/orchestrate/queue.py"]
