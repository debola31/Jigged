"""OpenAI AI provider implementation."""

import json
import os
from typing import Optional

from openai import OpenAI

from .base_provider import (
    AIProvider,
    FixSuggestionResult,
    ImportNarrativeResult,
    StructureResult,
)




class OpenAIProvider(AIProvider):
    """OpenAI GPT AI provider."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        """Initialize OpenAI provider.

        Args:
            api_key: OpenAI API key. If not provided, uses OPENAI_API_KEY env var.
            model: Model to use. Defaults to gpt-4o.
        """
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY is required")

        self.client = OpenAI(api_key=self.api_key)
        self.model = model or "gpt-4o"

    @property
    def provider_name(self) -> str:
        return "openai"

    async def analyze_structure(self, files, entity_schemas, erp_catalog) -> StructureResult:
        # The data-import review is Anthropic-only for now (factory defaults to Anthropic).
        raise NotImplementedError("analyze_structure is not implemented for the OpenAI provider")

    async def generate_import_narrative(self, erp, findings, file_summaries) -> ImportNarrativeResult:
        raise NotImplementedError("generate_import_narrative is not implemented for the OpenAI provider")

    async def suggest_fixes(self, findings, file_summaries) -> FixSuggestionResult:
        raise NotImplementedError("suggest_fixes is not implemented for the OpenAI provider")

