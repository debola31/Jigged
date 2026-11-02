"""Every registered check fails its bad takes and passes its good ones (plan §5.4; protected, plan §6 rule 1).

A check with no bad take can't be told apart from a broken one, so moonshot/validate/registry.py refuses to
register one, and this runs every take against its check.
"""
import json

import pytest

from moonshot.validate.registry import load_all

CHECKS = load_all()
CASES = [(c.name, p, "good") for c in CHECKS.values() for p in c.good] + \
        [(c.name, p, "bad") for c in CHECKS.values() for p in c.bad]


def test_there_are_checks():
    assert CHECKS


@pytest.mark.parametrize("name,path,kind", CASES, ids=lambda x: getattr(x, "name", str(x)))
def test_check_judges_its_takes(name, path, kind):
    result = CHECKS[name].run(json.loads(path.read_text()))
    assert result.passed is (kind == "good"), f"{name} {'failed' if kind == 'good' else 'passed'} {path.name}"
