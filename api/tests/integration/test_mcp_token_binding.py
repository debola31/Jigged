"""
AI-assistant tokens work only through /mcp: migration 20261109163801, from the database's side.

A token is minted the way Claude or ChatGPT get one, through Supabase's OAuth server (dynamic
registration, PKCE, consent, code exchange), so the `client_id` claim is real. The Data API must
refuse it unless the request carries a gateway key whose fingerprint is registered, and must leave
browser sessions, anon and service role exactly as they were: the hook runs before EVERY request.

Needs a live local Supabase with the OAuth server enabled (supabase/config.toml). On a PR it runs
against the CI stack.
"""

import base64
import hashlib
import os
import secrets
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

pytestmark = pytest.mark.integration

GATEWAY_KEY = "integration-test-gateway-key-" + secrets.token_hex(8)
REDIRECT = "http://localhost:8976/callback"


def _url() -> str:
    return os.environ["TEST_SUPABASE_URL"].rstrip("/")


def _apikey() -> str:
    return os.environ["TEST_SUPABASE_PUBLISHABLE_KEY"]


@pytest.fixture(scope="module")
def gateway_key(supabase_admin) -> str:
    digest = hashlib.sha256(GATEWAY_KEY.encode()).hexdigest()
    supabase_admin.rpc("register_mcp_gateway_key", {"p_sha256": digest, "p_label": "integration test"}).execute()
    return GATEWAY_KEY


@pytest.fixture(scope="module")
def assistant_token(seeded_user_a) -> str:
    """An access token issued to an OAuth client, for user A, through the real flow."""
    auth = f"{_url()}/auth/v1"
    headers = {"apikey": _apikey()}
    with httpx.Client(timeout=20) as http:
        client = http.post(
            f"{auth}/oauth/clients/register",
            json={
                "client_name": "Integration test assistant",
                "redirect_uris": [REDIRECT],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            },
            headers=headers,
        ).json()
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        authorize = http.get(
            f"{auth}/oauth/authorize",
            params={
                "response_type": "code",
                "client_id": client["client_id"],
                "redirect_uri": REDIRECT,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "s",
                "scope": "email",
            },
            headers=headers,
        )
        authorization_id = parse_qs(urlparse(authorize.headers["location"]).query)["authorization_id"][0]
        user = {**headers, "Authorization": f"Bearer {seeded_user_a['access_token']}"}
        http.get(f"{auth}/oauth/authorizations/{authorization_id}", headers=user).raise_for_status()
        consent = http.post(
            f"{auth}/oauth/authorizations/{authorization_id}/consent", json={"action": "approve"}, headers=user
        ).json()
        code = parse_qs(urlparse(consent["redirect_url"]).query)["code"][0]
        token = http.post(
            f"{auth}/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT,
                "client_id": client["client_id"],
                "code_verifier": verifier,
            },
            headers=headers,
        ).json()
    return token["access_token"]


def _companies(token: str | None = None, key: str | None = None) -> httpx.Response:
    headers = {"apikey": _apikey()}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if key is not None:
        headers["x-jigged-mcp"] = key
    return httpx.get(f"{_url()}/rest/v1/companies", params={"select": "id"}, headers=headers, timeout=20)


def test_an_assistant_token_alone_is_refused(assistant_token):
    res = _companies(assistant_token)
    assert res.status_code == 403
    assert res.json()["code"] == "jigged_mcp_only"


def test_a_wrong_key_is_refused(assistant_token, gateway_key):
    assert _companies(assistant_token, "not-" + gateway_key).status_code == 403


def test_an_rpc_is_refused_too(assistant_token):
    res = httpx.post(
        f"{_url()}/rest/v1/rpc/get_user_company_ids",
        json={},
        headers={"apikey": _apikey(), "Authorization": f"Bearer {assistant_token}"},
        timeout=20,
    )
    assert res.status_code == 403


def test_the_gateway_key_lets_it_through_as_that_user(assistant_token, gateway_key, seeded_user_a):
    res = _companies(assistant_token, gateway_key)
    assert res.status_code == 200
    assert {row["id"] for row in res.json()} == {seeded_user_a["company_id"]}


def test_browser_sessions_anon_and_service_role_are_untouched(seeded_user_a, supabase_admin):
    assert _companies(seeded_user_a["access_token"]).status_code == 200
    assert _companies().status_code == 200
    assert supabase_admin.table("companies").select("id").limit(1).execute().data is not None


def test_storage_gives_an_assistant_token_nothing(assistant_token, gateway_key, seeded_user_a, supabase_admin):
    """Restrictive policy on storage.objects: even with the gateway key, which Storage never sees.

    The object is put there as service role: the seeded company has no subscription, so the
    billing gate would refuse the user's own upload, and that is not what is under test."""
    path = f"{seeded_user_a['company_id']}/binding-test.png"
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    supabase_admin.storage.from_("logos").upload(path, png, {"content-type": "image/png", "upsert": "true"})
    listing = {"prefix": seeded_user_a["company_id"]}
    as_user = httpx.post(
        f"{_url()}/storage/v1/object/list/logos",
        json=listing,
        headers={"apikey": _apikey(), "Authorization": f"Bearer {seeded_user_a['access_token']}"},
        timeout=20,
    )
    as_assistant = httpx.post(
        f"{_url()}/storage/v1/object/list/logos",
        json=listing,
        headers={"apikey": _apikey(), "Authorization": f"Bearer {assistant_token}", "x-jigged-mcp": gateway_key},
        timeout=20,
    )
    assert [o["name"] for o in as_user.json()] == ["binding-test.png"]
    assert as_assistant.status_code in (200, 400, 403)
    assert as_assistant.status_code != 200 or as_assistant.json() == []
