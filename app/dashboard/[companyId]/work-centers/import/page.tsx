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
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { MappingReviewTable, ConflictDialog } from '@/components/import';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import type { FieldDefinition, ColumnMapping } from '@/components/import';
import { parseCSV } from '@/utils/csvParser';
import { API_BASE_URL } from '@/lib/api';

const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_ROWS_PER_REQUEST = 500;

const steps = ['Upload CSV', 'AI Analysis', 'Review Mappings', 'Validate', 'Import'];

type ImportStep =
  | 'upload'
  | 'analyzing'
  | 'review'
  | 'validating'
  | 'conflicts'
  | 'importing'
  | 'complete';

const WORK_CENTER_FIELDS: FieldDefinition[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'kind', label: 'Kind (internal/external)', required: false },
  { key: 'vendor_name', label: 'Vendor Name', required: false },
  { key: 'labor_rate', label: 'Labor Rate ($/hr)', required: false },
  { key: 'description', label: 'Description', required: false },
  { key: 'legacy_id', label: 'Legacy ID', required: false },
];

interface AnalyzeResponse {
  mappings: ColumnMapping[];
  unmapped_required: string[];
  discarded_columns: string[];
  ai_provider: string;
}

interface ConflictInfo {
  row_number: number;
  csv_name: string | null;
  conflict_type: 'duplicate_name' | 'csv_duplicate' | 'unknown_vendor';
  existing_work_center_id: string;
  existing_value: string;
}

interface ValidationError {
  row_number: number;
  error_type: string;
  field: string;
  message: string;
}

interface ImportError {
  row_number: number;
  reason: string;
  data: Record<string, string>;
}

interface ValidateResponse {
  has_conflicts: boolean;
  conflicts: ConflictInfo[];
  validation_errors: ValidationError[];
  valid_rows_count: number;
  conflict_rows_count: number;
  error_rows_count: number;
  skipped_rows_count: number;
}

interface ExecuteResponse {
  success: boolean;
  imported_count: number;
  updated_count: number;
  skipped_count: number;
  errors: ImportError[];
}

