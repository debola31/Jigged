"""AI provider services.

Deliberately empty of re-exports. Every consumer imports from the module it
wants -- `from services.ai.factory import get_provider` -- and nothing in the
repo does `from services.ai import ...`. The re-export block that used to sit
here was not merely unused: it ran on `import services.ai.factory`, which
`data_import_routes` does, and it eagerly imported provider modules that import
their vendor SDKs at module load. Adding a provider file here costs an import
of its SDK on a request path that may never use it.
"""
