"""The worker's startup env: one file, one precedence rule, and the export it does.

TWO BUGS ARE PINNED HERE, and the second is the reason the first one's fix changed
shape. worker/config.py reads os.getenv and nothing populated it, so a correctly
filled .env.local produced "not set" on a box that plainly had it set (#787). The
fix loaded worker/.env and .env.local in an order that mattered, because both
defined AI_READONLY_DATABASE_URL with different values -- the local postgres
superuser (BYPASSRLS) and the shop's jigged_ai_readonly role.

Naming the worker's copy WORKER_READONLY_DATABASE_URL deleted that collision, and
worker/.env with it. What survives is export_sandbox_dsn(): tools.sql_executor still
reads AI_READONLY_DATABASE_URL, .env.local still defines it as the local stack, and
the worker must OVERWRITE it. A setdefault there is silent and wrong, so it has a
test of its own.
"""
from __future__ import annotations

import os

import pytest

from worker import config as worker_config
from worker.__main__ import export_sandbox_dsn, load_env

SANDBOX = "AI_READONLY_DATABASE_URL"
WORKER = "WORKER_READONLY_DATABASE_URL"

LOCAL_SUPERUSER = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
REMOTE_READONLY = "postgresql://jigged_ai_readonly:pw@remote.example.com:5432/postgres"


@pytest.fixture(autouse=True)
def _restore_environ():
    """load_dotenv mutates os.environ; monkeypatch only unwinds its own writes."""
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


def _env_local(root, body: str):
    (root / ".env.local").write_text(body, encoding="utf-8")
    return root


def test_env_local_supplies_the_worker_variables(tmp_path):
    _env_local(tmp_path, f"{WORKER}={REMOTE_READONLY}\nWORKER_ID=desktop-1\n")
    os.environ.pop(WORKER, None)
    os.environ.pop("WORKER_ID", None)

    load_env(tmp_path)

    assert os.environ[WORKER] == REMOTE_READONLY
    assert os.environ["WORKER_ID"] == "desktop-1"


def test_the_shell_beats_the_file(tmp_path):
    """An operator overriding a DSN for one run must not be silently overwritten."""
    _env_local(tmp_path, f"{WORKER}={REMOTE_READONLY}\n")
    os.environ[WORKER] = "postgresql://from-the-shell"

    load_env(tmp_path)

    assert os.environ[WORKER] == "postgresql://from-the-shell"


def test_a_missing_env_local_is_not_an_error(tmp_path):
    """The shop box may export these from its service definition instead."""
    os.environ.pop(WORKER, None)

    load_env(tmp_path)

    assert WORKER not in os.environ


def test_config_reads_the_worker_name_not_the_backend_one(tmp_path):
    """The rename's whole point: what the backend set cannot reach the worker."""
    os.environ[SANDBOX] = LOCAL_SUPERUSER
    os.environ[WORKER] = REMOTE_READONLY
    os.environ["WORKER_ID"] = "desktop-1"
    os.environ["WORKER_DATABASE_URL"] = "postgresql://jigged_ai_worker:pw@remote:5432/postgres"

    cfg = worker_config.load()

    assert cfg.readonly_database_url == REMOTE_READONLY


def test_config_refuses_a_superuser_dsn_against_a_remote_host():
    """The backstop, for a hand-pasted DSN the naming cannot catch."""
    os.environ[WORKER] = "postgresql://postgres:pw@remote.example.com:5432/postgres"
    os.environ["WORKER_ID"] = "desktop-1"
    os.environ["WORKER_DATABASE_URL"] = "postgresql://jigged_ai_worker:pw@remote:5432/postgres"

    with pytest.raises(worker_config.WorkerMisconfigured, match="BYPASSRLS"):
        worker_config.load()


def test_the_sandbox_dsn_is_overwritten_not_defaulted():
    """THE trap. .env.local has already set AI_READONLY_DATABASE_URL to the local
    stack by the time the worker exports its own, so a setdefault does nothing and
    every query the worker runs goes to the wrong database -- or to a refused port
    on a shop box. Silent either way."""
    os.environ[SANDBOX] = LOCAL_SUPERUSER
    cfg = worker_config.Config(
        worker_id="desktop-1",
        database_url="postgresql://jigged_ai_worker:pw@remote:5432/postgres",
        readonly_database_url=REMOTE_READONLY,
        ollama_base_url="http://localhost:11434/v1",
        models=("qwen3:8b",),
    )

    export_sandbox_dsn(cfg)

    assert os.environ[SANDBOX] == REMOTE_READONLY
