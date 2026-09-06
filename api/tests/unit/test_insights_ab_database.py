"""Which database the A/B queries, and the guard that stops it querying an empty one.

THREE RUNS IN THE WEEK TO 2026-09-06 SCORED A FULL TABLE AGAINST NO DATA. .env.local
defines both DSNs -- AI_READONLY_DATABASE_URL is the local stack, and
WORKER_READONLY_DATABASE_URL is the remote one the shop's rows actually live on --
and pointing the harness at the second one meant exporting it over the first by hand
before every run. Skip that and nothing announces it: the connection opens, every
arm generates valid SQL, every query returns zero rows, and each arm narrates "no
late jobs" or "no data for that period" without raising anywhere. The run bills in
full and the table reads like a finding.

So the flag removes the manual export, and the preflight makes the empty case
impossible to miss. The two tests here are the two things that would let it happen
again: a --db that resolves to the wrong DSN, and a zero-row database that bills
anyway.
"""
from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.unit

COMPANY = "45a29b26-317e-483a-8cc4-10fb676f1273"
LOCAL = "postgresql://postgres@127.0.0.1:54322/postgres"
REMOTE = "postgresql://jigged_ai_readonly@db.a-shop.example:5432/postgres"


def test_the_flag_beats_the_file_and_an_exported_dsn_beats_the_flag():
    """The whole resolution order, in the order it is checked.

    `exported` is a snapshot the module takes BEFORE load_dotenv, because that is
    the only moment an exported AI_READONLY_DATABASE_URL and the one .env.local
    defines are distinguishable -- afterwards they are the same os.environ key. Get
    this wrong in either direction and the flag is worse than nothing: it either
    ignores what the operator exported, or silently overrides it.
    """
    from evals.insights_ab import resolve_dsn

    env = {"AI_READONLY_DATABASE_URL": LOCAL, "WORKER_READONLY_DATABASE_URL": REMOTE}

    # Nothing exported: --db picks the variable, over the other one .env.local set.
    assert resolve_dsn("local", None, env)[0] == LOCAL
    assert resolve_dsn("prod", None, env)[0] == REMOTE

    # An exported AI_READONLY_DATABASE_URL wins over BOTH, --db prod included. Same
    # precedence as load_dotenv(override=False): the shell is the last word.
    exported = "postgresql://jigged_ai_readonly@somewhere-else:5432/postgres"
    assert resolve_dsn("prod", exported, env)[0] == exported
    assert resolve_dsn("local", exported, env)[0] == exported

    # Unset resolves to nothing, never to the other database.
    assert resolve_dsn("prod", None, {"AI_READONLY_DATABASE_URL": LOCAL})[0] is None

    # The second element is provenance and gets printed beside the host, so it has
    # to name the variable the DSN actually came from.
    assert "WORKER_READONLY_DATABASE_URL" in resolve_dsn("prod", None, env)[1]
    assert "exported" in resolve_dsn("prod", exported, env)[1]


async def test_a_company_with_no_jobs_aborts_before_any_arm_runs(monkeypatch, capsys):
    """The guard that would have saved three runs. Zero jobs is not a finding.

    Asserts the refusal happens BEFORE run_arm, not just that it happens: after the
    first arm the credits are spent, which is the whole cost being avoided. The
    message has to carry the host it resolved and the count, because "empty" is only
    actionable once you know which database was empty.
    """
    from evals import insights_ab

    monkeypatch.setattr(
        sys, "argv",
        ["insights_ab", "--company", COMPANY, "--db", "prod", "--arms", "anthropic"],
    )
    # Nothing exported, so --db decides -- and the local DSN is present exactly as
    # .env.local leaves it, so the assertions below also prove --db prod beat it.
    monkeypatch.setattr(insights_ab, "_EXPORTED_AI_DSN", None)
    monkeypatch.setenv("AI_READONLY_DATABASE_URL", LOCAL)
    monkeypatch.setenv("WORKER_READONLY_DATABASE_URL", REMOTE)

    async def reachable_but_empty(dsn, company_id):
        assert dsn == REMOTE
        return 0

    async def never(*args, **kwargs):
        raise AssertionError("an arm ran against an empty database")

    monkeypatch.setattr(insights_ab, "preflight", reachable_but_empty)
    monkeypatch.setattr(insights_ab, "run_arm", never)

    assert await insights_ab.main() == 2

    out = capsys.readouterr().out
    assert "db.a-shop.example:5432/postgres" in out   # the host it resolved
    assert "0 jobs" in out                            # the count
    assert "--db local" in out                        # the other one to try
