/**
 * Types for the data-import review (the Review & Fix stage).
 * Field shapes mirror api/models/data_import_models.py; the ImportReview composite is
 * assembled client-side from the /structure + /narrative responses.
 */

export type Severity = 'info' | 'warning' | 'critical';

export type EntityType =
  | 'parts'
  | 'vendors'
  | 'vendor_services'
  | 'work_centers'
  | 'routings'
  | 'bom'
  | 'customers'
  | 'unknown';

export interface MatchedHeader {
  header: string;
  signal: string;
}

export interface ErpAlternative {
  source: string;
  confidence: number;
}

export interface ErpDetection {
  source: string;
  display_name: string;
  confidence: number;
  matched_headers: MatchedHeader[];
  evidence: string;
  alternatives: ErpAlternative[];
  header_signature: string;
  ai_provider: string;
  ai_model: string;
}

export interface FileClassification {
  filename: string;
  entity_type: EntityType;
  entity_confidence: number;
  headers: string[];
  row_count: number;
  column_roles: Record<string, string>;
}

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  entity_type: EntityType;
  title: string;
  detail: string;
  count: number;
  examples: string[];
  source_files: string[];
  verified: boolean;
  recommended_action: string;
}

export interface ImportReview {
  schema_version: number;
  erp_detection: ErpDetection;
  files: FileClassification[];
  findings: Finding[];
  summary: string;
  recommendations: string[];
  narrative_available: boolean;
  ai_provider: string;
  ai_model: string;
  generated_at: string;
}

/** Phase 1: /structure returns per-file classification (incl. column_roles) + ERP detection. */
export interface StructureResponse {
  erp_detection: ErpDetection;
  files: FileClassification[];
}

export interface Gotcha {
  title: string;
  detail: string;
  recommended_action: string;
}

/** Phase 2: /narrative turns the client-computed findings into grounded prose. */
export interface NarrativeResponse {
  summary: string;
  recommendations: string[];
  gotchas: Gotcha[];
  narrative_available: boolean;
  ai_provider: string;
  ai_model: string;
}

/** Phase 2: a guardrail-bound AI suggestion tied to a finding — proposal + honest uncertainty
 *  (never a confidence score); the owner applies it via the deterministic fix tools. */
export interface FixSuggestion {
  finding_id: string;
  action: string;
  uncertainty: string;
}

export interface SuggestFixesResponse {
  suggestions: FixSuggestion[];
  suggestions_available: boolean;
  ai_provider: string;
  ai_model: string;
}

/** One uploaded CSV, parsed client-side, sent to the backend. */
export interface UploadedFilePayload {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
}
