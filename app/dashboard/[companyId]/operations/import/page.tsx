'use client';

import { useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { MappingReviewTable, ConflictDialog } from '@/components/import';
import type { ColumnMapping, FieldDefinition } from '@/components/import';
import { parseCSV } from '@/utils/csvParser';
import { API_BASE_URL } from '@/lib/api';

// Maximum file size: 10MB
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Maximum rows to send per API request (Vercel has 4.5MB body limit)
const MAX_ROWS_PER_REQUEST = 500;

const steps = ['Upload', 'AI Analysis', 'Review Mappings', 'Validate', 'Import'];

type ImportStep = 'upload' | 'analyzing' | 'review' | 'validating' | 'conflicts' | 'importing' | 'complete';

// Operation fields for mapping
const OPERATION_FIELDS: FieldDefinition[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'labor_rate', label: 'Labor Rate', required: false },
  { key: 'description', label: 'Description', required: false },
  { key: 'legacy_id', label: 'Legacy ID', required: false },
];

interface OperationConflictInfo {
  row_number: number;
  csv_name: string | null;
  conflict_type: string;
  existing_operation_id: string;
  existing_value: string;
}

interface OperationValidationError {
  row_number: number;
  error_type: string;
  field: string;
  message: string;
}

export default function ImportOperationsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  // State
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [unmappedRequired, setUnmappedRequired] = useState<string[]>([]);
  const [discardedColumns, setDiscardedColumns] = useState<string[]>([]);
  const [unmappedOptional, setUnmappedOptional] = useState<string[]>([]);

  // Validation & import
  const [conflicts, setConflicts] = useState<OperationConflictInfo[]>([]);
  const [validationErrors, setValidationErrors] = useState<OperationValidationError[]>([]);
  const [validRowsCount, setValidRowsCount] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const getActiveStepIndex = (): number => {
    switch (currentStep) {
      case 'upload':
        return 0;
      case 'analyzing':
        return 1;
      case 'review':
        return 2;
      case 'validating':
      case 'conflicts':
        return 3;
      case 'importing':
      case 'complete':
        return 4;
      default:
        return 0;
    }
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`);
        return;
      }

      setError(null);
      setLoading(true);

      try {
        const text = await file.text();
        const parsed = parseCSV(text);

        if (parsed.length < 2) {
          setError('CSV file must have a header row and at least one data row');
          setLoading(false);
          return;
        }

        const fileHeaders = parsed[0];
        const fileRows = parsed.slice(1);

        setHeaders(fileHeaders);
        setAllRows(fileRows);

        setCurrentStep('analyzing');
        await analyzeCSV(fileHeaders, fileRows.slice(0, 5));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse CSV');
        setLoading(false);
      }
    },
    [companyId]
  );

  const analyzeCSV = async (fileHeaders: string[], sampleRows: string[][]) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/operations/import/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          headers: fileHeaders,
          sample_rows: sampleRows,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to analyze CSV');
      }

      const data = await response.json();

      setMappings(data.mappings || []);
      setUnmappedRequired(data.unmapped_required || []);
      setDiscardedColumns(data.discarded_columns || []);

      const mappedFields = new Set(
        (data.mappings || []).map((m: ColumnMapping) => m.db_field).filter(Boolean)
      );
      const optional = OPERATION_FIELDS.filter((f) => !f.required).map((f) => f.key);
      setUnmappedOptional(optional.filter((f) => !mappedFields.has(f)));

      setCurrentStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze CSV');
      setCurrentStep('upload');
    } finally {
      setLoading(false);
    }
  };

  const handleMappingChange = (csvColumn: string, newDbField: string | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.csv_column === csvColumn
          ? { ...m, db_field: newDbField, is_manual: true, needs_review: false }
          : m
      )
    );

    const mappedFields = new Set(
      mappings
        .filter((m) => m.csv_column !== csvColumn)
        .map((m) => m.db_field)
        .filter(Boolean)
    );
    if (newDbField) mappedFields.add(newDbField);

    const required = OPERATION_FIELDS.filter((f) => f.required).map((f) => f.key);
    const optional = OPERATION_FIELDS.filter((f) => !f.required).map((f) => f.key);
    setUnmappedRequired(required.filter((f) => !mappedFields.has(f)));
    setUnmappedOptional(optional.filter((f) => !mappedFields.has(f)));
  };

  const buildMappingsDict = (): Record<string, string> => {
    const dict: Record<string, string> = {};
    for (const m of mappings) {
      if (m.db_field) {
        dict[m.csv_column] = m.db_field;
      }
    }
    return dict;
  };

  const buildAllRowObjects = (): Record<string, string>[] =>
    allRows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || '';
      });
      return obj;
    });

  const handleProceedToValidation = async () => {
    setCurrentStep('validating');
    setLoading(true);
    setError(null);

    try {
      const mappingsDict = buildMappingsDict();
      const validationRows = buildAllRowObjects().slice(0, MAX_ROWS_PER_REQUEST);

      const response = await fetch(`${API_BASE_URL}/api/operations/import/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          mappings: mappingsDict,
          rows: validationRows,
          total_rows: allRows.length,
        }),
      });

      if (!response.ok) {
        throw new Error('Validation failed');
      }

      const data = await response.json();

      setConflicts(data.conflicts || []);
      setValidationErrors(data.validation_errors || []);
      setValidRowsCount(data.valid_rows_count || 0);

      if (data.has_conflicts || (data.validation_errors?.length ?? 0) > 0) {
        setCurrentStep('conflicts');
        setShowConflictDialog(true);
      } else {
        await executeImport();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async () => {
    setShowConflictDialog(false);
    setCurrentStep('importing');

    try {
      const mappingsDict = buildMappingsDict();
      const allRowObjects = buildAllRowObjects();

      const batches: Record<string, string>[][] = [];
      for (let i = 0; i < allRowObjects.length; i += MAX_ROWS_PER_REQUEST) {
        batches.push(allRowObjects.slice(i, i + MAX_ROWS_PER_REQUEST));
      }

      let totalImported = 0;
      let totalSkipped = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const response = await fetch(`${API_BASE_URL}/api/operations/import/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            mappings: mappingsDict,
            rows: batch,
            skip_conflicts: true,
            batch_offset: batchIndex * MAX_ROWS_PER_REQUEST,
          }),
        });

        if (!response.ok) {
          throw new Error(`Import failed on batch ${batchIndex + 1}`);
        }

        const data = await response.json();
        totalImported += data.imported_count || 0;
        totalSkipped += data.skipped_count || 0;
      }

      setImportedCount(totalImported);
      setSkippedCount(totalSkipped);
      setCurrentStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setCurrentStep('review');
    }
  };

  const handleReset = () => {
    setCurrentStep('upload');
    setMappings([]);
    setHeaders([]);
    setAllRows([]);
    setUnmappedRequired([]);
    setUnmappedOptional([]);
    setDiscardedColumns([]);
    setConflicts([]);
    setValidationErrors([]);
    setValidRowsCount(0);
    setImportedCount(0);
    setSkippedCount(0);
    setError(null);
  };

  const renderContent = () => {
    switch (currentStep) {
      case 'upload':
        return (
          <Card elevation={2}>
            <CardContent sx={{ textAlign: 'center', py: 6 }}>
              <UploadFileIcon sx={{ fontSize: 64, color: 'primary.main', mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Upload Operations CSV
              </Typography>
              <Typography color="text.secondary" mb={3}>
                Select a CSV file containing your operations data
              </Typography>
              <Button variant="contained" component="label" disabled={loading}>
                Choose File
                <input type="file" accept=".csv" hidden onChange={handleFileChange} />
              </Button>
            </CardContent>
          </Card>
        );

      case 'analyzing':
        return (
          <Card elevation={2}>
            <CardContent sx={{ textAlign: 'center', py: 6 }}>
              <AutoAwesomeIcon sx={{ fontSize: 64, color: 'primary.main', mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Analyzing Your CSV
              </Typography>
              <Typography color="text.secondary" mb={3}>
                AI is analyzing your column headers to suggest mappings...
              </Typography>
              <CircularProgress />
            </CardContent>
          </Card>
        );

      case 'review':
        return (
          <Box>
            {unmappedRequired.length > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                Required fields not mapped: {unmappedRequired.join(', ')}
              </Alert>
            )}
            <Card elevation={2} sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Review Column Mappings
                </Typography>
                <MappingReviewTable
                  mappings={mappings}
                  fields={OPERATION_FIELDS}
                  unmappedRequired={unmappedRequired}
                  unmappedOptional={unmappedOptional}
                  discardedColumns={discardedColumns}
                  onMappingChange={handleMappingChange}
                />
              </CardContent>
            </Card>
            <Box display="flex" justifyContent="flex-end" gap={2}>
              <Button variant="outlined" onClick={handleReset}>
                Start Over
              </Button>
              <Button
                variant="contained"
                endIcon={<ArrowForwardIcon />}
                onClick={handleProceedToValidation}
                disabled={unmappedRequired.length > 0 || loading}
              >
                Validate & Import
              </Button>
            </Box>
          </Box>
        );

      case 'validating':
      case 'importing':
        return (
          <Card elevation={2}>
            <CardContent sx={{ textAlign: 'center', py: 6 }}>
              <CircularProgress sx={{ mb: 2 }} />
              <Typography variant="h6">
                {currentStep === 'validating' ? 'Validating data...' : 'Importing operations...'}
              </Typography>
            </CardContent>
          </Card>
        );

      case 'complete':
        return (
          <Card elevation={2}>
            <CardContent sx={{ textAlign: 'center', py: 6 }}>
              <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Import Complete!
              </Typography>
              <Typography color="text.secondary" mb={1}>
                {importedCount} operations imported
              </Typography>
              {skippedCount > 0 && (
                <Typography color="warning.main" mb={1}>
                  {skippedCount} rows skipped (duplicates or errors)
                </Typography>
              )}
              <Box mt={3} display="flex" gap={2} justifyContent="center">
                <Button variant="outlined" onClick={handleReset}>
                  Import Another File
                </Button>
                <Button
                  variant="contained"
                  onClick={() => router.push(`/dashboard/${companyId}/operations`)}
                >
                  View Operations
                </Button>
              </Box>
            </CardContent>
          </Card>
        );

      default:
        return null;
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/operations`)}
          sx={{ color: 'text.secondary' }}
        >
          Back
        </Button>
      </Box>

      <Stepper activeStep={getActiveStepIndex()} sx={{ mb: 4 }}>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {renderContent()}

      <ConflictDialog
        open={showConflictDialog}
        conflicts={conflicts}
        validationErrors={validationErrors}
        validRowsCount={validRowsCount}
        totalRows={allRows.length}
        onCancel={() => {
          setShowConflictDialog(false);
          setCurrentStep('review');
        }}
        onConfirm={() => executeImport()}
        entityName="Operations"
        conflictColumns={[{ key: 'csv_name', label: 'Name' }]}
        getConflictLabel={(conflict) => {
          switch (conflict.conflict_type) {
            case 'csv_duplicate':
              return 'Duplicate Name in CSV';
            case 'duplicate_name':
              return 'Name Exists in Database';
            default:
              return 'Duplicate';
          }
        }}
        getErrorMessage={(error) => `${error.field}: ${error.message}`}
      />
    </Box>
  );
}
