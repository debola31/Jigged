"""Chain resolution: what runs, in what order, and what refuses to run at all.

The two rules under test are policy rather than plumbing. A migrated surface's
production chain is LOCAL-ONLY and fail-visible -- when the desktop is down the
user is told so, rather than being quietly served by a hosted model at forty
times the cost, because "it still worked" is the failure mode here, not the happy
path. And DeepInfra never enters a production chain at all.
"""
from __future__ import annotations

import pytest

from services.llm.errors import LLMNotConfigured
from services.llm.registry import chain_for, resolve_feature

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in (
        "LLM_PROFILE", "VERCEL_ENV", "ANTHROPIC_API_KEY", "DEEPINFRA_API_KEY",
        "DEEPINFRA_BASE_URL", "OLLAMA_BASE_URL",
        "LLM_CHAIN_INSIGHTS", "LLM_CHAIN_INSIGHTS_DEV", "LLM_CHAIN_DRAWINGS",
    ):
        monkeypatch.delenv(var, raising=False)


class TestOrder:
    def test_the_chain_is_built_in_the_declared_order(self, monkeypatch):
        """Two features declared in opposite orders, so an alphabetical or
        cheapest-first implementation cannot pass by accident."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("DEEPINFRA_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfra:Qwen/Qwen3-32B,anthropic")
        monkeypatch.setenv("LLM_CHAIN_DRAWINGS", "anthropic,deepinfra:Qwen/Qwen3-32B")
        assert [p.name for p in chain_for("insights")] == ["deepinfra", "anthropic"]
        assert [p.name for p in chain_for("drawings")] == ["anthropic", "deepinfra"]

    def test_an_ollama_model_tag_keeps_its_colon(self, monkeypatch):
        """maxsplit=1. A naive split truncates "qwen3:8b" to "qwen3" and the
        request 404s at a provider that reports the model it was asked for -- so
        the ledger would record the truncated name too."""
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "ollama:qwen3:8b")
        assert chain_for("insights")[0].model == "qwen3:8b"

    def test_a_vision_tag_survives_too(self, monkeypatch):
        monkeypatch.setenv("LLM_CHAIN_DRAWINGS", "ollama:qwen3-vl:4b")
        assert chain_for("drawings")[0].model == "qwen3-vl:4b"


class TestSkippingAndRefusing:
    def test_a_provider_with_no_key_is_skipped_and_the_chain_continues(self, monkeypatch):
        """The rollout property. Every preview deployment and every laptop lacks a
        DeepInfra key today, so raising here would break the feature everywhere the
        moment this merged."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfra:Qwen/Qwen3-32B,anthropic")
        assert [p.name for p in chain_for("insights")] == ["anthropic"]

    def test_the_keyless_local_provider_is_not_mistaken_for_an_unconfigured_one(self, monkeypatch):
        """Ollama has no key BY DESIGN, so the skip rule is per-provider-kind. A
        blanket rule would skip the only provider a migrated surface has."""
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "ollama:qwen3:8b")
        chain = chain_for("insights")
        assert [p.name for p in chain] == ["ollama"]
        assert "authorization" not in {k.lower() for k in chain[0]._headers()}

    def test_a_chain_emptied_by_skips_raises_rather_than_degrading(self, monkeypatch):
        """Losing a PREFERRED provider quietly-but-logged is fine. Losing the
        FEATURE quietly is not."""
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfra:Qwen/Qwen3-32B,anthropic")
        with pytest.raises(LLMNotConfigured) as exc:
            chain_for("insights")
        assert "missing key" in str(exc.value)

    def test_an_unknown_feature_raises(self):
        with pytest.raises(LLMNotConfigured):
            chain_for("no_such_feature")

    def test_a_typo_in_a_slug_raises_instead_of_silently_shortening_the_chain(self, monkeypatch):
        """A chain that quietly degraded to Anthropic-only because of a misspelling
        is the expensive, invisible failure ai_calls exists to expose."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfrra:Qwen/Qwen3-32B,anthropic")
        with pytest.raises(LLMNotConfigured) as exc:
            chain_for("insights")
        assert "deepinfrra" in str(exc.value)

    def test_deepinfra_is_refused_in_a_production_chain(self, monkeypatch):
        """Its key never goes to Vercel, so this should be unreachable -- which is
        exactly why it raises loudly rather than being skipped like a missing key."""
        monkeypatch.setenv("VERCEL_ENV", "production")
        monkeypatch.setenv("DEEPINFRA_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfra:Qwen/Qwen3-32B")
        with pytest.raises(LLMNotConfigured) as exc:
            chain_for("insights")
        assert "production" in str(exc.value)

    def test_deepinfra_is_allowed_off_production(self, monkeypatch):
        monkeypatch.setenv("VERCEL_ENV", "preview")
        monkeypatch.setenv("DEEPINFRA_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "deepinfra:Qwen/Qwen3-32B")
        assert [p.name for p in chain_for("insights")] == ["deepinfra"]


class TestProfile:
    def test_the_dev_variant_is_only_used_when_the_profile_says_so(self, monkeypatch):
        """Explicit LLM_PROFILE, never inferred. index.py records the incident where
        an inferred environment made local, pytest, preview and production all
        report as "development"; the blast radius here is which model answered a
        customer."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        assert resolve_feature("insights") == "insights"
        monkeypatch.setenv("LLM_PROFILE", "dev")
        assert resolve_feature("insights") == "insights_dev"

    def test_a_profile_with_no_dev_chain_falls_back_to_the_base_feature(self, monkeypatch):
        monkeypatch.setenv("LLM_PROFILE", "dev")
        assert resolve_feature("no_such_feature") == "no_such_feature"

    def test_the_dev_chain_is_local_only(self, monkeypatch):
        """A dev profile that could reach a paid provider would bill real money for
        a laptop's experiments."""
        monkeypatch.setenv("LLM_PROFILE", "dev")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("DEEPINFRA_API_KEY", "k")
        assert [p.name for p in chain_for(resolve_feature("insights"))] == ["ollama"]


