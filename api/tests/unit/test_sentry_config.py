"""
Sentry initialisation guards — see `api/index.py`.

These exist because the backend's Sentry setup used to report from the test suite
itself. `sentry_sdk.init` runs at import time, and `tests/conftest.py` does
`from index import app`, so every pytest run armed the SDK. Tests that deliberately
provoke failures — a bad Stripe webhook signature, a Resend 500 — were then filed as
High-priority *production* errors and alerted on every CI run. Two of the 23 issues in
the backend queue were passing tests.

Both guards below are the kind that regress silently: nothing fails loudly if Sentry
starts reporting from CI again, it just quietly refills the queue with noise.
"""
import os

import sentry_sdk

import index


class TestPytestGuard:
    """Importing the app under pytest must not arm Sentry."""

    def test_under_pytest_is_detected(self):
        # pytest is in sys.modules by the time index.py is imported during collection,
        # which is *earlier* than PYTEST_CURRENT_TEST becomes available.
        assert index._UNDER_PYTEST is True

    def test_sdk_has_no_transport_so_nothing_can_be_sent(self):
        # `is_active()` is NOT the check to use here — it returns True for any
        # initialised client regardless of DSN. The operative fact is the transport:
        # `make_transport` returns None when options["dsn"] is falsy, and with no
        # transport there is nothing to send events over.
        client = sentry_sdk.get_client()

        assert not client.options["dsn"], (
            f"Sentry has a DSN during the test run ({client.options['dsn']!r}). Note "
            "that dsn=None does NOT disable the SDK — it falls back to the SENTRY_DSN "
            "environment variable, which load_dotenv populates from .env.local. "
            "Disabling requires an empty string."
        )
        assert client.transport is None, (
            "Sentry has a live transport during the test run — test-provoked failures "
            "will be filed as production errors. Check the _UNDER_PYTEST guard."
        )


class TestEnvironmentResolution:
    """VERCEL_ENV must win, because ENVIRONMENT is never set on Vercel."""

    def test_prefers_vercel_env(self, monkeypatch):
        monkeypatch.setenv("VERCEL_ENV", "production")
        monkeypatch.setenv("ENVIRONMENT", "staging")
        assert index.resolve_sentry_environment() == "production"

    def test_falls_back_to_environment_off_vercel(self, monkeypatch):
        monkeypatch.delenv("VERCEL_ENV", raising=False)
        monkeypatch.setenv("ENVIRONMENT", "staging")
        assert index.resolve_sentry_environment() == "staging"

    def test_defaults_to_development_when_neither_is_set(self, monkeypatch):
        monkeypatch.delenv("VERCEL_ENV", raising=False)
        monkeypatch.delenv("ENVIRONMENT", raising=False)
        assert index.resolve_sentry_environment() == "development"

    def test_preview_is_distinguishable_from_production(self, monkeypatch):
        # The regression this whole change exists to prevent: a preview deployment
        # reporting under the same name as production (or as local dev).
        monkeypatch.delenv("ENVIRONMENT", raising=False)
        monkeypatch.setenv("VERCEL_ENV", "preview")
        assert index.resolve_sentry_environment() == "preview"

        monkeypatch.setenv("VERCEL_ENV", "production")
        assert index.resolve_sentry_environment() == "production"

    def test_empty_string_is_not_treated_as_a_value(self, monkeypatch):
        # Vercel injecting an empty var must not produce an empty environment name.
        monkeypatch.setenv("VERCEL_ENV", "")
        monkeypatch.setenv("ENVIRONMENT", "")
        assert index.resolve_sentry_environment() == "development"


class TestOnlyDeployedEnvironmentsReport:
    """A locally-run backend must not file into the same queue as production.

    The pytest guard covers CI. It does not cover `python api/index.py`, which is how the
    backend is run in development — and `load_dotenv` reads SENTRY_DSN out of `.env.local`,
    so that process reports for real. The events land tagged `development`, in the same
    project as production, and are indistinguishable at a glance from something a user hit.
    That is one explanation for a backend issue appearing days after the code that filed it
    was fixed.

    The frontend has always had this guard (`enabled: NODE_ENV === "production"`); the
    backend did not.
    """

    def test_development_does_not_report(self):
        assert "development" not in index._REPORTING_ENVIRONMENTS

    def test_deployed_environments_do_report(self):
        # Preview is deliberately included: a preview deployment IS running our code for
        # real, and #625 exists precisely so its failures are visible and separable.
        assert index._REPORTING_ENVIRONMENTS == {"production", "preview"}

    def test_pytest_still_wins_over_a_deployed_environment_name(self):
        # Belt and braces: CI sets VERCEL_ENV on some runners, and a test run must stay
        # silent regardless of what the environment claims to be.
        assert index._SENTRY_ENABLED is False
