"""The read-only SQL sandbox, once the worker began serving several databases.

THE PROPERTY THAT MATTERS: a caller that names a database gets that database or
nothing. The pool used to be one process-wide singleton latched to whatever
AI_READONLY_DATABASE_URL held at first use, which is why serving production and a
preview branch from one process would have answered both from one of them.

Two shipped incidents sit behind this and both had the same shape -- load order
decided which database the sandbox got, and nothing about a wrong run looked
different from a right one (worker/config.py, worker/__main__.load_env). A
fallback to the environment when a DSN was passed would be that bug again, so it
is asserted here rather than trusted.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tools import sql_executor

pytestmark = pytest.mark.unit

PROD = "postgresql://jigged_ai_readonly.prodref:pw@pooler:5432/postgres"
BRANCH = "postgresql://jigged_ai_readonly.branchref:pw@pooler:5432/postgres"


class _FakePool:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def no_pools():
    """Every test starts and ends with an empty registry."""
    sql_executor._pools.clear()
    yield
    sql_executor._pools.clear()


@pytest.fixture
def created():
    """asyncpg stubbed: these tests are about which DSN is asked for, not Postgres."""
    async def create_pool(dsn: str, **_kwargs):
        return _FakePool(dsn)

    with patch.object(sql_executor.asyncpg, "create_pool", side_effect=create_pool) as m:
        yield m


async def test_two_databases_get_two_pools(created):
    prod = await sql_executor.init_pool(PROD)
    branch = await sql_executor.init_pool(BRANCH)

    assert prod is not branch
    assert (prod.dsn, branch.dsn) == (PROD, BRANCH)
    assert sorted(sql_executor._pools) == sorted([BRANCH, PROD])


async def test_one_database_is_built_once_and_reused(created):
    first = await sql_executor.init_pool(PROD)
    second = await sql_executor.init_pool(PROD)

    assert first is second
    assert created.call_count == 1


async def test_a_named_dsn_never_falls_back_to_the_environment(created, monkeypatch):
    """THE RULE. The env holding production must not be able to satisfy a request
    for a branch -- that is the `setdefault` bug of export_sandbox_dsn one level
    up, and it would answer a preview's question with the shop's real data."""
    monkeypatch.setenv("AI_READONLY_DATABASE_URL", PROD)

    pool = await sql_executor.init_pool(BRANCH)

    assert pool.dsn == BRANCH
    assert PROD not in sql_executor._pools


async def test_no_dsn_means_the_environment_which_is_the_backends_one_database(created, monkeypatch):
    monkeypatch.setenv("AI_READONLY_DATABASE_URL", PROD)

    pool = await sql_executor.init_pool()

    assert pool.dsn == PROD


async def test_with_no_dsn_and_no_environment_there_is_no_pool(created, monkeypatch):
    monkeypatch.delenv("AI_READONLY_DATABASE_URL", raising=False)

    assert await sql_executor.init_pool() is None
    created.assert_not_called()


async def test_a_pool_that_cannot_be_built_is_not_remembered(monkeypatch):
    """A failure must not poison the registry: the next job tries again."""
    with patch.object(sql_executor.asyncpg, "create_pool", side_effect=OSError("no route")):
        assert await sql_executor.init_pool(BRANCH) is None

    assert sql_executor._pools == {}


async def test_closing_one_database_leaves_the_others_serving(created):
    """A preview branch disappears when its PR closes; production does not."""
    prod = await sql_executor.init_pool(PROD)
    branch = await sql_executor.init_pool(BRANCH)

    await sql_executor.close_pool(BRANCH)

    assert branch.closed and not prod.closed
    assert list(sql_executor._pools) == [PROD]


async def test_closing_with_no_dsn_closes_everything(created):
    """What the integration fixtures mean by close_pool(), and what shutdown wants."""
    prod = await sql_executor.init_pool(PROD)
    branch = await sql_executor.init_pool(BRANCH)

    await sql_executor.close_pool()

    assert prod.closed and branch.closed
    assert sql_executor._pools == {}


async def test_the_query_path_asks_for_the_database_it_was_given(created):
    """execute_sql_query threads its dsn to init_pool. Asserted at the seam because
    everything below it is asyncpg."""
    with patch.object(sql_executor, "init_pool", AsyncMock(return_value=None)) as init:
        await sql_executor.execute_sql_query(
            company_id="11111111-1111-1111-1111-111111111111",
            sql="SELECT 1 FROM jobs WHERE company_id = $1",
            dsn=BRANCH,
        )

    init.assert_awaited_once_with(BRANCH)
