"""AI provider factory with database-driven configuration."""

import os
from typing import Optional

from supabase import Client

from .base_provider import AIProvider
from .claude_provider import ClaudeProvider
from .openai_provider import OpenAIProvider
from .gemini_provider import GeminiProvider
from .model_config import DEFAULT_ANTHROPIC_MODEL


def create_provider(provider_name: str, model: Optional[str] = None) -> AIProvider:
    """Create an AI provider instance by name.

    Args:
        provider_name: Provider identifier ('anthropic', 'openai', 'gemini')
        model: Optional model override

    Returns:
        AIProvider instance

    Raises:
        ValueError: If provider name is unknown or API key is missing
    """
    provider_name = provider_name.lower()

    if provider_name == "anthropic":
        return ClaudeProvider(model=model)
    elif provider_name == "openai":
        return OpenAIProvider(model=model)
    elif provider_name == "gemini":
        return GeminiProvider(model=model)
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


def get_available_providers() -> list[dict]:
    """Get list of available AI providers and their status.

    Returns:
        List of provider info dicts with name, available status, and model info
    """
    providers = []

    # Check Anthropic
    providers.append({
        "name": "anthropic",
        "display_name": "Claude (Anthropic)",
        "available": bool(os.getenv("ANTHROPIC_API_KEY")),
        "default_model": DEFAULT_ANTHROPIC_MODEL,
    })

    # Check OpenAI
    providers.append({
        "name": "openai",
        "display_name": "GPT (OpenAI)",
        "available": bool(os.getenv("OPENAI_API_KEY")),
        "default_model": "gpt-4o",
    })

    # Check Gemini
    providers.append({
        "name": "gemini",
        "display_name": "Gemini (Google)",
        "available": bool(os.getenv("GOOGLE_AI_API_KEY")),
        "default_model": "gemini-1.5-pro",
    })

    return providers
