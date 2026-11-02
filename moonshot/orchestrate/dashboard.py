"""The hub's dashboard: one plain HTML page, refreshed every 15 s, on the tailnet at http://desktop-4hvjqis:8765/.

Shows each worker (last seen, jobs held), the queue by part group, failures with their errors, and recent results.
Render hours against forecast and cloud credit join it once the render jobs report frame times.
"""
from __future__ import annotations

import html
import json
import time

from moonshot.orchestrate.queue import Queue

STALE_S = 300


def _ago(t: float | None, now: float) -> str:
    if not t:
        return "-"
    s = int(now - t)
    return f"{s}s ago" if s < 120 else f"{s // 60}m ago" if s < 7200 else f"{s // 3600}h ago"


def render_dashboard(queue: Queue) -> str:
    st, now = queue.status(), time.time()
    esc = html.escape
    rows_w = "".join(
        f"<tr><td>{esc(w['name'])}</td>"
        f"<td class={'stale' if now - w['last_seen'] > STALE_S else 'ok'}>{_ago(w['last_seen'], now)}</td>"
        f"<td>{esc(', '.join(w['capabilities'].get('kinds', [])))}</td>"
        f"<td>{len(w['leased'])}</td></tr>" for w in st["workers"]) or "<tr><td colspan=4>no workers yet</td></tr>"
    states = ["queued", "leased", "done", "failed"]
    rows_g = "".join(
        f"<tr><td>{esc(g)}</td>" + "".join(f"<td>{c.get(s, 0)}</td>" for s in states) + "</tr>"
        for g, c in sorted(st["by_group"].items())) or "<tr><td colspan=5>empty</td></tr>"
    failed = queue.jobs("failed", limit=20)
    rows_f = "".join(f"<tr><td>{esc(j['id'][:12])}</td><td>{esc(j['kind'])}</td><td>{esc(j['error'] or '')}</td></tr>"
                     for j in failed) or "<tr><td colspan=3>none</td></tr>"
    done = queue.jobs("done", limit=20)
    rows_d = "".join(f"<tr><td>{esc(j['id'][:12])}</td><td>{esc(j['kind'])}</td><td>{esc(j['worker'] or '')}</td>"
                     f"<td><code>{esc(json.dumps(j['result'])[:160])}</code></td></tr>"
                     for j in done) or "<tr><td colspan=4>none</td></tr>"
    return f"""<!doctype html><html><head><meta charset=utf-8><meta http-equiv=refresh content=15>
<meta name=viewport content="width=device-width, initial-scale=1"><title>Moonshot farm</title>
<style>body{{font:14px system-ui,sans-serif;margin:16px;background:#111;color:#eee}}
table{{border-collapse:collapse;margin:0 0 20px;width:100%}}td,th{{border-bottom:1px solid #333;padding:4px 8px;
text-align:left}}.ok{{color:#7c7}}.stale{{color:#e77}}code{{font-size:12px}}</style></head><body>
<h1>Moonshot farm</h1>
<h2>Workers</h2><table><tr><th>Name</th><th>Last seen</th><th>Kinds</th><th>Held</th></tr>{rows_w}</table>
<h2>Queue by group</h2><table><tr><th>Group</th>{''.join(f'<th>{s}</th>' for s in states)}</tr>{rows_g}</table>
<h2>Failures</h2><table><tr><th>Job</th><th>Kind</th><th>Error</th></tr>{rows_f}</table>
<h2>Recent results</h2><table><tr><th>Job</th><th>Kind</th><th>Worker</th><th>Result</th></tr>{rows_d}</table>
</body></html>"""
