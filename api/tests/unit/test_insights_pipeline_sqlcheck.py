"""The identifier pre-check: an invented column is caught before the round trip.

WHY THIS EXISTS. Every SQL failure in the Gate 2 run was a column that does not
exist, against a table whose real columns were already in the prompt:

    column "due_at" does not exist            HINT: Perhaps you meant "jobs.due_date"
    column jp.true_cost does not exist
    column jp.quote_id does not exist
    column job_operations.work_centre does not exist
    column "company_id" does not exist

Postgres already catches all five. The pre-check earns its place by catching them
without spending a connection, a 5-second statement timeout and a round trip on a
query that cannot possibly run -- and by making "the model invented a column" a
distinguishable category in the dump rather than one more `sql_error` among many.

THE RISK IS FALSE POSITIVES, NOT FALSE NEGATIVES. A regex that rejects a VALID
query is far worse than one that misses an invalid one: the invalid one merely
costs a round trip Postgres was going to refuse anyway, while a wrongly-rejected
query burns the single regeneration and can turn a right answer into a failure.
So the last test here runs every reference query in semantics.md through the
check, and any of them being rejected fails the build.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit

GOOD = """
SELECT COUNT(*) AS late_jobs
FROM jobs
WHERE company_id = $1
  AND due_date < $2::date
"""


def test_a_valid_query_is_not_flagged():
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns(GOOD) is None


@pytest.mark.parametrize(
    "sql,expected",
    [
        (
            "SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND due_at < CURRENT_DATE",
            "due_at",
        ),
        (
            "SELECT SUM(jp.true_cost) FROM job_parts jp JOIN jobs j ON j.id = jp.job_id "
            "WHERE j.company_id = $1",
            "true_cost",
        ),
        (
            "SELECT job_operations.work_centre FROM job_operations "
            "JOIN jobs ON jobs.id = job_operations.job_id WHERE jobs.company_id = $1",
            "work_centre",
        ),
    ],
)
def test_the_columns_the_eval_actually_invented_are_caught(sql, expected):
    from services.insights_pipeline.sqlcheck import precheck_columns

    result = precheck_columns(sql)
    assert result is not None, f"{expected} was not flagged"
    assert expected in result["error"]


def test_a_rejection_is_shaped_like_every_other_model_fixable_failure():
    """Same shape as tools.sql_executor.retryable_sql_error, so the retry rule in
    the pipeline keys on error_kind and never on where the failure came from."""
    from tools.sql_executor import SQL_ERROR_KIND
    from services.insights_pipeline.sqlcheck import precheck_columns

    result = precheck_columns("SELECT due_at FROM jobs WHERE company_id = $1")

    assert result["error_kind"] == SQL_ERROR_KIND
    assert result["error"].startswith("SQL_ERROR:")
    assert result["rows"] == []


def test_the_rejection_names_the_table_so_the_model_can_fix_it():
    """'due_at does not exist' is not actionable on its own; the model has to be
    told which table it was reaching into."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    result = precheck_columns("SELECT due_at FROM jobs WHERE company_id = $1")
    assert "jobs" in result["error"]


# ----------------------------------------------------- what must NOT be flagged


def test_a_computed_label_is_not_a_column():
    """`AS job_value` invents a name on purpose. Flagging it would reject the
    canonical average-job-value query, which is the single query this whole arm
    exists to see the model get right."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    sql = """
    SELECT AVG(job_value) AS average_job_value
    FROM (
      SELECT j.id, SUM(jp.total_price) AS job_value
      FROM jobs j JOIN job_parts jp ON jp.job_id = j.id
      WHERE j.company_id = $1
      GROUP BY j.id
    ) per_job
    """
    assert precheck_columns(sql) is None


def test_a_cte_alias_is_not_a_table():
    from services.insights_pipeline.sqlcheck import precheck_columns

    sql = """
    WITH recent AS (
      SELECT j.id, j.created_at FROM jobs j WHERE j.company_id = $1
    )
    SELECT COUNT(*) AS n FROM recent WHERE recent.created_at > CURRENT_DATE
    """
    assert precheck_columns(sql) is None


def test_a_string_literal_that_looks_like_a_column_is_not_one():
    from services.insights_pipeline.sqlcheck import precheck_columns

    sql = (
        "SELECT COUNT(*) FROM jobs WHERE company_id = $1 "
        "AND production_status = 'not_a_real_column'"
    )
    assert precheck_columns(sql) is None


def test_sql_functions_and_keywords_are_not_columns():
    from services.insights_pipeline.sqlcheck import precheck_columns

    sql = """
    SELECT DATE_TRUNC('month', j.created_at)::date AS month,
           COALESCE(SUM(jp.total_price), 0) AS booked,
           COUNT(*) FILTER (WHERE j.started_at IS NOT NULL) AS started
    FROM jobs j LEFT JOIN job_parts jp ON jp.job_id = j.id
    WHERE j.company_id = $1 AND j.created_at >= $2::date - INTERVAL '90 days'
    GROUP BY 1 ORDER BY 1
    """
    assert precheck_columns(sql) is None


def test_a_column_that_exists_on_another_referenced_table_is_not_flagged():
    """Unqualified columns are checked against the union of the tables in the
    query, not against one of them. `name` lives on customers, not on jobs, and a
    join that selects it bare is ordinary correct SQL."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    sql = (
        "SELECT name, COUNT(*) FROM jobs j JOIN customers c ON c.id = j.customer_id "
        "WHERE j.company_id = $1 GROUP BY name"
    )
    assert precheck_columns(sql) is None


