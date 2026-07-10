"""Abstract base class for AI providers."""

from abc import ABC, abstractmethod
from typing import Optional

from pydantic import BaseModel


class MappingSuggestion(BaseModel):
    """Result from AI column mapping analysis."""

    csv_column: str
    db_field: Optional[str]  # None means skip/discard
    confidence: float  # 0.0 to 1.0
    reasoning: str


class ErpDetectionResult(BaseModel):
    """AI guess at the source ERP. Same 0.0-1.0 confidence contract as MappingSuggestion."""

    source: str = "unknown"
    display_name: str = "Unknown"
    confidence: float = 0.0
    matched_headers: list[dict] = []  # {"header": str, "signal": str}
    evidence: str = ""
    alternatives: list[dict] = []  # {"source": str, "confidence": float}


class FileStructure(BaseModel):
    """AI classification of one uploaded file: entity type + raw->canonical column roles."""

    filename: str
    entity_type: str = "unknown"
    entity_confidence: float = 0.0
    column_roles: dict[str, str] = {}  # canonical_field -> raw_header


class StructureResult(BaseModel):
    """Combined structure + source analysis of an uploaded bundle."""

    erp: ErpDetectionResult = ErpDetectionResult()
    files: list[FileStructure] = []


class ImportNarrativeResult(BaseModel):
    """Plain-text narrative + guidance, grounded in the deterministic findings."""

    summary: str = ""
    recommendations: list[str] = []
    gotchas: list[dict] = []  # {"title","detail","recommended_action"} — informative, unverified
    available: bool = True  # False -> narrative generation failed; UI shows raw findings only


class AIProvider(ABC):
    """Abstract base class for AI providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return the name of this provider."""
        pass

    @abstractmethod
    async def suggest_column_mappings(
        self,
        csv_headers: list[str],
        sample_rows: list[list[str]],
        target_schema: dict[str, dict],
        column_samples: Optional[dict[str, str]] = None,
    ) -> list[MappingSuggestion]:
        """
        Analyze CSV headers and sample data to suggest column mappings.

        Args:
            csv_headers: List of column headers from the CSV
            sample_rows: First few rows of data for context (legacy, ignored if column_samples provided)
            target_schema: Dictionary describing target database fields
            column_samples: Optional dict mapping column name to one sample value (preferred format)

        Returns:
            List of MappingSuggestion objects with confidence scores
        """
        pass

    @abstractmethod
    async def analyze_structure(
        self,
        files: list[dict],
        entity_schemas: dict[str, dict],
        erp_catalog: list[dict],
    ) -> StructureResult:
        """Classify each uploaded file (entity type + raw->canonical column_roles) and
        detect the likely source ERP in a single call.

        Args:
            files: [{"filename", "headers": [str], "column_samples": {header: sample}}]
            entity_schemas: {entity_name: schema_dict} — the canonical fields to map onto
            erp_catalog: [{"source","display_name","header_hint"}] — prompt grounding only

        Returns:
            StructureResult (should degrade to unknown rather than raise on a bad response).
        """
        pass

    @abstractmethod
    async def generate_import_narrative(
        self,
        erp: dict,
        findings: list[dict],
        file_summaries: list[dict],
    ) -> ImportNarrativeResult:
        """Write a plain-text import-review narrative grounded STRICTLY in the given
        deterministic findings (no invented numbers). Returns available=False on failure
        so the caller can show raw findings instead of fabricated prose.
        """
        pass
