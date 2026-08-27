"""A fixed retrieve -> generate -> execute -> summarize path for insights.

An EVAL ARM, not a production surface. Nothing registers this in handler_for():
a third feature name would pull in LLM_CHAIN_* resolution, resolve_feature's
_dev suffix rule and ai_jobs.resolve_execution's executor decision, which is how
an experiment ends up in the job queue's routing table. evals/insights_ab.py
calls run() directly.

WHAT IT FIXES BY CONSTRUCTION, which is exactly one thing and worth stating
narrowly. The pipeline never uses the tool-calling protocol, so the failure
insights_presentation._TOOL_TAG was added for -- a model TYPING `<execute_sql>`
and its JSON instead of calling it, scoring `answered` because the text contained
no error language -- cannot happen here. There is no tool to narrate.

WHAT IT DOES NOT FIX BY CONSTRUCTION. Narrator displacement moves from the model
to the retriever rather than disappearing: if retrieval hands back the
started/shipped exemplar for "what is my revenue trend", the SQL runs, the rows
are real, every number in the narration is in the rows, and the answer is still
about the wrong question. That is why every retrieved pair carries its
source_question into the dump -- so the case names itself instead of needing a
human to notice the same sentence three times.
"""

from services.insights_pipeline.pipeline import run

__all__ = ["run"]
