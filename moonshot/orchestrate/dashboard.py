"""The hub's dashboard: one plain HTML page, refreshed every 15 s, on the tailnet at http://desktop-4hvjqis:8765/.

Shows what each running job is doing and when it should finish, each worker (last seen, jobs held), the queue by
part group, failures with their errors, and recent results. A running job's ETA comes from the rate it reports (frames
drawn so far), or, for a stage it can't count, from how long that kind of job took before.

Production: the render hours spent so far, drafts and finals, against the forecast (checklist §1: 145,000 frames of
finals for the 20 parts), the hours its remaining frames take at the finals' measured rate, the cloud credit spent
(none: the cloud reserve isn't used, checklist §7), and the drafts awaiting review (a take with a draft and no final).
"""
from __future__ import annotations

import html
import json
import statistics
import time
from pathlib import Path

from moonshot.orchestrate.queue import Queue

STALE_S = 300
FORECAST_FRAMES = 145_000          # finals for all 20 parts (checklist §1's forecast)


def _ago(t: float | None, now: float) -> str:
    if not t:
        return "-"
    s = int(now - t)
    return f"{s}s ago" if s < 120 else f"{s // 60}m ago" if s < 7200 else f"{s // 3600}h ago"


def _duration(s: float | None) -> str:
    if s is None:
        return "-"
    s = int(max(s, 0))
    return f"{s}s" if s < 120 else f"{s // 60}m" if s < 7200 else f"{s // 3600}h {s % 3600 // 60}m"


def typical_s(done: list[dict]) -> dict[str, float]:
    """How long each kind of job has taken, start to finish (the median of its finished runs)."""
    by_kind: dict[str, list[float]] = {}
    for j in done:
        if j.get("started"):
            by_kind.setdefault(j["kind"], []).append(j["updated"] - j["started"])
    return {k: statistics.median(v) for k, v in by_kind.items()}


def eta_s(job: dict, now: float, typical: dict[str, float]) -> float | None:
    """Seconds until a running job finishes: from its counted progress, else from its kind's typical time."""
    p = job.get("progress") or {}
    if p.get("done") and p.get("total"):
        return (now - p["since"]) / p["done"] * (p["total"] - p["done"])
    if job["kind"] in typical and job.get("started"):
        return typical[job["kind"]] - (now - job["started"])
    return None


def production(done: list[dict], takes: Path | None) -> dict:
    """Render hours so far by quality, the finals' frames against the forecast and the hours the rest take at their
    measured rate, and the drafts with no final (awaiting review)."""
    hours = {"draft": 0.0, "final": 0.0}
    frames_final = 0
    for j in done:
        r, p = j.get("result") or {}, j.get("payload") or {}
        if j["kind"] != "take_render" or "render_s" not in r:
            continue
        q = "final" if str(p.get("res", "")).startswith("1920") else "draft"
        hours[q] += r["render_s"] / 3600
        if q == "final" and p.get("frames"):
            frames_final += p["frames"][1] - p["frames"][0]
    rate = hours["final"] / frames_final if frames_final else None
    awaiting = sorted(d.parent.name for d in takes.glob("*/draft.mp4") if not (d.parent / "final.mp4").exists())         if takes and takes.exists() else []
    return {"hours": hours, "frames_final": frames_final,
            "hours_left": rate * max(FORECAST_FRAMES - frames_final, 0) if rate else None, "awaiting": awaiting}


def render_dashboard(queue: Queue, takes: Path | None = None) -> str:
    st, now = queue.status(), time.time()
    esc = html.escape
    typical = typical_s(queue.jobs("done", limit=200))
    running = queue.jobs("leased", limit=50)

    def run_row(j):
        p = j.get("progress") or {}
        pct = f"{100 * p['done'] / p['total']:.0f}% ({int(p['done'])}/{int(p['total'])})" if p.get("total") else "-"
        what = (j["payload"] or {}).get("take") or j["group"] or "-"
        return (f"<tr><td>{esc(j['kind'])}</td><td>{esc(str(what))}</td><td>{esc(j['worker'] or '')}</td>"
                f"<td>{esc(p.get('stage', 'waiting'))}</td><td>{pct}</td>"
                f"<td>{_duration(now - j['started']) if j.get('started') else '-'}</td>"
                f"<td>{_duration(eta_s(j, now, typical))}</td></tr>")
    rows_r = "".join(run_row(j) for j in running) or "<tr><td colspan=7>nothing running</td></tr>"
    waiting = queue.jobs("queued", limit=50)
    rows_q = "".join(f"<tr><td>{esc(j['kind'])}</td><td>{esc(str((j['payload'] or {}).get('take') or j['group']))}</td>"
                     f"<td>{_ago(j['created'], now)}</td><td>{_duration(typical.get(j['kind']))}</td></tr>"
                     for j in waiting) or "<tr><td colspan=4>none</td></tr>"
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
    pr = production(queue.jobs("done", limit=100_000), takes)
    left = f"{pr['hours_left']:.0f} h" if pr["hours_left"] is not None else "- (no final rendered yet)"
    rows_p = (f"<tr><td>Render hours so far</td><td>{pr['hours']['draft']:.1f} h drafts, "
              f"{pr['hours']['final']:.1f} h finals</td></tr>"
              f"<tr><td>Finals against the forecast</td><td>{pr['frames_final']:,} of {FORECAST_FRAMES:,} frames; "
              f"the rest {left} at the finals' rate</td></tr>"
              "<tr><td>Cloud credit</td><td>none spent (the cloud reserve isn't in use)</td></tr>"
              f"<tr><td>Drafts awaiting review ({len(pr['awaiting'])})</td>"
              f"<td>{esc(', '.join(pr['awaiting'])) or 'none'}</td></tr>")
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
<h2>Production</h2><table>{rows_p}</table>
<h2>Running</h2><table><tr><th>Job</th><th>Take</th><th>Worker</th><th>Stage</th><th>Progress</th><th>Elapsed</th>
<th>ETA</th></tr>{rows_r}</table>
<h2>Waiting</h2><table><tr><th>Job</th><th>Take</th><th>Queued</th><th>Typical run</th></tr>{rows_q}</table>
<h2>Workers</h2><table><tr><th>Name</th><th>Last seen</th><th>Kinds</th><th>Held</th></tr>{rows_w}</table>
<h2>Queue by group</h2><table><tr><th>Group</th>{''.join(f'<th>{s}</th>' for s in states)}</tr>{rows_g}</table>
<h2>Failures</h2><table><tr><th>Job</th><th>Kind</th><th>Error</th></tr>{rows_f}</table>
<h2>Recent results</h2><table><tr><th>Job</th><th>Kind</th><th>Worker</th><th>Result</th></tr>{rows_d}</table>
</body></html>"""