class TestDefaults:
    def test_every_default_chain_is_anthropic_so_merging_changes_nothing(self, monkeypatch):
        """THE DARK-ROLLOUT PROPERTY. Merging this layer must not change what any
        production surface does; each flips by setting its own LLM_CHAIN_* variable
        after its golden check passes, and reverts with one env change."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        for feature in ("insights", "drawings"):
            assert [p.name for p in chain_for(feature)] == ["anthropic"]

    def test_the_local_timeout_is_longer_than_the_hosted_one(self, monkeypatch):
        """Slow local hardware. The 120s only makes sense off Vercel, which is the
        whole reason ollama work is claimed by the desktop rather than executed by
        a request handler."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "ollama:qwen3:8b,anthropic")
        ollama, anthropic_p = chain_for("insights")
        assert (ollama.timeout_s, anthropic_p.timeout_s) == (120.0, 30.0)

    def test_the_local_provider_is_priced_at_exactly_zero(self, monkeypatch):
        """Not env-overridable: electricity is not billed per token, so any nonzero
        value here could only ever be wrong."""
        monkeypatch.setenv("LLM_CHAIN_INSIGHTS", "ollama:qwen3:8b")
        p = chain_for("insights")[0]
        assert (p._price_in, p._price_out) == (0, 0)


class TestPackageBoundary:
    def test_the_old_ai_package_never_imports_the_new_one(self):
        """One-way import, asserted rather than remembered.

        services/llm imports exactly one thing from services/ai --
        DEFAULT_ANTHROPIC_MODEL, so a model migration stays a one-line change in
        the file that exists to be its single source of truth. The reverse would
        make the two abstractions circular and make retiring services/ai harder
        than deleting it, which is the whole plan for it.
        """
        from pathlib import Path

        ai_dir = Path(__file__).resolve().parents[2] / "services" / "ai"
        offenders = [
            f.name for f in ai_dir.glob("*.py")
            if "services.llm" in f.read_text() or "from .llm" in f.read_text()
        ]
        assert offenders == [], f"services/ai must not import services/llm: {offenders}"
