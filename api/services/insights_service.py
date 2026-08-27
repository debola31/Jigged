"""
Insights service: the chat system prompt, and the one tool behind it.

Contains:
1. `_build_chat_system_prompt()` -- preamble + SCHEMA_CONTEXT + semantics.md +
   guidelines, assembled in that order because the whole thing is a cacheable
   prompt prefix
2. `execute_sql_tool()` -- the handler for the only tool CHAT_TOOLS offers

It used to hold seven predefined metric functions and their dispatcher as well.
Nothing offered them to a model (CHAT_TOOLS has only execute_sql), their tool
descriptions had drifted from their own bodies, and they summed
`job_parts.total_price` as revenue -- which semantics.md, the definition this
file renders into the prompt, says in bold is not a revenue column. Deleted
rather than repaired: a second definition of revenue in the file that serves the
first one is the drift, not a hedge against it.
"""

from functools import lru_cache
from pathlib import Path


# INSIDE api/, NOT docs/, AND THAT IS LOAD-BEARING. vercel.json's excludeFiles
# drops docs/** from every api/** function bundle, so the previous
# docs/ai/semantics.md resolved locally and in CI and raised FileNotFoundError on
# Vercel -- insights was down in production until this moved. Resolve relative to
# this package and the file ships with the code that reads it.
SEMANTICS_PATH = Path(__file__).resolve().parent / "ai" / "semantics.md"


@lru_cache(maxsize=1)
def load_semantics() -> str:
    """The business-term definitions, read from the file that also documents them.

    ONE SOURCE, not a copy. These definitions used to be prose inside
    SCHEMA_CONTEXT with a doc describing them separately, and the two drifted --
    which is how three model arms answered "how many jobs are late right now" with
    5, 4 and 0, each defensibly. api/services/ai/semantics.md is rendered straight
    into the prompt, so the document IS the runtime and drift is structurally
    impossible.

    Cached deliberately: the file changes only via PR, and the assembled prompt has
    to be a stable prefix for prompt caching and Ollama KV reuse to hold.
    """
    return SEMANTICS_PATH.read_text(encoding="utf-8").strip()


def _build_chat_system_prompt() -> str:
    """Build the full system prompt for chat interactions with schema context.

    Order is load-bearing: preamble, structure, semantics, guidelines. Everything
    here is static per deploy, so the whole thing is one cacheable prefix and the
    user's question is the only varying part -- and it arrives as a separate turn.

    NO WORKED ANSWER APPEARS ANYWHERE IN HERE, and that is a rule rather than an
    omission. A local arm answered the payroll question by pasting semantics.md's
    model answer back verbatim, placeholders included -- "$X on $Y of revenue, a
    Z% gross margin" -- so every answer-shaped example is gone and the
    instructions say what to do instead. The chart_config block below is the one
    thing that still shows a sample, and it is a machine format the next sentence
    refers to by key name, not prose to imitate.
    """
    from tools.schema_context import SCHEMA_CONTEXT

    return (
        "You are a business analyst for a small precision manufacturing shop.\n"
        "You have access to the execute_sql tool to query the company's PostgreSQL database.\n\n"
        "Use execute_sql to answer questions by writing SELECT queries. "
        "Always use $1 as the company_id placeholder.\n\n"
        f"{SCHEMA_CONTEXT}\n\n"
        f"{load_semantics()}\n\n"
        "Guidelines:\n"
        "- Always use execute_sql to get real data. Never make up numbers.\n"
        "- Only query the tables documented in the schema above. Never reference user, auth, "
        "access-control, or system tables — they are off-limits.\n"
        "- Rows are ALREADY scoped to one company by the executor. Never join an access-control "
        "table to resolve a person or a company, and never add a company filter beyond the "
        "required $1.\n"
        "- A tool result beginning NOT_PERMITTED is FINAL. No rephrasing grants a privilege, so do "
        "not retry that object: answer from the permitted objects, or say the data is unavailable.\n"
        "- For chat responses: be direct and concise. 1-3 sentences max. Shop owners are busy.\n"
        "- Write answers as plain prose. NEVER use markdown tables or pipe (|) / --- column "
        "formatting — they render as raw text in the UI. For multiple values, rely on the "
        "chart_config plus a one-line summary, or a short inline list of name-and-value pairs "
        "separated by commas.\n"
        "- NEVER write a placeholder or a stand-in figure. State a number you computed from a "
        "query result, or say the figure is unavailable — never a template.\n"
        "- If a query fails, fix it using the error and run it again. NEVER report a database "
        "error, a column name or SQL to the user: if you cannot get the figure, say the figure "
        "is unavailable and why, in plain language.\n"
        "- Default to a one-line prose answer. Only add a chart_config when there are at least "
        "3 data points AND a chart genuinely helps: a trend over time, a comparison across several "
        "categories, or a part-of-whole breakdown. For a single fact, a ranked top-N where one "
        "value dominates, or only 1-2 values, answer in prose only — no chart.\n"
        "- When you do chart: area for trends over time, bar for comparisons across categories, "
        "bar_horizontal for ranked lists with long labels, pie for part-of-whole. Never use bold "
        "(**) or any markdown formatting in the answer.\n"
        "- Answer with facts and numbers only. Do not add advice, opinions, or recommendations unless the user asks.\n"
        "- Include comparisons to previous periods when the data supports it: state the actual "
        "change you computed and the period it is measured against.\n"
        "- Flag risks prominently (low inventory, revenue decline).\n"
        "- Use plain language. Avoid jargon. These are machinists, not MBAs.\n"
        "- In SQL, ALWAYS filter by company_id = $1 on tables that have company_id.\n"
        "- For tables without company_id (job_operations, job_parts, job_materials, routing_operations, parts_bom, parts_unit_conversions), JOIN through parent tables.\n\n"
        "chart_config format (include as a ```json code block when applicable):\n"
        "{\n"
        '  "chart_type": "area" | "pie" | "bar" | "bar_horizontal" | "sparkline",\n'
        '  "data": [{"customer": "Acme", "revenue": 7749.24}, {"customer": "Globex", "revenue": 5210}],\n'
        '  "x_key": "customer",\n'
        '  "y_key": "revenue",\n'
        '  "x_label": "Axis Label",\n'
        '  "y_label": "Axis Label"\n'
        "}\n\n"
        "Every key inside the data row objects MUST be exactly the x_key and y_key strings "
        "(here 'customer' and 'revenue'). Emit valid JSON only — no comments or trailing commas."
    )


async def execute_sql_tool(company_id: str, sql: str, description: str = "") -> dict:
    """
    Execute an AI-generated SQL query via the SQL executor.
    This is the handler for the 'execute_sql' chat tool.

    Args:
        company_id: The company UUID (bound as $1)
        sql: The SELECT query with $1 placeholder
        description: Brief description of what the query computes

    Returns:
        Dict with columns, rows, row_count (or error message)
    """
    from tools.sql_executor import execute_sql_query

    return await execute_sql_query(
        company_id=company_id,
        sql=sql,
        description=description,
    )
