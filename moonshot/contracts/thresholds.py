"""The thresholds every check uses, read from moonshot/thresholds.toml.

Checks ask for a threshold by name (`threshold("physics.skin_penetration_mm")`) and never hard-code the number,
so the file is the one place a pass/fail line moves, and moving it is a protected change (plan §6, rule 1).
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass
from functools import cache
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "thresholds.toml"
SOURCES = {"measured", "study", "spec", "decided", "proposed"}


@dataclass(frozen=True)
class Threshold:
    name: str
    value: float | tuple[float, float]
    unit: str
    source: str
    reason: str

    @property
    def band(self) -> tuple[float, float]:
        if not isinstance(self.value, tuple):
            raise TypeError(f"{self.name} is a single value, not a band")
        return self.value


@cache
def load(path: Path = PATH) -> dict[str, Threshold]:
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    out = {}
    for section, entries in raw.items():
        for key, t in entries.items():
            name = f"{section}.{key}"
            missing = {"value", "unit", "source", "reason"} - t.keys()
            if missing:
                raise ValueError(f"{name} is missing {sorted(missing)}")
            if t["source"] not in SOURCES:
                raise ValueError(f"{name} has source {t['source']!r}; expected one of {sorted(SOURCES)}")
            v = t["value"]
            if isinstance(v, list):
                if len(v) != 2 or v[0] > v[1]:
                    raise ValueError(f"{name}: a band is [low, high]")
                v = (float(v[0]), float(v[1]))
            else:
                v = float(v)
            out[name] = Threshold(name, v, t["unit"], t["source"], t["reason"])
    return out


def threshold(name: str) -> Threshold:
    try:
        return load()[name]
    except KeyError:
        raise KeyError(f"no threshold {name!r} in {PATH.name}") from None
