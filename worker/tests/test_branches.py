"""Which databases the worker decides to serve.

THE PROPERTY THAT MATTERS: production is in the list no matter what the API says,
and every branch's queue and sandbox DSN are built from the SAME project ref. A
preview's question reaching production's data is the failure this module exists to
make impossible, and it would look like a correct run.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from worker import branches, config as worker_config

POOLER = "aws-0-us-west-2.pooler.supabase.com:5432"
PROD_REF = "mayuquvexmqjvwkfasxg"
BRANCH_REF = "vnlhmrhmdibdsasqgkni"


def _config(token: str | None = "sbp_readonly", queue: str | None = None) -> worker_config.Config:
    return worker_config.Config(
        worker_id="desktop-1",
        database_url=queue or f"postgresql://jigged_ai_worker.{PROD_REF}:pw@{POOLER}/postgres",
        readonly_database_url=f"postgresql://jigged_ai_readonly.{PROD_REF}:pw@{POOLER}/postgres",
        ollama_base_url="http://localhost:11434/v1",
        models=("qwen3:32b",),
        supabase_access_token=token,
    )


def _branch(ref: str = BRANCH_REF, *, default: bool = False, status: str = branches.HEALTHY) -> dict:
    """One entry shaped like a real GET /v1/projects/{ref}/branches row."""
    return {
        "id": "a9712ab3-37e4-464e-a6b8-f7d9a14d4775",
        "name": "feature/x",
        "project_ref": ref,
        "parent_project_ref": PROD_REF,
        "is_default": default,
        "git_branch": "feature/x",
        "status": "FUNCTIONS_DEPLOYED",
        "preview_project_status": status,
    }


def _discover(cfg, rows):
    with patch.object(branches, "fetch_branches", return_value=rows):
        return branches.discover(cfg)


# --------------------------------------------------------------- the DSN shape


def test_the_pooler_dsn_gives_up_its_host_and_project_ref():
    """Supabase puts the tenant in the username, which is why production's own DSN
    is enough to address every other branch of the project."""
    host, ref = branches.parse_pooler_dsn(f"postgresql://jigged_ai_worker.{PROD_REF}:pw@{POOLER}/postgres")

    assert (host, ref) == (POOLER, PROD_REF)


@pytest.mark.parametrize("dsn", [
    "postgresql://jigged_ai_worker:pw@remote:5432/postgres",   # no tenant in the user
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",  # the local stack
    "not-a-dsn",
])
def test_a_dsn_that_is_not_pooler_shaped_is_not_an_error(dsn):
    """It only means branches cannot be addressed from it. A shop box on a direct
    connection has no interest in previews and must still start."""
    assert branches.parse_pooler_dsn(dsn) is None


def test_the_seed_still_grants_the_login_branch_serving_depends_on():
    """Read from supabase/seed.sql so there is one definition of it. If the seed
    ever stops granting it, branch serving stops -- and this says so."""
    assert branches.seed_login()


# ------------------------------------------------------------ what gets served


def test_production_is_always_first_and_comes_from_the_environment():
    cfg = _config()
    served = _discover(cfg, [_branch()])

    assert served[0].is_default and served[0].label == "production"
    assert served[0].queue_dsn == cfg.database_url
    assert served[0].sandbox_dsn == cfg.readonly_database_url


def test_a_healthy_branch_is_served_with_both_dsns_built_from_one_ref():
    """The invariant: no combination of the two DSNs names different databases."""
    served = _discover(_config(), [_branch()])

    assert [s.ref for s in served] == [PROD_REF, BRANCH_REF]
    branch = served[1]
    assert branch.label == "feature/x" and not branch.is_default
    assert f"jigged_ai_worker.{BRANCH_REF}" in branch.queue_dsn
    assert f"jigged_ai_readonly.{BRANCH_REF}" in branch.sandbox_dsn
    assert PROD_REF not in branch.queue_dsn and PROD_REF not in branch.sandbox_dsn
    assert POOLER in branch.queue_dsn and POOLER in branch.sandbox_dsn


def test_a_branch_that_is_not_up_yet_is_skipped_rather_than_retried_into_errors():
    served = _discover(_config(), [_branch(status="COMING_UP")])

    assert [s.ref for s in served] == [PROD_REF]


def test_the_default_branch_is_production_and_is_not_added_twice():
    served = _discover(_config(), [_branch(ref=PROD_REF, default=True)])

    assert [s.ref for s in served] == [PROD_REF]


# ------------------------------------------- production survives every failure


def test_without_a_token_the_worker_serves_production_alone():
    """What every shop box does. Discovery is a developer convenience, and the
    worker must never need an external API to do its actual job."""
    with patch.object(branches, "fetch_branches") as fetch:
        served = branches.discover(_config(token=None))

    assert [s.label for s in served] == ["production"]
    fetch.assert_not_called()


def test_a_non_pooler_queue_dsn_serves_production_alone():
    with patch.object(branches, "fetch_branches") as fetch:
        served = branches.discover(_config(queue="postgresql://jigged_ai_worker:pw@remote:5432/postgres"))

    assert [s.label for s in served] == ["production"]
    fetch.assert_not_called()


def test_a_discovery_failure_never_takes_production_with_it():
    """A revoked token or a flaky network must not stop the shop's own AI."""
    import httpx

    with patch.object(branches.httpx, "get", side_effect=httpx.ConnectError("no route")):
        rows = branches.fetch_branches(PROD_REF, "sbp_readonly")
    assert rows == []

    served = _discover(_config(), [])
    assert [s.label for s in served] == ["production"]


def test_a_branch_whose_sandbox_dsn_fails_the_superuser_check_is_dropped():
    """The BYPASSRLS backstop runs on every sandbox DSN this worker builds, not
    only the one the environment supplied. A branch that fails it is skipped;
    production, which was vetted at startup, carries on."""
    def refuse(dsn: str, source: str) -> None:
        if BRANCH_REF in dsn:
            raise worker_config.WorkerMisconfigured(f"{source} is a superuser DSN")

    with patch.object(branches.worker_config, "refuse_superuser_sandbox", side_effect=refuse):
        served = _discover(_config(), [_branch()])

    assert [s.label for s in served] == ["production"]
