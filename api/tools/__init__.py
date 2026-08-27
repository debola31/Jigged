"""The insights SQL sandbox: tool definition, validator, executor, schema context.

Deliberately empty of re-exports. Nothing in the repo does `from tools import
...` -- every consumer names the module, `from tools.sql_executor import
execute_sql_query`. The file stays so this remains a regular package rather than
becoming a namespace package, which is an import-semantics change and not one a
deletion should make by accident.
"""
