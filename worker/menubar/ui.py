"""The status item itself. THE ONLY MODULE HERE THAT TOUCHES APPKIT.

Everything it renders is decided in state.py, which is pure and tested; this file
draws and dispatches, so that the judgement lives where CI can reach it. See
tests/test_no_ui_import.py for the guard that keeps it that way.

TWO RULES GOVERN THE TIMERS. Nothing that can block goes on the main thread -- a
git fetch over dead Wi-Fi is precisely the condition this app exists to display,
and a frozen menu bar is a worse report of it than no menu bar. And the cheap read
runs often while the expensive one runs rarely, because the icon has to be current
and `runs`/`print-disabled`/git do not.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import objc
from AppKit import (
    NSApplication,
    NSApplicationActivationPolicyAccessory,
    NSColor,
    NSImage,
    NSImageLeft,
    NSMenu,
    NSMenuItem,
    NSStatusBar,
    NSTimer,
    NSVariableStatusItemLength,
    NSWorkspace,
)
from Foundation import NSObject, NSURL
from PyObjCTools import AppHelper

from worker.menubar import launchctl, ollama, repo, state, statusfile

# The Jigged J, as a TEMPLATE image: black plus alpha, from which macOS derives
# the light-mode, dark-mode and highlighted-menu renderings itself. Colour baked
# into the file would look wrong in at least one of the three, so state is carried
# by a tint applied over it instead.
ICON = Path(__file__).resolve().parent / "jigged-template.png"
ICON_POINTS = (12.0, 17.0)

# State is a TINT on the J, not a different shape. The icon says whose worker this
# is and has to stay recognisable; the colour says how it is doing. None means the
# template default, which is the only rendering that tracks the menu bar's own
# appearance -- so the healthy case is the one that looks native.
TINTS = {
    state.CRASHLOOP: "systemRedColor",
    state.UNREACHABLE: "systemOrangeColor",
    state.WEDGED: "systemOrangeColor",
    state.OFF: "tertiaryLabelColor",
    state.STOPPED: "tertiaryLabelColor",
    state.STARTING: "tertiaryLabelColor",
}

FAST_S = 2.0     # status file + `launchctl list`: drives the glyph
SLOW_S = 30.0    # `launchctl print`, print-disabled, local git reads
FETCH_S = 900.0  # the only network call, and it never runs on the main thread


class Controller(NSObject):
    def initWithConfig_(self, cfg):
        self = objc.super(Controller, self).init()
        if self is None:
            return None
        self.cfg = cfg
        self.item = NSStatusBar.systemStatusBar().statusItemWithLength_(
            NSVariableStatusItemLength
        )
        icon = NSImage.alloc().initWithContentsOfFile_(str(ICON))
        if icon is not None:
            # setTemplate_ is what hands the rendering to macOS. Without it the
            # image is drawn as-is and turns invisible in one of the two modes.
            icon.setTemplate_(True)
            icon.setSize_(ICON_POINTS)
            self.item.button().setImage_(icon)
            self.item.button().setImagePosition_(NSImageLeft)
        self.watcher = state.RestartWatcher()
        self.slow: Dict[str, Any] = {"checkout": None, "ollama": None}
        # Written by the fetch thread, read by the main thread. A plain dict swap
        # under a lock -- the thread never touches the menu.
        self.fetch = {"ok": True, "error": None, "at": 0.0}
        self.fetch_lock = threading.Lock()
        self.indicator = None
        self.doc = None
        self.service = None
        return self

    # ------------------------------------------------------------- polling

    @objc.python_method
    def _read_fast(self) -> None:
        self.service = launchctl.read(self.cfg["label"], self.cfg["uid"])
        self.doc = statusfile.load()
        looping = self.watcher.observe(self.service.runs, time.monotonic()) and bool(
            self.service.last_exit
        )
        self.indicator = state.derive(self.service, self.doc, crash_looping=looping)

    @objc.python_method
    def _read_slow(self) -> None:
        self.slow["checkout"] = repo.read(self.cfg["repo"])
        base = (self.doc or {}).get("ollama_base_url") or "http://localhost:11434/v1"
        self.slow["ollama"] = ollama.resident(base)

    @objc.python_method
    def _fetch_loop(self) -> None:
        while True:
            r = launchctl.run(repo.argv_fetch(self.cfg["repo"]), timeout=30.0)
            with self.fetch_lock:
                self.fetch = {
                    "ok": r.code == 0,
                    # NEVER round a failure down to "up to date". A behind-count
                    # from a fetch that did not happen is a confident fiction.
                    "error": None if r.code == 0 else r.out.strip().splitlines()[:1],
                    "at": time.time(),
                }
            time.sleep(FETCH_S)

    def tickFast_(self, _timer) -> None:
        self._read_fast()
        self._render()

    def tickSlow_(self, _timer) -> None:
        self._read_slow()
        self._render()

    # ------------------------------------------------------------ rendering

    @objc.python_method
    def _add(self, menu, title, action=None, enabled=True, indent=0):
        it = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, "")
        if action is not None:
            it.setTarget_(self)
        it.setEnabled_(bool(enabled and action is not None))
        if indent:
            it.setIndentationLevel_(indent)
        menu.addItem_(it)
        return it

    @objc.python_method
    def _render(self) -> None:
        ind = self.indicator
        if ind is None:
            return
        button = self.item.button()
        # A space before the count so the J and the number do not collide.
        button.setTitle_(" {}".format(ind.title) if ind.title else "")
        tint = TINTS.get(ind.state)
        button.setContentTintColor_(getattr(NSColor, tint)() if tint else None)
        # The image alone cannot say WHY, so the whole state travels in the
        # tooltip -- reachable without clicking, and readable by VoiceOver.
        button.setToolTip_("Jigged worker - {}".format(ind.headline))

        m = NSMenu.alloc().init()
        m.setAutoenablesItems_(False)
        self._add(m, ind.headline)
        for line in ind.detail:
            self._add(m, line, indent=1)

        oll = self.slow.get("ollama") or {}
        if oll.get("up") and oll.get("models"):
            mo = oll["models"][0]
            self._add(m, "{} resident - {} GB, {} ctx".format(
                mo["name"], mo["size_gb"], mo["context"] or "?"))
        elif oll:
            self._add(m, "Ollama is not answering on localhost")

        job = (self.doc or {}).get("last_job")
        if job:
            self._add(m, "last: {} ({}) in {}s".format(
                str(job.get("job_id"))[:8], job.get("feature"), job.get("seconds")))

        m.addItem_(NSMenuItem.separatorItem())
        self._render_code_section(m)
        m.addItem_(NSMenuItem.separatorItem())
        self._render_controls(m)
        m.addItem_(NSMenuItem.separatorItem())
        self._add(m, "Open worker log", "openLog:")
        self._add(m, "Refresh now", "refreshNow:")
        self._add(m, "Quit indicator (the worker keeps running)", "quitApp:")
        self.item.setMenu_(m)

    @objc.python_method
    def _render_code_section(self, m) -> None:
        co = self.slow.get("checkout")
        doc = self.doc
        if co is None:
            self._add(m, "checkout: reading...")
            return
        running = (doc or {}).get("commit")
        self._add(m, "running code: {}  on {}".format(
            (running or "unknown")[:8], co.branch or "?"))
        # The signal that costs nothing and is the one people actually need.
        if repo.running_code_is_stale(co, doc):
            self._add(m, "Checkout has moved since it started - restart to pick it up",
                      "doRestart:")

        with self.fetch_lock:
            fetch = dict(self.fetch)
        if not fetch["ok"]:
            self._add(m, "Update check failed: {}".format(
                (fetch["error"] or ["?"])[0][:60]))
            return
        if co.behind:
            self._add(m, "{} commit{} behind origin/main".format(
                co.behind, "" if co.behind == 1 else "s"))
        blocked = repo.blockers(co, doc, fetch_ok=fetch["ok"])
        if blocked:
            self._add(m, "Pull blocked: {}".format("; ".join(blocked)), enabled=False)
        elif co.behind:
            self._add(m, "Pull and restart", "doPull:")

    @objc.python_method
    def _render_controls(self, m) -> None:
        ind, doc = self.indicator, self.doc or {}
        if ind.state in (state.OFF, state.STOPPED):
            self._add(m, "Start worker", "doStart:")
            return
        self._add(m, "Restart worker", "doRestart:")
        if doc.get("busy"):
            # A stop during a job is a SIGKILL: launchd's exit timeout for this
            # job is 5s and a model call can run for 480. Saying so in the menu is
            # the only place a person could learn it before the fact.
            held = doc.get("held") or 1
            self._add(m, "Stop - {} job{} running, would be re-queued".format(
                held, "" if held == 1 else "s"), enabled=False)
            self._add(m, "Stop anyway (re-queues the running job)", "doStopNow:")
        else:
            self._add(m, "Stop until next login", "doStopUntilLogin:")
        self._add(m, "Turn off (stays off across reboot)", "doTurnOff:")

    # -------------------------------------------------------------- actions

    @objc.python_method
    def _exec(self, commands: List[List[str]]) -> None:
        """Run argv lists in order, stopping at the first failure.

        The ordering matters (enable before bootstrap, disable before bootout), so
        a failure must not silently proceed to the second half.
        """
        for cmd in commands:
            r = launchctl.run(cmd, timeout=20.0)
            if r.code != 0:
                self._notify("{} failed: {}".format(cmd[1], r.out.strip()[:120]))
                return
        self._read_fast()
        self._render()

    @objc.python_method
    def _notify(self, message: str) -> None:
        # Deliberately just the menu: a failure a person has to dismiss is worse
        # than one they find when they look, and this process must not grow a
        # notification permission prompt.
        self.indicator = self.indicator._replace(headline=message)
        self._render()

    def doStart_(self, _s) -> None:
        self._exec(launchctl.argv_start(self.cfg["label"], self.cfg["uid"], self.cfg["plist"]))

    def doRestart_(self, _s) -> None:
        self._exec(launchctl.argv_restart(self.cfg["label"], self.cfg["uid"]))

    def doStopUntilLogin_(self, _s) -> None:
        self._exec(launchctl.argv_stop_until_login(self.cfg["label"], self.cfg["uid"]))

    def doStopNow_(self, _s) -> None:
        self._exec(launchctl.argv_stop_until_login(self.cfg["label"], self.cfg["uid"]))

    def doTurnOff_(self, _s) -> None:
        self._exec(launchctl.argv_turn_off(self.cfg["label"], self.cfg["uid"]))

    def doPull_(self, _s) -> None:
        co = self.slow.get("checkout")
        with self.fetch_lock:
            ok = self.fetch["ok"]
        # Re-checked at the moment of the click, not merely at the moment of
        # drawing: the tree can have moved since the menu was built.
        blocked = repo.blockers(co, self.doc, fetch_ok=ok) if co else ["checkout unknown"]
        if blocked:
            self._notify("Pull refused: {}".format("; ".join(blocked)))
            return
        self._exec(repo.argv_pull(self.cfg["repo"])
                   + launchctl.argv_restart(self.cfg["label"], self.cfg["uid"]))

    def openLog_(self, _s) -> None:
        NSWorkspace.sharedWorkspace().openURL_(NSURL.fileURLWithPath_(self.cfg["log"]))

    def refreshNow_(self, _s) -> None:
        self._read_fast()
        self._read_slow()
        self._render()

    def quitApp_(self, _s) -> None:
        NSApplication.sharedApplication().terminate_(self)


def run(cfg: Dict[str, Any]) -> None:
    app = NSApplication.sharedApplication()
    # WITHOUT THIS THERE IS NO MENU. A process with no Info.plist defaults to
    # NSApplicationActivationPolicyProhibited, which "may not create windows or be
    # activated" -- and the menu that drops off a status item is a window. This is
    # the line that makes a bundle-less, unsigned, uninstalled script work.
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    # It registers with LaunchServices as "python", because the display name comes
    # from the executable and only a real .app bundle can change it -- measured:
    # NSProcessInfo.setProcessName_ moves the in-process value and nothing else.
    # As a UIElement it appears in no Dock and no app switcher, so the name is
    # visible only in Activity Monitor, which is not worth a bundle and a signing
    # step to fix.

    ctrl = Controller.alloc().initWithConfig_(cfg)
    ctrl._read_fast()
    ctrl._read_slow()
    ctrl._render()

    threading.Thread(target=ctrl._fetch_loop, daemon=True).start()
    for interval, sel in ((FAST_S, "tickFast:"), (SLOW_S, "tickSlow:")):
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            interval, ctrl, sel, None, True
        )
    AppHelper.runEventLoop()
