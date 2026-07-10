"""OpenAI AI provider implementation."""

import json
import os
from typing import Optional

from openai import OpenAI

from .base_provider import (
    AIProvider,
    ImportNarrativeResult,
    MappingSuggestion,
    StructureResult,
)


MAPPING_PROMPT_TEMPLATE = """You are analyzing a CSV file to map columns to a customer database schema for a manufacturing operations data platform.

## Target Database Schema:
{schema_json}

## CSV Headers ({header_count} columns):
{headers_json}

## Sample Values (one example per non-empty column):
{sample_data}

Note: Columns not listed in sample values are empty (no data in sample rows).

## Instructions:
1. Map each CSV column to a database field, or null if it should be skipped
2. Provide a confidence score (0.0-1.0) based on:
   - 1.0: Exact name match or unambiguous (e.g., "email" -> "email")
   - 0.8-0.99: Very likely match (e.g., "Company" -> "name", "Tel" -> "phone")
   - 0.5-0.79: Probable match with some ambiguity (e.g., "Phone1" could be "phone" or "contact_phone")
   - 0.1-0.49: Uncertain, needs human review
   - 0.0: No reasonable mapping, should be skipped

3. For columns WITHOUT sample data, use the column name semantically to determine mapping
4. For empty columns, suggest skipping them with reasoning "Column is empty"
5. Only use database fields from the schema - do not invent new fields

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{{
  "mappings": [
    {{"csv_column": "Company Name", "db_field": "name", "confidence": 0.95, "reasoning": "Direct match for company/customer name"}},
    {{"csv_column": "Internal ID", "db_field": null, "confidence": 0.0, "reasoning": "Internal system field, not needed"}}
  ]
}}"""


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

    async def suggest_column_mappings(
        self,
        csv_headers: list[str],
        sample_rows: list[list[str]],
        target_schema: dict[str, dict],
        column_samples: Optional[dict[str, str]] = None,
    ) -> list[MappingSuggestion]:
        """Analyze CSV and suggest column mappings using OpenAI."""

        # Format sample data based on which parameter is provided
        if column_samples is not None:
            # New format: dict of column -> sample value
            sample_data_lines = [
                f"  {col}: \"{val}\""
                for col, val in column_samples.items()
            ]
            sample_data = "\n".join(sample_data_lines) if sample_data_lines else "(no sample data)"
        else:
            # Legacy format: rows of data (backward compatibility)
            sample_data_lines = []
            for i, row in enumerate(sample_rows[:5]):
                row_data = ", ".join(
                    f"{csv_headers[j]}: {row[j]}" if j < len(row) else f"{csv_headers[j]}: (empty)"
                    for j in range(len(csv_headers))
                )
                sample_data_lines.append(f"Row {i + 1}: {row_data}")
            sample_data = "\n".join(sample_data_lines)

        # Build the prompt
        prompt = MAPPING_PROMPT_TEMPLATE.format(
            schema_json=json.dumps(target_schema, indent=2),
            headers_json=json.dumps(csv_headers),
            header_count=len(csv_headers),
            sample_data=sample_data,
        )

        # Call OpenAI API
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=8192,
            response_format={"type": "json_object"},
        )

        # Parse response
        response_text = response.choices[0].message.content.strip()

        try:
            data = json.loads(response_text)
            mappings = []

            for item in data.get("mappings", []):
                mappings.append(
                    MappingSuggestion(
                        csv_column=item["csv_column"],
                        db_field=item.get("db_field"),
                        confidence=float(item.get("confidence", 0.5)),
                        reasoning=item.get("reasoning", ""),
                    )
                )

            return mappings

        except (json.JSONDecodeError, KeyError) as e:
            return [
                MappingSuggestion(
                    csv_column=header,
                    db_field=None,
                    confidence=0.0,
                    reasoning=f"AI response parsing failed: {str(e)}",
                )
                for header in csv_headers
            ]