def test_no_reference_query_in_semantics_is_rejected():
    """The false-positive guard, and the reason this check is safe to put in front
    of the database. These ten queries are the known-good corpus: they are executed
    for real under jigged_ai_readonly on every CI run, so any of them being flagged
    here is unambiguously this module's bug."""
    from services.insights_pipeline.retrieval import load_pairs
    from services.insights_pipeline.sqlcheck import precheck_columns

    rejected = {p.id: precheck_columns(p.sql) for p in load_pairs()}
    rejected = {k: v["error"] for k, v in rejected.items() if v is not None}

    assert not rejected, f"the pre-check rejected known-good reference SQL: {rejected}"


def test_a_column_declared_on_another_table_is_never_flagged():
    """WHY THE CHECK IS GLOBAL AND NOT PER-TABLE, pinned so nobody "improves" it.

    SCHEMA_CONTEXT declares `deleted_at` on customers, vendors, work_centers and
    vendor_services -- and on none of jobs, quotes or parts, all of which have the
    column. A per-table rule therefore rejects `j.deleted_at` saying it does not
    exist on jobs, which is FALSE, and spends the single regeneration teaching the
    model something untrue about its own schema.

    The clause is redundant now -- the connection hides archived rows and the
    prompt says never to write it -- but redundant and non-existent are different
    claims, and this layer must only make the one it can support.
    """
    from services.insights_pipeline.sqlcheck import declared_columns, precheck_columns

    assert "deleted_at" not in declared_columns()["jobs"]
    assert precheck_columns(
        "SELECT COUNT(*) FROM jobs j WHERE j.company_id = $1 AND j.deleted_at IS NULL"
    ) is None


def test_a_column_used_against_the_wrong_table_is_a_known_miss():
    """The cost of being global, recorded rather than discovered later.

    `job_parts.quote_id` was one of the five columns the Gate 2 run invented, and
    it survives this check because `quote_id` is declared on jobs. Nothing in
    SCHEMA_CONTEXT distinguishes that case from `j.deleted_at` above -- both are
    "declared somewhere, used somewhere else" -- so catching it would mean
    reintroducing the false rejection. Postgres catches it on the next line; this
    layer only ever saved a round trip.
    """
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns(
        "SELECT jp.quote_id FROM job_parts jp JOIN jobs j ON j.id = jp.job_id "
        "WHERE j.company_id = $1"
    ) is None


def test_a_schema_qualified_function_call_is_not_a_column():
    """`public.is_job_late(...)` is in the late-job reference query. Reading `public`
    as a bare column name rejected it outright."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns(
        "SELECT COUNT(*) AS late_jobs FROM jobs WHERE company_id = $1 "
        "AND public.is_job_late(due_date, production_status, fulfillment_status, $2)"
    ) is None


# ------------------------------------------- a query that answers from nothing


def test_a_select_of_a_bare_literal_is_refused():
    """THE PAYROLL TRAP, IN THE FORM IT ACTUALLY TOOK. Asked "what is our net profit
    margin after payroll?", Arctic wrote

        SELECT '100%' AS net_profit_margin_after_payroll FROM job_parts WHERE company_id = $1

    and the narrator dutifully reported "Our net profit margin after payroll is
    100%." The arithmetic guard passed it, and passed it CORRECTLY by its own
    rule: 100 really was in the returned rows, 37 times over. Nothing downstream of
    the query can tell a computed value from a constant the model typed, so the
    refusal has to happen here, where the SELECT list is still visible.

    This is the Gate 1 hallucination ("net profit margin after payroll: 67.9%")
    reappearing through a pipeline built to prevent it -- by a different route,
    with a better score.
    """
    from services.insights_pipeline.sqlcheck import precheck_columns

    result = precheck_columns(
        "SELECT '100%' AS net_profit_margin_after_payroll FROM job_parts WHERE company_id = $1"
    )
    assert result is not None
    assert result["error_kind"] == "sql_error"
    assert "constant" in result["error"] or "literal" in result["error"]


def test_a_select_of_a_bare_number_is_refused():
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns("SELECT 0 AS late_jobs FROM jobs WHERE company_id = $1") is not None


def test_a_literal_alongside_a_real_column_is_allowed():
    """Labelling a real figure is ordinary SQL. Only a select list with NOTHING but
    constants in it is answering from nowhere."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns(
        "SELECT 'late' AS bucket, COUNT(*) AS n FROM jobs WHERE company_id = $1 GROUP BY 1"
    ) is None


def test_an_aggregate_over_a_constant_is_allowed():
    """COUNT(*) selects no column and is the most common correct query there is."""
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns("SELECT COUNT(*) AS n FROM jobs WHERE company_id = $1") is None


def test_a_coalesce_to_zero_is_allowed():
    from services.insights_pipeline.sqlcheck import precheck_columns

    assert precheck_columns(
        "SELECT COALESCE(SUM(qli.total_price), 0) AS worth FROM quotes q "
        "JOIN quote_line_items qli ON qli.quote_id = q.id WHERE q.company_id = $1"
    ) is None


def test_a_constants_rejection_still_names_itself_in_the_dump():
    """precheck_rejected is how the sidecar attributes a refusal. A rejection that
    names no identifier -- because there is no identifier -- would otherwise record
    a pre-check that fired for no stated reason."""
    from services.insights_pipeline.sqlcheck import offending_column, precheck_columns

    result = precheck_columns("SELECT '100%' AS margin FROM job_parts WHERE company_id = $1")
    assert offending_column(result) == "(select list is all constants)"
