"""The hub over HTTP with a real worker: tokens, content-addressed inputs, and results that outlive the network."""
import hashlib
import threading
import urllib.error
import urllib.request

import pytest

from moonshot.orchestrate import worker as W
from moonshot.orchestrate.hub import put_blob, serve, token_for


@pytest.fixture
def hub(tmp_path):
    root = tmp_path / "hub"
    server = serve(root, port=0, host="127.0.0.1", lease_s=60)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield server, root, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.queue.close()


def make_worker(tmp_path, root, url, name="w1"):
    return W.Worker(name, {"kinds": ["noop", "probe"]}, token_for(root), url, tmp_path / name, W.HANDLERS)


def test_a_job_runs_end_to_end(hub, tmp_path):
    server, root, url = hub
    jid = server.queue.submit("noop", {"hello": "farm"})
    w = make_worker(tmp_path, root, url)
    assert w.step() is True
    job = server.queue.get(jid)
    assert job["state"] == "done" and job["result"]["echo"] == {"hello": "farm"}


def test_inputs_are_fetched_by_hash_and_cached(hub, tmp_path):
    server, root, url = hub
    src = tmp_path / "pack.blend"
    src.write_bytes(b"scene pack bytes")
    digest = put_blob(root, src)
    assert digest == hashlib.sha256(b"scene pack bytes").hexdigest()
    jid = server.queue.submit("noop", {}, inputs=[digest])
    w = make_worker(tmp_path, root, url)
    w.step()
    assert server.queue.get(jid)["result"]["inputs"] == [digest]
    assert (w.cache / digest).read_bytes() == b"scene pack bytes"
    assert digest in w.cached()


def test_a_corrupted_download_is_refused(hub, tmp_path):
    server, root, url = hub
    src = tmp_path / "pack.blend"
    src.write_bytes(b"good")
    digest = put_blob(root, src)
    (root / "blobs" / digest).write_bytes(b"tampered")
    w = make_worker(tmp_path, root, url)
    with pytest.raises(ValueError, match="arrived with hash"):
        w.fetch(digest)
    assert not (w.cache / digest).exists()


def test_writes_and_blobs_need_the_token(hub):
    _, _, url = hub
    for req in (urllib.request.Request(url + "/jobs", data=b"{}"),
                urllib.request.Request(url + "/blobs/" + "0" * 64)):
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        assert e.value.code == 401
    with urllib.request.urlopen(url + "/", timeout=5) as r:
        assert b"Moonshot farm" in r.read()


def test_a_result_survives_the_hub_going_away(hub, tmp_path):
    """Dropped network: the worker finishes, can't report, and reports on reconnect."""
    server, root, url = hub
    jid = server.queue.submit("noop", {"n": 1})
    w = make_worker(tmp_path, root, url)
    w.lease()
    w.hub = "http://127.0.0.1:9"                      # nothing listens here: the hub is unreachable
    w.run_one()
    assert len(list(w.outbox.glob("*.json"))) == 1
    assert server.queue.get(jid)["state"] == "leased"
    w.hub = url                                       # back on the network
    assert w.flush() == 1
    assert server.queue.get(jid)["state"] == "done"


def test_a_failing_handler_is_reported_not_fatal(hub, tmp_path):
    server, root, url = hub
    jid = server.queue.submit("noop", {})

    def broken(worker, job, inputs):
        raise RuntimeError("blender exited 1")

    w = make_worker(tmp_path, root, url)
    w.handlers = {"noop": broken}
    w.step()
    job = server.queue.get(jid)
    assert job["state"] == "queued" and "blender exited 1" in job["error"]
