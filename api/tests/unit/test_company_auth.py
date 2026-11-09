"""The office-only and billing guards in routes/company_auth.py."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

import routes.company_auth as company_auth

pytestmark = pytest.mark.unit

COMPANY = "11111111-1111-1111-1111-111111111111"


def _request(token: str | None = "t"):
    return SimpleNamespace(headers={"Authorization": f"Bearer {token}"} if token else {})


def _member(role: str):
    return AsyncMock(return_value=("user-1", {"id": "access-1", "role": role}))


class TestOfficeAccess:
    async def test_no_token_is_401_without_touching_the_database(self, monkeypatch):
        service = MagicMock(side_effect=AssertionError("no client may be built"))
        monkeypatch.setattr(company_auth, "service_client", service)
        with pytest.raises(HTTPException) as exc:
            await company_auth.verify_office_access(_request(None), COMPANY)
        assert exc.value.status_code == 401

    async def test_an_operator_is_refused(self, monkeypatch):
        monkeypatch.setattr(company_auth, "verify_company_access", _member("operator"))
        with pytest.raises(HTTPException) as exc:
            await company_auth.verify_office_access(_request(), COMPANY)
        assert exc.value.status_code == 403
        assert exc.value.detail == company_auth.OFFICE_ONLY_DETAIL

    @pytest.mark.parametrize("role", ["admin", "user"])
    async def test_office_roles_pass(self, role, monkeypatch):
        monkeypatch.setattr(company_auth, "verify_company_access", _member(role))
        user_id, row = await company_auth.verify_office_access(_request(), COMPANY)
        assert user_id == "user-1"
        assert row["role"] == role


class TestCompanyCanWrite:
    def _with_rpc(self, monkeypatch, *, data=None, raises=None):
        client = MagicMock()
        if raises is not None:
            client.rpc.return_value.execute.side_effect = raises
        else:
            client.rpc.return_value.execute.return_value.data = data
        monkeypatch.setattr(company_auth, "service_client", lambda: client)
        return client

    def test_an_entitled_company_passes(self, monkeypatch):
        client = self._with_rpc(monkeypatch, data=True)
        company_auth.assert_company_can_write(COMPANY)
        client.rpc.assert_called_once_with("company_can_write", {"check_company_id": COMPANY})

    @pytest.mark.parametrize("data", [False, None])
    def test_anything_but_true_is_refused(self, data, monkeypatch):
        self._with_rpc(monkeypatch, data=data)
        with pytest.raises(HTTPException) as exc:
            company_auth.assert_company_can_write(COMPANY)
        assert exc.value.status_code == 403
        assert exc.value.detail == company_auth.BILLING_BLOCKED_DETAIL

    def test_a_failed_check_fails_closed_and_is_reported(self, monkeypatch):
        """A write we cannot prove is entitled does not run, as the RLS gate would refuse it."""
        self._with_rpc(monkeypatch, raises=RuntimeError("connection reset"))
        with patch.object(company_auth.sentry_sdk, "capture_exception") as capture:
            with pytest.raises(HTTPException) as exc:
                company_auth.assert_company_can_write(COMPANY)
        assert exc.value.status_code == 503
        capture.assert_called_once()


class TestOfficeWriteAccess:
    async def test_the_billing_check_runs_only_for_an_office_member(self, monkeypatch):
        monkeypatch.setattr(company_auth, "verify_company_access", _member("operator"))
        can_write = MagicMock()
        monkeypatch.setattr(company_auth, "assert_company_can_write", can_write)
        with pytest.raises(HTTPException):
            await company_auth.verify_office_write_access(_request(), COMPANY)
        can_write.assert_not_called()

    async def test_an_entitled_office_member_passes(self, monkeypatch):
        monkeypatch.setattr(company_auth, "verify_company_access", _member("user"))
        can_write = MagicMock()
        monkeypatch.setattr(company_auth, "assert_company_can_write", can_write)
        user_id, _ = await company_auth.verify_office_write_access(_request(), COMPANY)
        assert user_id == "user-1"
        can_write.assert_called_once_with(COMPANY)
