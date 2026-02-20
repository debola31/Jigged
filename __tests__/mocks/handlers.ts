import { http, HttpResponse } from 'msw';

// Types for API responses
interface ColumnMapping {
  csv_column: string;
  db_field: string | null;
  confidence: number;
  reasoning: string;
  needs_review: boolean;
}

interface ConflictInfo {
  row_number: number;
  csv_name: string | null;
  conflict_type: 'duplicate_name' | 'csv_duplicate_name';
  existing_customer_id: string;
  existing_value: string;
}

interface ValidationError {
  row_number: number;
  error_type: 'missing_name';
  field: string;
}

// Mock data
const mockMappings: ColumnMapping[] = [
  {
    csv_column: 'Company Name',
    db_field: 'name',
    confidence: 0.92,
    reasoning: 'Header contains "Company Name" which matches name field',
    needs_review: false,
  },
  {
    csv_column: 'Phone Number',
    db_field: 'phone',
    confidence: 0.88,
    reasoning: 'Header contains "Phone" which matches phone field',
    needs_review: false,
  },
  {
    csv_column: 'Email',
    db_field: 'email',
    confidence: 0.95,
    reasoning: 'Exact match with email field',
    needs_review: false,
  },
  {
    csv_column: 'Notes',
    db_field: null,
    confidence: 0.6,
    reasoning: 'Low confidence match, discarding',
    needs_review: true,
  },
];

export const handlers = [
  // POST /api/customers/import/analyze - AI column mapping
  http.post('/api/customers/import/analyze', async ({ request }) => {
    const body = await request.json() as { company_id: string; headers: string[]; sample_rows: string[][] };

    // Validate request
    if (!body.headers || !Array.isArray(body.headers)) {
      return HttpResponse.json(
        { detail: 'Invalid request: headers must be an array' },
        { status: 400 }
      );
    }

    // Return mock AI analysis
    return HttpResponse.json({
      mappings: mockMappings,
      unmapped_required: [],
      discarded_columns: ['Notes'],
      ai_provider: 'claude',
    });
  }),

  // POST /api/customers/import/validate - Validation with conflicts
  http.post('/api/customers/import/validate', async ({ request }) => {
    const body = await request.json() as {
      company_id: string;
      mappings: Record<string, string>;
      rows: Record<string, string>[];
    };

    // Check for specific test scenarios
    const hasConflict = body.rows.some(row => row.name === 'Existing Company');
    const hasMissingName = body.rows.some(row => !row.name);

    const conflicts: ConflictInfo[] = [];
    const validationErrors: ValidationError[] = [];

    if (hasConflict) {
      conflicts.push({
        row_number: 2,
        csv_name: 'Existing Company',
        conflict_type: 'duplicate_name',
        existing_customer_id: 'existing-customer-uuid',
        existing_value: 'Existing Company',
      });
    }

    if (hasMissingName) {
      validationErrors.push({
        row_number: 4,
        error_type: 'missing_name',
        field: 'name',
      });
    }

    const validRowsCount = body.rows.length - conflicts.length - validationErrors.length;

    return HttpResponse.json({
      has_conflicts: conflicts.length > 0 || validationErrors.length > 0,
      conflicts,
      validation_errors: validationErrors,
      valid_rows_count: validRowsCount,
      conflict_rows_count: conflicts.length,
      error_rows_count: validationErrors.length,
      skipped_rows_count: 0,
    });
  }),

  // POST /api/customers/import/execute - Import execution
  http.post('/api/customers/import/execute', async ({ request }) => {
    const body = await request.json() as {
      company_id: string;
      mappings: Record<string, string>;
      rows: Record<string, string>[];
      skip_conflicts: boolean;
    };

    // Simulate checking for conflicts
    const hasConflicts = body.rows.some(row => row.name === 'Existing Company');

    if (hasConflicts && !body.skip_conflicts) {
      return HttpResponse.json(
        { detail: 'Conflicts detected. Set skip_conflicts=true to import valid rows only.' },
        { status: 400 }
      );
    }

    // Calculate results
    const skippedCount = hasConflicts ? 1 : 0;
    const importedCount = body.rows.length - skippedCount;

    return HttpResponse.json({
      success: true,
      imported_count: importedCount,
      skipped_count: skippedCount,
      errors: [],
    });
  }),
];
