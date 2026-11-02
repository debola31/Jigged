"""moonshot/tools/bar_check.py: a PR moves the bar or meets it, never both."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("bar_check", Path(__file__).resolve().parents[1] / "tools" / "bar_check.py")
bar_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bar_check)


def test_bar_and_code_together_fail():
    ok, msg = bar_check.verdict(["moonshot/thresholds.toml", "moonshot/validate/penetration.py"])
    assert not ok and "Split it" in msg


def test_a_bar_only_change_passes():
    assert bar_check.verdict(["moonshot/thresholds.toml", "moonshot/tests/fixtures/bad/x.json"])[0]


def test_a_code_only_change_passes():
    assert bar_check.verdict(["moonshot/validate/penetration.py", "moonshot/tests/test_queue.py"])[0]


def test_gate_tests_and_fixtures_are_bar_ordinary_tests_and_docs_are_neither():
    bar, code = bar_check.classify([
        "moonshot/tests/gates/test_checks_prove_themselves.py", "moonshot/tests/test_queue.py",
        "moonshot/tools/bar_check.py", "docs/moonshot/checklist.md", "moonshot/orchestrate/queue.py"])
    assert bar == ["moonshot/tests/gates/test_checks_prove_themselves.py"]
    assert code == ["moonshot/orchestrate/queue.py"]
