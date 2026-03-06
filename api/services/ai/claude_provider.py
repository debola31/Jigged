"""Claude (Anthropic) AI provider implementation."""

import json
import logging
import os
import re
from typing import Optional

import anthropic

from .base_provider import AIProvider, MappingSuggestion

logger = logging.getLogger(__name__)


MAPPING_PROMPT_TEMPLATE = """You are analyzing a CSV file to map columns to a customer database schema for a manufacturing ERP system.

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


class ClaudeProvider(AIProvider):
    """Claude (Anthropic) AI provider."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        """Initialize Claude provider.

        Args:
            api_key: Anthropic API key. If not provided, uses ANTHROPIC_API_KEY env var.
            model: Model to use. Defaults to claude-sonnet-4-20250514.
        """
        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY is required")

        self.client = anthropic.Anthropic(api_key=self.api_key)
        self.model = model or "claude-sonnet-4-20250514"

    @property
    def provider_name(self) -> str:
        return "anthropic"

    async def suggest_column_mappings(
        self,
        csv_headers: list[str],
        sample_rows: list[list[str]],
        target_schema: dict[str, dict],
        column_samples: Optional[dict[str, str]] = None,
    ) -> list[MappingSuggestion]:
        """Analyze CSV and suggest column mappings using Claude."""

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
            for i, row in enumerate(sample_rows[:5]):  # Limit to 5 rows
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

        # Call Claude API (sync for now, can be made async with httpx)
        response = self.client.messages.create(
            model=self.model,
            max_tokens=8192,
            messages=[{"role": "user", "content": prompt}],
        )

        # Parse response
        response_text = response.content[0].text.strip()

        # Try to extract JSON from the response
        try:
            # Handle potential markdown code blocks
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                json_lines = []
                in_json = False
                for line in lines:
                    if line.startswith("```") and not in_json:
                        in_json = True
                        continue
                    elif line.startswith("```") and in_json:
                        break
                    elif in_json:
                        json_lines.append(line)
                response_text = "\n".join(json_lines)

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
            # If parsing fails, return low-confidence mappings for all columns
            return [
                MappingSuggestion(
                    csv_column=header,
                    db_field=None,
                    confidence=0.0,
                    reasoning=f"AI response parsing failed: {str(e)}",
                )
                for header in csv_headers
            ]

    async def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        system_prompt: str,
        max_tokens: int = 4000,
    ) -> dict:
        """Run a tool-use conversation loop with Claude.

        Calls the Anthropic API, executes any tool calls via the insights
        service, passes results back, and repeats until the model produces
        a final text response.

        Returns:
            Dict with keys: content, tool_calls, model, tokens_used
        """
        from services.insights_service import execute_sql_tool, execute_tool

        # Extract company_id from the first user message
        company_id = self._extract_company_id(messages)

        # Build Anthropic-format messages
        api_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
        ]

        tool_names_called: list[str] = []
        total_tokens = 0
        max_iterations = 5  # Safety limit on tool-use loops

        for _ in range(max_iterations):
            response = self.client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=api_messages,
                tools=tools,
            )

            total_tokens += (response.usage.input_tokens + response.usage.output_tokens)

            # Check if the model wants to use tools
            if response.stop_reason == "tool_use":
                # Add the full assistant response (text + tool_use blocks)
                api_messages.append({
                    "role": "assistant",
                    "content": response.content,
                })

                # Execute each tool call and collect results
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        tool_names_called.append(block.name)
                        try:
                            if block.name == "execute_sql":
                                # Text-to-SQL: run via SQL executor
                                result_data = await execute_sql_tool(
                                    company_id=company_id,
                                    sql=block.input.get("sql", ""),
                                    description=block.input.get("description", ""),
                                )
                            else:
                                # Predefined tool: run via metric function dispatcher
                                result_data = execute_tool(
                                    company_id=company_id,
                                    tool_name=block.name,
                                    tool_input=block.input,
                                )
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": json.dumps(result_data),
                            })
                        except Exception as e:
                            logger.warning(f"Tool {block.name} failed: {e}")
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": json.dumps({"error": str(e)}),
                                "is_error": True,
                            })

                # Add tool results as user message
                api_messages.append({
                    "role": "user",
                    "content": tool_results,
                })
            else:
                # Final response — extract text content
                text_parts = [
                    block.text for block in response.content
                    if hasattr(block, "text")
                ]
                final_content = "\n".join(text_parts)

                return {
                    "content": final_content,
                    "tool_calls": tool_names_called,
                    "model": self.model,
                    "tokens_used": total_tokens,
                }

        # If we exhausted iterations, return whatever we have
        text_parts = [
            block.text for block in response.content
            if hasattr(block, "text")
        ]
        return {
            "content": "\n".join(text_parts) if text_parts else "I wasn't able to complete the analysis. Please try a simpler question.",
            "tool_calls": tool_names_called,
            "model": self.model,
            "tokens_used": total_tokens,
        }

    @staticmethod
    def _extract_company_id(messages: list[dict]) -> str:
        """Extract company_id from the first user message."""
        for msg in messages:
            if msg.get("role") == "user":
                content = msg.get("content", "")
                match = re.search(r"company_id:\s*([a-f0-9-]+)", content)
                if match:
                    return match.group(1)
        raise ValueError("company_id not found in messages")
