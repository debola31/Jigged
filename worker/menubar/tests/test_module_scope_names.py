"""Every name used at module scope must resolve -- ui.py included.

THIS EXISTS BECAUSE ui.py SHIPPED BROKEN. It referenced `Path` at module scope
without importing it, and nothing caught it: the module cannot be imported on the
CI runner (pyobjc has no Linux wheel), test_no_ui_import.py deliberately excludes
it, and this repo runs no Python linter at all -- no ruff, no flake8, no mypy, in
any workflow. The failure surfaced only as a LaunchAgent respawning every 30
seconds against an unrotated log.

Checking statically is what makes it possible to cover the one module CI can never
import. Scope is module level on purpose: that is where import-time NameErrors
live, and going deeper would mean reimplementing a linter rather than closing this
hole. Decorators and default arguments ARE included, because those evaluate at
definition time and fail the same way.
"""
from __future__ import annotations

import ast
import builtins
from pathlib import Path
from typing import Set

PACKAGE = Path("worker/menubar")
ALWAYS_BOUND = {"__file__", "__name__", "__doc__", "__package__", "__spec__", "__builtins__"}


def _bindings(tree: ast.Module) -> Set[str]:
    """Names the module binds at its own top level."""
    bound: Set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            bound.update((a.asname or a.name.split(".")[0]) for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            bound.update((a.asname or a.name) for a in node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                for sub in ast.walk(t):
                    if isinstance(sub, ast.Name):
                        bound.add(sub.id)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    bound.add(sub.id)
        elif isinstance(node, (ast.Try, ast.If, ast.With, ast.AsyncWith)):
            # Conditional imports are a real pattern; bind anything they could bind.
            for sub in ast.walk(node):
                if isinstance(sub, ast.Import):
                    bound.update((a.asname or a.name.split(".")[0]) for a in sub.names)
                elif isinstance(sub, ast.ImportFrom):
                    bound.update((a.asname or a.name) for a in sub.names)
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    bound.add(sub.name)
                elif isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                    bound.add(sub.id)
    return bound


def _loads_at_module_scope(tree: ast.Module):
    """Name loads evaluated at import time, with lazy bodies left alone."""
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # The body is lazy; decorators and defaults are not.
            sources = list(node.decorator_list) + [
                d for d in node.args.defaults if d is not None
            ]
        elif isinstance(node, ast.ClassDef):
            sources = list(node.decorator_list) + list(node.bases)
        else:
            sources = [node]
        for src in sources:
            for sub in ast.walk(src):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Load):
                    yield sub


def test_no_module_scope_name_is_undefined() -> None:
    known_builtins = set(dir(builtins))
    problems = {}
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text())
        allowed = _bindings(tree) | known_builtins | ALWAYS_BOUND
        missing = sorted({n.id for n in _loads_at_module_scope(tree) if n.id not in allowed})
        if missing:
            problems[path.name] = missing
    assert problems == {}, "undefined at module scope: {}".format(problems)


def test_the_check_actually_catches_the_bug_it_was_written_for() -> None:
    """Guard the guard: a checker that cannot fail proves nothing.

    This is the exact shape ui.py shipped with -- a pathlib name used at module
    scope with no import.
    """
    tree = ast.parse("ICON = Path(__file__).parent / 'x.png'\n")
    allowed = _bindings(tree) | set(dir(builtins)) | ALWAYS_BOUND
    missing = {n.id for n in _loads_at_module_scope(tree) if n.id not in allowed}
    assert "Path" in missing
