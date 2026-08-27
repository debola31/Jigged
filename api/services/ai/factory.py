"""AI provider factory with database-driven configuration."""

from typing import Optional

from supabase import Client

from .base_provider import AIProvider
from .claude_provider import ClaudeProvider


def create_provider(provider_name: str, model: Optional[str] = None) -> AIProvider:
    """Create an AI provider instance by name.

    Anthropic is the only implementation. `OpenAIProvider` and `GeminiProvider`
    used to sit beside it and every one of their methods raised
    NotImplementedError, so an `ai_config.provider` row naming either one bought
    a 500 at call time rather than a second provider. They are gone; an unknown
    name now raises here, which `get_provider` catches and answers with the
    Anthropic default.

    Args:
        provider_name: Provider identifier ('anthropic')
        model: Optional model override

    Returns:
        AIProvider instance

    Raises:
        ValueError: If provider name is unknown or API key is missing
    """
    provider_name = provider_name.lower()

    if provider_name == "anthropic":
        return ClaudeProvider(model=model)
    else:
        raise ValueError(f"Unknown AI provider: {provider_name}")


async def get_provider(
    supabase: Client,
    company_id: str,
    feature: str = "csv_mapping",
) -> AIProvider:
    """Get the AI provider configured for a company and feature.

    Looks up the ai_config table to determine which provider to use.
    Falls back to Anthropic (Claude) if no configuration exists.

    Args:
        supabase: Supabase client instance
        company_id: The company UUID
        feature: The feature type (e.g., 'csv_mapping', 'chat')

    Returns:
        Configured AIProvider instance
    """
    try:
        # Query ai_config table for the configured provider. The model is NOT
        # read from here — model selection is centralized in model_config.py
        # (DEFAULT_ANTHROPIC_MODEL) so a single source of truth governs which
        # Claude model is used and a retired id can't linger in a stale row.
        response = (
            supabase.table("ai_config")
            .select("provider, settings")
            .eq("company_id", company_id)
            .eq("feature", feature)
            .maybe_single()
            .execute()
        )

        if response.data:
            provider_name = response.data.get("provider", "anthropic")
            return create_provider(provider_name)

    except Exception:
        # If DB lookup fails, fall back to default
        pass

    # Default to Claude/Anthropic
    return create_provider("anthropic")
