"""The worker's startup env, and specifically the ORDER the two files load in.

The bug this pins: worker/config.py reads os.getenv and nothing populated it, so a
correctly-filled .env.local produced "AI_READONLY_DATABASE_URL is not set" on a box
that plainly had it set.

The invariant it protects is worth more than the bug. worker/.env must beat
.env.local, because .env.local's AI_READONLY_DATABASE_URL is the LOCAL postgres
superuser -- BYPASSRLS -- and config.load()'s guard exempts localhost by design. Swap
the two load_dotenv lines and every check in this repo still passes while the insights
SQL sandbox runs unscoped. Nothing else would catch that.
"""
from __future__ import annotations

import os

import pytest

from worker.__main__ import load_env

READONLY = "AI_READONLY_DATABASE_URL"


@pytest.fixture(autouse=True)
def _restore_environ():
    """load_dotenv mutates os.environ; monkeypatch only unwinds its own writes."""
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


def _fake_repo(root, *, worker_env: str | None = None, env_local: str | None = None):
    if worker_env is not None:
        (root / "worker").mkdir(exist_ok=True)
        (root / "worker" / ".env").write_text(worker_env, encoding="utf-8")
    if env_local is not None:
        (root / ".env.local").write_text(env_local, encoding="utf-8")
    return root


def test_worker_env_beats_env_local(tmp_path):
    """The security-relevant half: the least-privilege DSN wins over the superuser."""
    _fake_repo(
        tmp_path,
        worker_env=f"{READONLY}=postgresql://jigged_ai_readonly:pw@remote:5432/postgres\n",
        env_local=f"{READONLY}=postgresql://postgres:postgres@127.0.0.1:54322/postgres\n",
    )
    os.environ.pop(READONLY, None)

    load_env(tmp_path)

    assert os.environ[READONLY].startswith("postgresql://jigged_ai_readonly:")


def test_env_local_still_supplies_what_worker_env_omits(tmp_path):
    """Losing to worker/.env is not the same as being ignored."""
    _fake_repo(
        tmp_path,
        worker_env="WORKER_ID=desktop-1\n",
        env_local=f"WORKER_ID=ignored\n{READONLY}=postgresql://from-env-local\n",
    )
    os.environ.pop(READONLY, None)
    os.environ.pop("WORKER_ID", None)

    load_env(tmp_path)

    assert os.environ["WORKER_ID"] == "desktop-1"
    assert os.environ[READONLY] == "postgresql://from-env-local"


def test_the_shell_beats_both_files(tmp_path):
    """An operator overriding one DSN for one run must not be silently overwritten."""
    _fake_repo(
        tmp_path,
        worker_env=f"{READONLY}=postgresql://from-worker-env\n",
        env_local=f"{READONLY}=postgresql://from-env-local\n",
    )
    os.environ[READONLY] = "postgresql://from-the-shell"

    load_env(tmp_path)

    assert os.environ[READONLY] == "postgresql://from-the-shell"


def test_neither_file_present_is_not_an_error(tmp_path):
    """The shop box may export these from the service definition instead."""
    os.environ.pop(READONLY, None)

    load_env(tmp_path)

    assert READONLY not in os.environ
