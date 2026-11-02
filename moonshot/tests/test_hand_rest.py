"""moonshot/body/data/hand_rest.json is what moonshot/body/derive_hand.py makes from NIMBLE, unchanged.

The body model reads that small file so CI can build it without the 713 MB model; this fails if the two drift.
"""
import json

import pytest

from moonshot.config import data_root

NIMBLE = data_root() / "hand-model" / "nimble"


@pytest.mark.data_root
def test_hand_rest_matches_nimble():
    if not (NIMBLE / "NIMBLE_DICT_9137.npz").exists():
        pytest.skip(f"no NIMBLE model at {NIMBLE}")
    from moonshot.body.derive_hand import OUT, derive
    committed = json.loads(OUT.read_text(encoding="utf-8"))
    assert json.loads(json.dumps(derive(NIMBLE))) == committed
