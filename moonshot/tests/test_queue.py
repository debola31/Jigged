"""The job queue (moonshot/orchestrate/queue.py): leases, lapses, restarts and late results, on a fake clock."""
import pytest

from moonshot.orchestrate.queue import Queue

RENDER = {"kinds": ["render"], "gpu_mem_gb": 8}


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def q(tmp_path, clock):
    queue = Queue(tmp_path / "q.db", lease_s=60, max_attempts=3, clock=clock)
    yield queue
    queue.close()


def test_a_leased_job_goes_to_one_worker_only(q):
    jid = q.submit("render", {"frame": 1})
    assert [j["id"] for j in q.lease("a", RENDER)] == [jid]
    assert q.lease("b", RENDER) == []


def test_lease_expiry_returns_the_job_for_another_worker(q, clock):
    jid = q.submit("render", {})
    q.lease("a", RENDER)
    clock.t += 61
    assert [j["id"] for j in q.lease("b", RENDER)] == [jid]
    assert q.get(jid)["worker"] == "b" and q.get(jid)["attempts"] == 2


def test_heartbeats_keep_a_lease_alive(q, clock):
    jid = q.submit("render", {})
    q.lease("a", RENDER)
    for _ in range(5):
        clock.t += 40
        assert q.heartbeat("a", [jid]) == []
    assert q.lease("b", RENDER) == []


def test_a_worker_killed_mid_job_loses_it_after_max_attempts(q, clock):
    jid = q.submit("render", {})
    for worker in "abc":
        assert q.lease(worker, RENDER)
        clock.t += 61                                 # each one dies without a heartbeat
    assert q.lease("d", RENDER) == []
    job = q.get(jid)
    assert job["state"] == "failed" and "lease lapsed 3 times" in job["error"]


def test_heartbeat_reports_leases_the_worker_lost(q, clock):
    jid = q.submit("render", {})
    q.lease("a", RENDER)
    clock.t += 61
    q.lease("b", RENDER)
    assert q.heartbeat("a", [jid]) == [jid]


def test_a_late_result_is_accepted_and_a_duplicate_ignored(q, clock):
    """The travelling M4 Max finishes offline; its lease lapsed and another worker took the job."""
    jid = q.submit("render", {})
    q.lease("m4", RENDER)
    clock.t += 61
    q.lease("m1", RENDER)
    assert q.complete("m4", jid, {"frames": 480}) is True
    assert q.complete("m1", jid, {"frames": 480}) is False
    assert q.get(jid)["state"] == "done" and q.get(jid)["worker"] == "m4"


def test_the_queue_survives_a_hub_restart(tmp_path, clock):
    path = tmp_path / "q.db"
    a = Queue(path, lease_s=60, clock=clock)
    done, leased, queued = (a.submit("render", {"n": i}) for i in range(3))
    a.lease("w", RENDER, max_jobs=2)
    a.complete("w", done, {"ok": True})
    a.close()
    b = Queue(path, lease_s=60, clock=clock)
    assert b.get(done)["state"] == "done" and b.get(done)["result"] == {"ok": True}
    assert b.get(leased)["state"] == "leased"
    assert b.get(queued)["state"] == "queued"
    clock.t += 61
    assert {j["id"] for j in b.lease("w2", RENDER, max_jobs=5)} == {leased, queued}
    b.close()


def test_a_reported_failure_retries_then_fails(q):
    jid = q.submit("render", {})
    for expected in ("queued", "queued", "failed"):
        q.lease("a", RENDER)
        assert q.fail("a", jid, "blender exited 1") == expected
    assert q.get(jid)["error"] == "blender exited 1"


def test_only_the_lease_holder_can_report_failure(q):
    jid = q.submit("render", {})
    q.lease("a", RENDER)
    assert q.fail("b", jid, "not mine") is None
    assert q.get(jid)["state"] == "leased"


def test_jobs_route_by_kind_and_gpu_memory(q):
    small = q.submit("render", {}, requires={"gpu_mem_gb": 4})
    big = q.submit("render", {}, requires={"gpu_mem_gb": 24})
    q.submit("solve", {})
    got = q.lease("gtx1070", {"kinds": ["render"], "gpu_mem_gb": 8}, max_jobs=5)
    assert [j["id"] for j in got] == [small]
    assert [j["id"] for j in q.lease("m4", {"kinds": ["render"], "gpu_mem_gb": 48}, max_jobs=5)] == [big]


def test_a_cache_only_worker_takes_only_jobs_it_holds_inputs_for(q):
    """Away from home, the M4 Max must never pull a scene pack over a hotspot."""
    have = q.submit("render", {}, inputs=["a" * 64])
    q.submit("render", {}, inputs=["b" * 64])
    away = {**RENDER, "cache_only": True}
    assert [j["id"] for j in q.lease("m4", away, cached=["a" * 64], max_jobs=5)] == [have]


def test_a_job_pinned_to_a_worker_runs_only_there(q):
    jid = q.submit("render", {}, requires={"worker": "m1-pro"})
    assert q.lease("m4-max", RENDER) == []
    assert [j["id"] for j in q.lease("m1-pro", RENDER)] == [jid]


def test_priority_then_age_decides_order(q, clock):
    late = q.submit("render", {}, priority=100)
    clock.t += 1
    urgent = q.submit("render", {}, priority=10)
    assert [j["id"] for j in q.lease("a", RENDER, max_jobs=2)] == [urgent, late]


def test_submitting_a_known_id_is_a_no_op(q):
    assert q.submit("render", {"v": 1}, job_id="step-abc") == "step-abc"
    q.submit("render", {"v": 2}, job_id="step-abc")
    assert q.get("step-abc")["payload"] == {"v": 1}


def test_status_counts_jobs_by_group_and_lists_held_leases(q):
    jid = q.submit("render", {}, group="G1")
    q.submit("render", {}, group="G1")
    q.lease("a", RENDER)
    st = q.status()
    assert st["by_group"]["G1"] == {"leased": 1, "queued": 1}
    assert st["workers"][0]["leased"] == [jid]


def test_a_running_job_reports_its_progress_and_the_dashboard_gives_its_eta(q, clock):
    from moonshot.orchestrate.dashboard import eta_s, render_dashboard
    jid = q.submit("bake_render", {"take": "vise"})
    q.lease("m4", {"kinds": ["bake_render"]})
    q.heartbeat("m4", [jid], {jid: {"stage": "render", "done": 100, "total": 400, "since": clock.t}})
    job = q.get(jid)
    assert job["progress"]["done"] == 100 and job["started"] == clock.t
    since = clock.t
    clock.t += 30                                       # 100 frames in 30 s: 300 left take 90 s
    q.heartbeat("m4", [jid], {jid: {"stage": "render", "done": 100, "total": 400, "since": since}})
    assert eta_s(q.get(jid), clock.t, {}) == 90
    page = render_dashboard(q)
    assert "25% (100/400)" in page and "vise" in page
