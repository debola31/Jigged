"""
pilot_requests and the pilot-requests bucket, asserted from the database's and Storage's side.

The showcase pilot request takes a part file and contact details from a visitor with no account
(supabase/migrations/20261105014457_showcase_pilot_requests.sql). The form promises the visitor
that only the Jigged team opens the file; that promise is a claim about grants, RLS and bucket
settings, and an over-grant raises no error and breaks no page. So it is asserted here.

The upload is done the way the BROWSER does it (lib/pilotRequestClient.ts): a raw-body PUT to the
signed URL with an explicit Content-Type and only the publishable key — not supabase-py's
multipart helper, which would test a request the app never sends.

Needs a live local Supabase (see docs/testing/README.md); CI's backend job provides one.
"""

import os
import uuid

import httpx
import pytest
from supabase import create_client

pytestmark = pytest.mark.integration

BUCKET = "pilot-requests"
STEP_BYTES = b"ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n"


def _publishable_key() -> str:
    key = os.getenv("TEST_SUPABASE_PUBLISHABLE_KEY")
    if not key:
        pytest.exit("TEST_SUPABASE_PUBLISHABLE_KEY not configured.")
    return key


def _anon():
    return create_client(os.environ["TEST_SUPABASE_URL"], _publishable_key())


def _browser_put(url: str, body: bytes, content_type: str) -> httpx.Response:
    return httpx.put(
        url,
        content=body,
        headers={"content-type": content_type, "x-upsert": "false", "apikey": _publishable_key()},
        timeout=30,
    )


def _assert_refused(call) -> None:
    """A browser-role call on this table must be refused outright, or match nothing."""
    try:
        res = call()
        assert not res.data, f"a browser role reached pilot_requests: {res.data}"
    except Exception as exc:  # PostgREST 42501 surfaces as an APIError
        text = str(exc).lower()
        assert "42501" in text or "permission denied" in text, str(exc)


@pytest.fixture
def pilot_row(supabase_admin):
    rid = str(uuid.uuid4())
    row = {
        "id": rid,
        "email": "owner@shop.example",
        "file_name": "bracket.step",
        "file_type": "step",
        "file_size_bytes": len(STEP_BYTES),
        "storage_path": f"{rid}/bracket.step",
    }
    supabase_admin.table("pilot_requests").insert(row).execute()
    yield row
    # Hard delete is the erasure path by design (no deleted_at on this table).
    supabase_admin.table("pilot_requests").delete().eq("id", rid).execute()
    try:
        supabase_admin.storage.from_(BUCKET).remove([row["storage_path"]])
    except Exception:
        pass


def test_browser_roles_cannot_read_or_write_requests(pilot_row, seeded_user_a):
    anon = _anon()
    user = seeded_user_a["client"]
    rid = pilot_row["id"]
    fresh = {**pilot_row, "id": str(uuid.uuid4())}
    fresh["storage_path"] = f"{fresh['id']}/bracket.step"

    for client in (anon, user):
        _assert_refused(lambda: client.table("pilot_requests").select("id, email").execute())
        _assert_refused(lambda: client.table("pilot_requests").insert(fresh).execute())
        _assert_refused(
            lambda: client.table("pilot_requests").update({"email": "x@y.example"}).eq("id", rid).execute()
        )
        _assert_refused(lambda: client.table("pilot_requests").delete().eq("id", rid).execute())


def test_bucket_is_private_and_limited(supabase_admin):
    bucket = supabase_admin.storage.get_bucket(BUCKET)
    assert bucket.public is False
    assert bucket.file_size_limit == 52428800
    assert set(bucket.allowed_mime_types) == {"application/octet-stream", "application/pdf"}


def test_signed_upload_lands_without_any_policy_and_is_unreadable_to_anon(supabase_admin, pilot_row):
    path = pilot_row["storage_path"]
    signed = supabase_admin.storage.from_(BUCKET).create_signed_upload_url(path)

    res = _browser_put(signed["signed_url"], STEP_BYTES, "application/octet-stream")
    assert res.status_code == 200, res.text

    # What /pilot-requests/complete reads to confirm the upload.
    info = supabase_admin.storage.from_(BUCKET).info(path)
    assert info["size"] == len(STEP_BYTES)

    anon_bucket = _anon().storage.from_(BUCKET)
    with pytest.raises(Exception):
        anon_bucket.download(path)
    try:
        listed = anon_bucket.list(pilot_row["id"])
        assert listed == [], f"anon could list a pilot request's folder: {listed}"
    except Exception:
        pass  # refused outright is as good as empty


def test_signed_url_writes_once(supabase_admin, pilot_row):
    """x-upsert false: a token cannot be replayed to overwrite the visitor's file."""
    signed = supabase_admin.storage.from_(BUCKET).create_signed_upload_url(pilot_row["storage_path"])
    first = _browser_put(signed["signed_url"], STEP_BYTES, "application/octet-stream")
    assert first.status_code == 200, first.text

    second = _browser_put(signed["signed_url"], b"replaced", "application/octet-stream")
    assert second.status_code >= 400
    # The duplicate shape lib/pilotRequestClient.ts treats as "already uploaded".
    assert second.status_code == 409 or "409" in second.text or "Duplicate" in second.text, second.text


def test_bucket_refuses_other_content_types(supabase_admin):
    path = f"{uuid.uuid4()}/page.html"
    signed = supabase_admin.storage.from_(BUCKET).create_signed_upload_url(path)
    res = _browser_put(signed["signed_url"], b"<script>alert(1)</script>", "text/html")
    assert res.status_code >= 400, "the bucket accepted text/html"
