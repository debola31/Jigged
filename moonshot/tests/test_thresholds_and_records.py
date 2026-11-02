"""The thresholds file and the resource records are well-formed."""
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from moonshot.config import data_root
from moonshot.contracts.thresholds import SOURCES, load, threshold

RECORDS_DIR = Path(__file__).resolve().parents[1] / "library" / "records"
# <id>_rig.json beside a record is the rig built from it (joints, controls), a different format
ASSET_RECORDS = sorted(p for p in (RECORDS_DIR / "assets").glob("*/*/*.json") if not p.stem.endswith("_rig"))


def test_every_threshold_has_a_known_source_and_a_reason():
    ts = load()
    assert ts
    for t in ts.values():
        assert t.source in SOURCES and t.reason.strip(), t.name


def test_bands_are_ordered():
    for t in load().values():
        if isinstance(t.value, tuple):
            assert t.value[0] <= t.value[1], t.name


def test_an_unknown_threshold_is_an_error():
    with pytest.raises(KeyError, match="no threshold"):
        threshold("physics.made_up")


def test_a_threshold_without_a_source_is_refused(tmp_path):
    bad = tmp_path / "t.toml"
    bad.write_text('[physics.x]\nvalue = 1\nunit = "mm"\nreason = "r"\n')
    with pytest.raises(ValueError, match="missing"):
        load(bad)


@pytest.fixture(scope="module")
def validator():
    schema = json.loads((RECORDS_DIR / "asset.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def test_the_library_has_records():
    assert ASSET_RECORDS


@pytest.mark.parametrize("path", ASSET_RECORDS, ids=lambda p: p.stem)
def test_record_validates_and_sits_in_its_folder(validator, path):
    record = json.loads(path.read_text(encoding="utf-8"))
    errors = [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in validator.iter_errors(record)]
    assert errors == []
    assert record["id"] == path.stem == path.parent.name
    assert record["category"] == path.parent.parent.name


@pytest.mark.data_root
@pytest.mark.parametrize("path", ASSET_RECORDS, ids=lambda p: p.stem)
def test_record_glb_is_in_the_data_root(path):
    library = data_root() / "library"
    if not library.is_dir():
        pytest.skip(f"no data root at {library}")
    record = json.loads(path.read_text(encoding="utf-8"))
    if "pending" in record:
        pytest.skip(record["pending"])
    assert (library / record["category"] / record["id"] / record["file"]).is_file()
