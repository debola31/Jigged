"""Google Gemini AI provider implementation."""

import json
import os
from typing import Optional

from google import genai

from .base_provider import (
    AIProvider,
    FixSuggestionResult,
    ImportNarrativeResult,
    StructureResult,
)




class GeminiProvider(AIProvider):
    """Google Gemini AI provider."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        """Initialize Gemini provider.

        Args:
            api_key: Google AI API key. If not provided, uses GOOGLE_AI_API_KEY env var.
            model: Model to use. Defaults to gemini-2.0-flash.
        """
        self.api_key = api_key or os.getenv("GOOGLE_AI_API_KEY")
        if not self.api_key:
            raise ValueError("GOOGLE_AI_API_KEY is required")

        self.client = genai.Client(api_key=self.api_key)
        self.model_name = model or "gemini-2.0-flash"

    @property
    def provider_name(self) -> str:
        return "gemini"

    async def analyze_structure(self, files, entity_schemas, erp_catalog) -> StructureResult:
        # The data-import review is Anthropic-only for now (factory defaults to Anthropic).
        raise NotImplementedError("analyze_structure is not implemented for the Gemini provider")

    async def generate_import_narrative(self, erp, findings, file_summaries) -> ImportNarrativeResult:
        raise NotImplementedError("generate_import_narrative is not implemented for the Gemini provider")

    async def suggest_fixes(self, findings, file_summaries) -> FixSuggestionResult:
        raise NotImplementedError("suggest_fixes is not implemented for the Gemini provider")

