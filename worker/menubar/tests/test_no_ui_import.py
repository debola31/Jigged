"""AppKit must stay quarantined in ui.py, and this is a build failure not a habit.

pyobjc ships macOS-only wheels -- there is no Linux wheel and its sdist needs an
Objective-C compiler. The backend CI job runs on ubuntu-latest, so a single
`import AppKit` reached by a test takes that entire job down, and the tempting fix
(a `sys_platform == "darwin"` marker plus a skip) buys a green tick for the
absence of the thing being guarded. Keeping the import in one un-tested module is
the only arrangement that works, so something has to enforce it.
"""
from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path("worker/menubar")
MAY_IMPORT_UI = {"ui.py", "__main__.py"}
UI_MODULES = {"AppKit", "objc", "Foundation", "Cocoa", "PyObjCTools", "rumps"}


def _imported_names(path: Path) -> set:
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_only_the_ui_modules_touch_appkit() -> None:
    offenders = {
        p.name: sorted(_imported_names(p) & UI_MODULES)
        for p in PACKAGE.glob("*.py")
        if p.name not in MAY_IMPORT_UI and _imported_names(p) & UI_MODULES
    }
    assert offenders == {}, "these must not import a UI framework: {}".format(offenders)


def test_no_test_imports_a_ui_module() -> None:
    """A test that imports AppKit fails the ubuntu job just as hard as source would."""
    offenders = {
        p.name: sorted(_imported_names(p) & UI_MODULES)
        for p in (PACKAGE / "tests").glob("*.py")
        if _imported_names(p) & UI_MODULES
    }
    assert offenders == {}, offenders


def test_the_pure_modules_import_on_a_machine_with_no_pyobjc() -> None:
    """Importing every non-UI module must not reach a macOS framework."""
    import importlib
    for p in sorted(PACKAGE.glob("*.py")):
        if p.name in MAY_IMPORT_UI or p.name == "__init__.py":
            continue
        importlib.import_module("worker.menubar.{}".format(p.stem))
