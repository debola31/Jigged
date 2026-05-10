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
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { MappingReviewTable, ConflictDialog } from '@/components/import';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import type { FieldDefinition, ColumnMapping } from '@/components/import';
import type {
  PartAnalyzeResponse,
  PartValidateResponse,
  PartExecuteResponse,
  PartConflictInfo,
  PartValidationError,
  PartImportError,
} from '@/types/parts-import';
import { PART_FIELDS } from '@/types/parts-import';
import { parseCSV } from '@/utils/csvParser';
import { API_BASE_URL } from '@/lib/api';

// Maximum file size: 10MB
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Maximum rows to send per API request (Vercel has 4.5MB body limit)
const MAX_ROWS_PER_REQUEST = 500;

const steps = ['Upload', 'AI Analysis', 'Review Mappings', 'Validate', 'Import'];

type ImportStep =
  | 'upload'
  | 'analyzing'
  | 'review'
  | 'validating'
  | 'conflicts'
  | 'importing'
  | 'complete';

export default function ImportPartsPage() {
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
  const [conflicts, setConflicts] = useState<PartConflictInfo[]>([]);
  const [validationErrors, setValidationErrors] = useState<PartValidationError[]>([]);
  const [validRowsCount, setValidRowsCount] = useState(0);
  const [importResult, setImportResult] = useState<PartExecuteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showUnmappedConfirmDialog, setShowUnmappedConfirmDialog] = useState(false);

  // Temp state for file before analysis
  const [pendingFile, setPendingFile] = useState<{ headers: string[]; rows: string[][] } | null>(
    null,
  );

  // Get active step index for stepper
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

  // Handle file selection (just parses, doesn't start analysis)
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check file size
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
      setError(
        `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB (your file is ${fileSizeMB}MB)`,
      );
      return;
    }

    setError(null);
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = parseCSV(text);

        if (parsed.length < 2) {
          setError('CSV file must have a header row and at least one data row');
          return;
        }

        const [headerRow, ...dataRows] = parsed;
        setPendingFile({ headers: headerRow, rows: dataRows });
      } catch {
        setError('Error reading file');
      }
    };

    reader.onerror = () => {
      setError('Error reading file');
    };

    reader.readAsText(file);
  }, []);

  // Start analysis after file is selected
  const handleStartAnalysis = async () => {
    if (!pendingFile) return;

    setHeaders(pendingFile.headers);
    setAllRows(pendingFile.rows);
    setCurrentStep('analyzing');
    setLoading(true);
    setError(null);

    try {
      const sampleRows = pendingFile.rows.slice(0, 5);
      const response = await fetch(`${API_BASE_URL}/api/parts/import/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          headers: pendingFile.headers,
          sample_rows: sampleRows,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to analyze CSV');
      }

      const data: PartAnalyzeResponse = await response.json();
      setMappings(data.mappings);
      setUnmappedRequired(data.unmapped_required);
      setDiscardedColumns(data.discarded_columns);

      // Calculate unmapped optional fields
      const mappedFields = new Set(
        data.mappings.filter((m) => m.db_field).map((m) => m.db_field),
      );
      const optionalFields = PART_FIELDS.filter((f) => !f.required).map((f) => f.key);
      setUnmappedOptional(optionalFields.filter((f) => !mappedFields.has(f)));

      setCurrentStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error analyzing CSV');
      setCurrentStep('upload');
    } finally {
      setLoading(false);
    }
  };

  // Handle mapping change
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

    // Recalculate unmapped fields
    const mappedFields = new Set(
      mappings
        .map((m) => (m.csv_column === csvColumn ? dbField : m.db_field))
        .filter(Boolean),
    );

    // Update unmapped required
    const requiredFields = PART_FIELDS.filter((f) => f.required).map((f) => f.key);
    setUnmappedRequired(requiredFields.filter((f) => !mappedFields.has(f)));

    // Update unmapped optional
    const optionalFields = PART_FIELDS.filter((f) => !f.required).map((f) => f.key);
    setUnmappedOptional(optionalFields.filter((f) => !mappedFields.has(f)));
  };

  // Check for unmapped fields and show confirmation if needed
  const handleContinueToImport = () => {
    if (unmappedOptional.length > 0) {
      setShowUnmappedConfirmDialog(true);
    } else {
      handleValidate();
    }
  };

  // Validate mappings and check for conflicts
  const handleValidate = async () => {
    setShowUnmappedConfirmDialog(false);

    // Check required fields
    const mappedFields = new Set(mappings.filter((m) => m.db_field).map((m) => m.db_field));
    if (!mappedFields.has('part_name')) {
      setError('Part Name must be mapped');
      return;
    }

    setCurrentStep('validating');
    setLoading(true);
    setError(null);

    try {
      // Build mappings object
      const mappingsObj: Record<string, string> = {};
      mappings.forEach((m) => {
        if (m.db_field) {
          mappingsObj[m.csv_column] = m.db_field;
        }
      });

      // Convert rows to objects (limit for validation to avoid payload size issues)
      const rowObjects = allRows.slice(0, MAX_ROWS_PER_REQUEST).map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] || '';
        });
        return obj;
      });

      const response = await fetch(`${API_BASE_URL}/api/parts/import/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          mappings: mappingsObj,
          rows: rowObjects,
          total_rows: allRows.length,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Validation failed');
      }

      const data: PartValidateResponse = await response.json();

      if (data.has_conflicts || data.validation_errors.length > 0) {
        setConflicts(data.conflicts);
        setValidationErrors(data.validation_errors);
        setValidRowsCount(data.valid_rows_count);
        setCurrentStep('conflicts');
        setShowConflictDialog(true);
      } else {
        // No conflicts, proceed to import
        await executeImport(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  // Execute the import
  const executeImport = async (skipConflicts: boolean) => {
    setCurrentStep('importing');
    setLoading(true);
    setError(null);
    setShowConflictDialog(false);

    try {
      // Build mappings object
      const mappingsObj: Record<string, string> = {};
      mappings.forEach((m) => {
        if (m.db_field) {
          mappingsObj[m.csv_column] = m.db_field;
        }
      });

      // Convert all rows to objects
      const allRowObjects = allRows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] || '';
        });
        return obj;
      });

      // Split into batches to avoid Vercel's 4.5MB payload limit
      const batches: Record<string, string>[][] = [];
      for (let i = 0; i < allRowObjects.length; i += MAX_ROWS_PER_REQUEST) {
        batches.push(allRowObjects.slice(i, i + MAX_ROWS_PER_REQUEST));
      }

      // Execute batches sequentially and aggregate results
      let totalImported = 0;
      let totalSkipped = 0;
      const allErrors: PartImportError[] = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const response = await fetch(`${API_BASE_URL}/api/parts/import/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            mappings: mappingsObj,
            rows: batch,
            skip_conflicts: skipConflicts,
            batch_offset: batchIndex * MAX_ROWS_PER_REQUEST,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `Import failed on batch ${batchIndex + 1}`);
        }

        const data: PartExecuteResponse = await response.json();
        totalImported += data.imported_count;
        totalSkipped += data.skipped_count;
        if (data.errors) {
          allErrors.push(...data.errors);
        }
      }

      // Aggregate final result
      setImportResult({
        success: true,
        imported_count: totalImported,
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

  // Reset and start over
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
    setPendingFile(null);
  };

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts`)}
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

      {/* Stepper */}
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

      {/* Step: Upload */}
      {currentStep === 'upload' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4 }}>
            <Box sx={{ textAlign: 'center', mb: 4 }}>
              <UploadFileIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Upload Parts CSV
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Select a CSV file with part data. The first row should contain column headers.
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
                  AI will automatically map your columns to part fields
                </Typography>
              </Box>
              <Button variant="contained" component="label">
                Choose File
                <input type="file" accept=".csv" hidden onChange={handleFileChange} />
              </Button>
              {pendingFile && (
                <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>
                  {pendingFile.rows.length} rows loaded
                </Typography>
              )}
            </Box>

            {pendingFile && (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 4 }}>
                <Button
                  variant="contained"
                  onClick={handleStartAnalysis}
                  endIcon={<ArrowForwardIcon />}
                >
                  Analyze CSV
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step: Analyzing */}
      {currentStep === 'analyzing' && (
        <AIAnalysisLoading description="AI is mapping your columns to part fields..." />
      )}

      {/* Step: Review Mappings */}
      {currentStep === 'review' && (
        <MappingReviewTable
          mappings={mappings}
          fields={PART_FIELDS as FieldDefinition[]}
          unmappedRequired={unmappedRequired}
          unmappedOptional={unmappedOptional}
          discardedColumns={discardedColumns}
          onMappingChange={handleMappingChange}
        />
      )}

      {/* Step: Validating */}
      {currentStep === 'validating' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={64} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Checking for Conflicts
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Verifying data against existing parts...
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Step: Importing */}
      {currentStep === 'importing' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={64} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Importing Parts
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Please wait while we import your data...
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Step: Complete */}
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

            {importResult.imported_count > 0 && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ textAlign: 'center', mb: 3 }}
              >
                Stocked items also appear in Inventory.
              </Typography>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
              <Button variant="outlined" onClick={handleReset}>
                Import Another File
              </Button>
              <Button
                variant="contained"
                onClick={() => router.push(`/dashboard/${companyId}/parts`)}
              >
                View Parts
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Unmapped Fields Confirmation Dialog */}
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
            The following optional fields are not mapped and will be left empty:
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
            {unmappedOptional.map((fieldKey) => {
              const field = PART_FIELDS.find((f) => f.key === fieldKey);
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

      {/* Conflict Dialog */}
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
        entityName="Parts"
        conflictColumns={[{ key: 'csv_part_name', label: 'Part Name' }]}
        getConflictLabel={(conflict) => {
          switch (conflict.conflict_type) {
            case 'duplicate_part_name':
              return 'Duplicate Part Name';
            case 'csv_duplicate':
              return 'Duplicate in CSV';
            default:
              return 'Conflict';
          }
        }}
        getErrorMessage={(error) => error.message}
      />
    </Box>
  );
}
