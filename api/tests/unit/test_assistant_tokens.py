"""AI-assistant (OAuth) tokens at the FastAPI boundary: accepted only through /mcp, and never on
the routes no assistant tool uses. See routes/company_auth.py and migration 20261109163801."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import jwt
import pytest
from fastapi import HTTPException

import routes.company_auth as company_auth

pytestmark = pytest.mark.unit

GATEWAY_KEY = "test-gateway-key"


def _token(**claims) -> str:
    return jwt.encode({"sub": "user-1", "role": "authenticated", **claims}, "unit-test-secret-at-least-32-bytes-long", algorithm="HS256")


ASSISTANT = _token(client_id="client-9")
BROWSER = _token(session_id="s-1")


def _request(token: str, gateway: str | None = None):
    headers = {"Authorization": f"Bearer {token}"}
    if gateway is not None:
        headers[company_auth.MCP_GATEWAY_HEADER] = gateway
    return SimpleNamespace(headers=headers)


@pytest.fixture(autouse=True)
def gateway_key(monkeypatch):
    monkeypatch.setenv("MCP_GATEWAY_KEY", GATEWAY_KEY)


class TestAssistantClientId:
    def test_reads_the_client_id_claim(self):
        assert company_auth.assistant_client_id(ASSISTANT) == "client-9"

    def test_a_browser_session_has_none(self):
        assert company_auth.assistant_client_id(BROWSER) is None

    @pytest.mark.parametrize("garbage", ["", "not-a-jwt", "a.b.c"])
    def test_garbage_is_not_an_assistant(self, garbage):
        assert company_auth.assistant_client_id(garbage) is None


class TestRefuseUnboundAssistant:
    def test_a_browser_session_passes_without_the_key(self):
        company_auth.refuse_unbound_assistant(_request(BROWSER))

    def test_an_assistant_through_mcp_passes(self):
        company_auth.refuse_unbound_assistant(_request(ASSISTANT, GATEWAY_KEY))

    @pytest.mark.parametrize("gateway", [None, "", "wrong-key"])
    def test_an_assistant_token_anywhere_else_is_refused(self, gateway):
        with pytest.raises(HTTPException) as exc:
            company_auth.refuse_unbound_assistant(_request(ASSISTANT, gateway))
        assert exc.value.status_code == 403
        assert exc.value.detail == company_auth.UNBOUND_ASSISTANT_DETAIL

    def test_an_unconfigured_server_refuses_rather_than_matching_empty(self, monkeypatch):
        monkeypatch.delenv("MCP_GATEWAY_KEY")
        with pytest.raises(HTTPException):
            company_auth.refuse_unbound_assistant(_request(ASSISTANT, ""))


class TestRefuseAssistant:
    def test_refuses_an_assistant_even_through_mcp(self):
        with pytest.raises(HTTPException) as exc:
            company_auth.refuse_assistant(_request(ASSISTANT, GATEWAY_KEY))
        assert exc.value.status_code == 403
        assert exc.value.detail == company_auth.ASSISTANT_NOT_ALLOWED_DETAIL

    def test_a_browser_session_passes(self):
        company_auth.refuse_assistant(_request(BROWSER))


class TestCompanyAccessRefusesUnboundAssistants:
    """verify_company_access is what the QuickBooks, import and insights routes share."""

    def _client(self, monkeypatch):
        client = MagicMock()
        client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id="user-1"))
        client.table.return_value.select.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value.data = [
            {"id": "access-1", "role": "admin"}
        ]
        monkeypatch.setattr(company_auth, "service_client", lambda: client)
        return client

    async def test_an_unbound_assistant_is_refused_before_the_membership_read(self, monkeypatch):
        client = self._client(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            await company_auth.verify_company_access(_request(ASSISTANT), "co-1")
        assert exc.value.status_code == 403
        client.table.assert_not_called()

    async def test_a_bound_assistant_and_a_browser_session_both_get_through(self, monkeypatch):
        self._client(monkeypatch)
        assert (await company_auth.verify_company_access(_request(ASSISTANT, GATEWAY_KEY), "co-1"))[0] == "user-1"
        assert (await company_auth.verify_company_access(_request(BROWSER), "co-1"))[0] == "user-1"
