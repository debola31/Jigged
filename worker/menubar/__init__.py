"""The worker's menu bar indicator: a reader, and only a reader.

THIS PROCESS OPENS NO DATABASE CONNECTION, ENQUEUES NOTHING, AND CALLS NO MODEL.
It reads a status file the worker publishes, asks launchd whether a pid exists,
reads local git refs, and asks Ollama on localhost what is resident. That is the
whole of it. CLAUDE.md's rule for this queue is that a poll may DISCOVER work but
never CREATE it; this polls nothing that could enqueue, and it must stay that way.

WHY IT NEVER RENDERS AN "OFFLINE" VERDICT. "Offline" means 60 seconds of missed
heartbeats, and that number is already pinned in several places that must agree.
This shows the worker's own per-database reachability -- did the last beat land --
and prints beat ages as raw numbers. Someone reading "beat 214s ago" draws their
own conclusion; someone reading a green dot this module invented would be trusting
a fourth copy of a rule it does not own.

LAYOUT IS LOAD-BEARING. ui.py is the only module that imports AppKit, because
pyobjc ships no Linux wheel and the backend CI job runs on ubuntu -- one AppKit
import in a module a test touches takes that whole job down. Everything else here
is pure and stdlib-only, and tests/test_no_ui_import.py keeps it that way.
"""