export default function ImportWorkCentersPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [currentStep, setCurrentStep] = useState<ImportStep>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [unmappedRequired, setUnmappedRequired] = useState<string[]>([]);
  const [discardedColumns, setDiscardedColumns] = useState<string[]>([]);
  const [unmappedOptional, setUnmappedOptional] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [validRowsCount, setValidRowsCount] = useState(0);
  const [importResult, setImportResult] = useState<ExecuteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showUnmappedConfirmDialog, setShowUnmappedConfirmDialog] = useState(false);

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
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
        setError(
          `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB (your file is ${fileSizeMB}MB)`,
        );
        return;
      }

      setError(null);
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const text = event.target?.result as string;
          const parsed = parseCSV(text);

          if (parsed.length < 2) {
            setError('CSV file must have a header row and at least one data row');
            return;
          }

          const [headerRow, ...dataRows] = parsed;
          setHeaders(headerRow);
          setAllRows(dataRows);

          setCurrentStep('analyzing');
          setLoading(true);

          const sampleRows = dataRows.slice(0, 5);
          const response = await fetch(
            `${API_BASE_URL}/api/work-centers/import/analyze`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                company_id: companyId,
                headers: headerRow,
                sample_rows: sampleRows,
              }),
            },
          );

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to analyze CSV');
          }

          const data: AnalyzeResponse = await response.json();
          setMappings(data.mappings);
          setUnmappedRequired(data.unmapped_required);
          setDiscardedColumns(data.discarded_columns);

          const mappedFields = new Set(
            data.mappings.filter((m) => m.db_field).map((m) => m.db_field as string),
          );
          const optionalFields = WORK_CENTER_FIELDS.filter((f) => !f.required).map((f) => f.key);
          setUnmappedOptional(optionalFields.filter((f) => !mappedFields.has(f)));

          setCurrentStep('review');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error analyzing CSV');
          setCurrentStep('upload');
        } finally {
          setLoading(false);
        }
      };

      reader.onerror = () => {
        setError('Error reading file');
      };

      reader.readAsText(file);
    },
    [companyId],
  );

  const handleMappingChange = (csvColumn: string, dbField: string | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.csv_column === csvColumn
          ? {
              ...m,
              db_field: dbField,
              is_manual: true,
              reasoning: 'Manually selected by user',
              needs_review: false,
            }
          : m,
      ),
    );

    const mappedFields = new Set(
      mappings
        .map((m) => (m.csv_column === csvColumn ? dbField : m.db_field))
        .filter(Boolean) as string[],
    );

    setUnmappedRequired(['name'].filter((f) => !mappedFields.has(f)));

    const optionalFields = WORK_CENTER_FIELDS.filter((f) => !f.required).map((f) => f.key);
    setUnmappedOptional(optionalFields.filter((f) => !mappedFields.has(f)));

    setDiscardedColumns(
      mappings
        .filter((m) => (m.csv_column === csvColumn ? dbField === null : m.db_field === null))
        .map((m) => m.csv_column),
    );
  };

  const handleContinueToImport = () => {
    if (unmappedOptional.length > 0) {
      setShowUnmappedConfirmDialog(true);
    } else {
      handleValidate();
    }
  };

  const handleValidate = async () => {
    setShowUnmappedConfirmDialog(false);

    const mappedFields = new Set(mappings.filter((m) => m.db_field).map((m) => m.db_field));
    if (!mappedFields.has('name')) {
      setError('Name must be mapped');
      return;
    }

    setCurrentStep('validating');
    setLoading(true);
    setError(null);

    try {
      const mappingsObj: Record<string, string> = {};
      mappings.forEach((m) => {
        if (m.db_field) {
          mappingsObj[m.csv_column] = m.db_field;
        }
      });

      const rowObjects = allRows.slice(0, MAX_ROWS_PER_REQUEST).map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] || '';
        });
        return obj;
      });

      const response = await fetch(`${API_BASE_URL}/api/work-centers/import/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          mappings: mappingsObj,
          rows: rowObjects,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Validation failed');
      }

      const data: ValidateResponse = await response.json();

      if (data.has_conflicts || data.validation_errors.length > 0) {
        setConflicts(data.conflicts);
        setValidationErrors(data.validation_errors);
        setValidRowsCount(data.valid_rows_count);
        setCurrentStep('conflicts');
        setShowConflictDialog(true);
      } else {
        await executeImport(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async (skipConflicts: boolean) => {
    setCurrentStep('importing');
    setLoading(true);
    setError(null);
    setShowConflictDialog(false);

    try {
      const mappingsObj: Record<string, string> = {};
      mappings.forEach((m) => {
        if (m.db_field) {
          mappingsObj[m.csv_column] = m.db_field;
        }
      });

      const allRowObjects = allRows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] || '';
        });
        return obj;
      });

      const batches: Record<string, string>[][] = [];
      for (let i = 0; i < allRowObjects.length; i += MAX_ROWS_PER_REQUEST) {
        batches.push(allRowObjects.slice(i, i + MAX_ROWS_PER_REQUEST));
      }

      let totalImported = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;
      const allErrors: ImportError[] = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const response = await fetch(`${API_BASE_URL}/api/work-centers/import/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            mappings: mappingsObj,
            rows: batch,
            skip_conflicts: skipConflicts,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `Import failed on batch ${batchIndex + 1}`);
        }

        const data: ExecuteResponse = await response.json();
        totalImported += data.imported_count;
        totalUpdated += data.updated_count || 0;
        totalSkipped += data.skipped_count;
        if (data.errors) {
          allErrors.push(...data.errors);
        }
      }

      setImportResult({
        success: true,
        imported_count: totalImported,
        updated_count: totalUpdated,
        skipped_count: totalSkipped,
        errors: allErrors,
      });
      setCurrentStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setCurrentStep('upload');
    setHeaders([]);
    setAllRows([]);
    setMappings([]);
    setUnmappedRequired([]);
    setUnmappedOptional([]);
    setDiscardedColumns([]);
    setConflicts([]);
    setValidationErrors([]);
    setValidRowsCount(0);
    setImportResult(null);
    setError(null);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/work-centers`)}
          sx={{ color: 'text.secondary' }}
        >
          Back
        </Button>
        {currentStep === 'review' && (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button variant="outlined" color="primary" onClick={handleReset}>
              Start Over
            </Button>
            <Button
              variant="contained"
              onClick={handleContinueToImport}
              disabled={loading || unmappedRequired.length > 0}
            >
              Continue to Import ({allRows.length} rows)
            </Button>
          </Box>
        )}
      </Box>

      <Stepper activeStep={getActiveStepIndex()} sx={{ mb: 4 }}>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {currentStep === 'upload' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <UploadFileIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Upload CSV File
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select a CSV file with work center data. The first row should contain column headers.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              External work centers must reference vendors that already exist — import vendors
              first.
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                mb: 3,
              }}
            >
              <AutoAwesomeIcon sx={{ color: 'primary.main', fontSize: 20 }} />
              <Typography variant="body2" color="primary.main">
                AI will automatically map your columns
              </Typography>
            </Box>
            <Button variant="contained" component="label">
              Choose File
              <input type="file" accept=".csv" hidden onChange={handleFileChange} />
            </Button>
          </CardContent>
        </Card>
      )}

      {currentStep === 'analyzing' && (
        <AIAnalysisLoading description="AI is mapping your columns to work center fields..." />
      )}

      {currentStep === 'review' && (
        <MappingReviewTable
          mappings={mappings}
          fields={WORK_CENTER_FIELDS}
          onMappingChange={handleMappingChange}
          unmappedRequired={unmappedRequired}
          unmappedOptional={unmappedOptional}
          discardedColumns={discardedColumns}
        />
      )}

      {currentStep === 'validating' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={64} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Checking for Conflicts
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Verifying data against existing work centers and vendors...
            </Typography>
          </CardContent>
        </Card>
      )}

      {currentStep === 'importing' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={64} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Importing Work Centers
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Please wait while we import your data...
            </Typography>
          </CardContent>
        </Card>
      )}

      {currentStep === 'complete' && importResult && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4 }}>
            <Box sx={{ textAlign: 'center', mb: 4 }}>
              {importResult.imported_count > 0 ? (
                <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
              ) : (
                <ErrorIcon sx={{ fontSize: 64, color: 'error.main', mb: 2 }} />
              )}
              <Typography variant="h5" gutterBottom>
                Import Complete
              </Typography>
              <Box sx={{ display: 'flex', gap: 3, justifyContent: 'center', mt: 2 }}>
                <Box>
                  <Typography variant="h4" color="success.main">
                    {importResult.imported_count}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Imported
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="h4" color="warning.main">
                    {importResult.skipped_count}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Skipped
                  </Typography>
                </Box>
              </Box>
            </Box>

            {importResult.errors.length > 0 && (
              <Alert severity="warning" sx={{ mb: 3 }}>
                {importResult.errors.length} row{importResult.errors.length > 1 ? 's' : ''} had
                errors
              </Alert>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
              <Button variant="outlined" onClick={handleReset}>
                Import Another File
              </Button>
              <Button
                variant="contained"
                onClick={() => router.push(`/dashboard/${companyId}/work-centers`)}
              >
                View Work Centers
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={showUnmappedConfirmDialog}
        onClose={() => setShowUnmappedConfirmDialog(false)}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberIcon color="info" />
          Some Fields Not Mapped
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ mb: 2 }}>
            The following optional database fields are not mapped and will be left empty:
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
            {unmappedOptional.map((fieldKey) => {
              const field = WORK_CENTER_FIELDS.find((f) => f.key === fieldKey);
              return (
                <Box
                  key={fieldKey}
                  sx={{
                    px: 1.5,
                    py: 0.5,
                    bgcolor: 'info.main',
                    color: 'info.contrastText',
                    borderRadius: 1,
                    fontSize: '0.875rem',
                  }}
                >
                  {field?.label || fieldKey}
                </Box>
              );
            })}
          </Box>
          <Typography variant="body2" color="text.secondary">
            You can go back to map more columns, or proceed with the import.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowUnmappedConfirmDialog(false)} color="inherit">
            Go Back
          </Button>
          <Button onClick={handleValidate} variant="contained" color="primary">
            Proceed Anyway
          </Button>
        </DialogActions>
      </Dialog>

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
        onConfirm={() => executeImport(true)}
        entityName="Work Centers"
        conflictColumns={[{ key: 'csv_name', label: 'Name' }]}
        getConflictLabel={(conflict) => {
          switch (conflict.conflict_type) {
            case 'csv_duplicate':
              return 'Duplicate Name in CSV';
            case 'duplicate_name':
              return 'Name Exists in Database';
            case 'unknown_vendor':
              return 'Unknown Vendor';
            default:
              return 'Conflict';
          }
        }}
        getErrorMessage={(error) => error.message || `Missing: ${error.field}`}
      />
    </Box>
  );
}
