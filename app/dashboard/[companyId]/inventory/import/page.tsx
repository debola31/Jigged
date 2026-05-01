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
import ErrorIcon from '@mui/icons-material/Error';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { MappingReviewTable } from '@/components/import';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import type { FieldDefinition, ColumnMapping } from '@/components/import';
import { parseCSV } from '@/utils/csvParser';
import { API_BASE_URL } from '@/lib/api';

// Maximum file size: 10MB
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Maximum rows per request
const MAX_ROWS_PER_REQUEST = 500;

const steps = ['Upload CSV', 'AI Analysis', 'Review Mappings', 'Validate', 'Import'];

type ImportStep = 'upload' | 'analyzing' | 'review' | 'validating' | 'conflicts' | 'importing' | 'complete';

// Inventory field definitions for mapping
const INVENTORY_FIELDS: FieldDefinition[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'description', label: 'Description', required: false },
  { key: 'primary_unit', label: 'Primary Unit', required: true },
  { key: 'quantity', label: 'Quantity', required: false },
  { key: 'cost_per_unit', label: 'Cost per Unit', required: false },
];

interface InventoryConflictInfo {
  row_number: number;
  csv_name: string | null;
  conflict_type: string;
  existing_item_id: string;
  existing_value: string;
}

interface InventoryValidationError {
  row_number: number;
  error_type: string;
  field: string;
  message: string;
}

interface InventoryExecuteResponse {
  success: boolean;
  imported_count: number;
  skipped_count: number;
  errors: { row_number: number; reason: string; data: Record<string, string> }[];
}

export default function ImportInventoryPage() {
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

  const [conflicts, setConflicts] = useState<InventoryConflictInfo[]>([]);
  const [validationErrors, setValidationErrors] = useState<InventoryValidationError[]>([]);
  const [validRowsCount, setValidRowsCount] = useState(0);
  const [importResult, setImportResult] = useState<InventoryExecuteResponse | null>(null);
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

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
      setError(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB (your file is ${fileSizeMB}MB)`);
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

        // Start AI analysis
        setCurrentStep('analyzing');
        setLoading(true);

        const sampleRows = dataRows.slice(0, 5);
        const response = await fetch(`${API_BASE_URL}/api/inventory/import/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            headers: headerRow,
            sample_rows: sampleRows,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || 'Failed to analyze CSV');
        }

        const data = await response.json();

        setMappings(data.mappings);
        setUnmappedRequired(data.unmapped_required);
        setDiscardedColumns(data.discarded_columns);

        // Calculate unmapped optional fields
        const mappedDbFields = new Set(data.mappings.filter((m: ColumnMapping) => m.db_field).map((m: ColumnMapping) => m.db_field));
        const optionalFields = INVENTORY_FIELDS.filter((f) => !f.required && !mappedDbFields.has(f.key));
        setUnmappedOptional(optionalFields.map((f) => f.key));

        setCurrentStep('review');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error analyzing file');
        setCurrentStep('upload');
      } finally {
        setLoading(false);
      }
    };

    reader.onerror = () => {
      setError('Error reading file');
    };

    reader.readAsText(file);
  }, [companyId]);

  const handleMappingChange = (csvColumn: string, dbField: string | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.csv_column === csvColumn
          ? { ...m, db_field: dbField, needs_review: false }
          : m
      )
    );

    // Recalculate unmapped fields
    const newMappings = mappings.map((m) =>
      m.csv_column === csvColumn ? { ...m, db_field: dbField } : m
    );
    const mappedDbFields = new Set(newMappings.filter((m) => m.db_field).map((m) => m.db_field));

    const requiredFields = INVENTORY_FIELDS.filter((f) => f.required && !mappedDbFields.has(f.key));
    setUnmappedRequired(requiredFields.map((f) => f.key));

    const optionalFields = INVENTORY_FIELDS.filter((f) => !f.required && !mappedDbFields.has(f.key));
    setUnmappedOptional(optionalFields.map((f) => f.key));
  };

  const handleProceedToValidation = async () => {
    if (unmappedRequired.length > 0) {
      setError(`Required fields not mapped: ${unmappedRequired.join(', ')}`);
      return;
    }

    setCurrentStep('validating');
    setLoading(true);
    setError(null);

    try {
      // Build mapping dict
      const mappingDict: Record<string, string> = {};
      mappings.forEach((m) => {
        if (m.db_field) {
          mappingDict[m.csv_column] = m.db_field;
        }
      });

      // Convert rows to objects
      const rowObjects = allRows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((header, idx) => {
          obj[header] = row[idx] || '';
        });
        return obj;
      });

      const response = await fetch(`${API_BASE_URL}/api/inventory/import/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          mappings: mappingDict,
          rows: rowObjects,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Validation failed');
      }

      const data = await response.json();

      setConflicts(data.conflicts);
      setValidationErrors(data.validation_errors);
      setValidRowsCount(data.valid_rows_count);

      if (data.has_conflicts || data.validation_errors.length > 0) {
        setCurrentStep('conflicts');
      } else {
        // No conflicts, proceed to import
        await executeImport(mappingDict, rowObjects, false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  const executeImport = async (
    mappingDict: Record<string, string>,
    rowObjects: Record<string, string>[],
    skipConflicts: boolean
  ) => {
    setCurrentStep('importing');
    setLoading(true);
    setError(null);

    try {
      // Batch import for large files
      let totalImported = 0;
      let totalSkipped = 0;

      for (let i = 0; i < rowObjects.length; i += MAX_ROWS_PER_REQUEST) {
        const batch = rowObjects.slice(i, i + MAX_ROWS_PER_REQUEST);

        const response = await fetch(`${API_BASE_URL}/api/inventory/import/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            mappings: mappingDict,
            rows: batch,
            skip_conflicts: skipConflicts,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || 'Import failed');
        }

        const data = await response.json();
        totalImported += data.imported_count;
        totalSkipped += data.skipped_count;
      }

      setImportResult({
        success: true,
        imported_count: totalImported,
        skipped_count: totalSkipped,
        errors: [],
      });
      setCurrentStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setCurrentStep('conflicts');
    } finally {
      setLoading(false);
    }
  };

  const handleImportWithSkip = async () => {
    setShowConflictDialog(false);

    const mappingDict: Record<string, string> = {};
    mappings.forEach((m) => {
      if (m.db_field) {
        mappingDict[m.csv_column] = m.db_field;
      }
    });

    const rowObjects = allRows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((header, idx) => {
        obj[header] = row[idx] || '';
      });
      return obj;
    });

    await executeImport(mappingDict, rowObjects, true);
  };

  const handleReset = () => {
    setCurrentStep('upload');
    setHeaders([]);
    setAllRows([]);
    setMappings([]);
    setUnmappedRequired([]);
    setDiscardedColumns([]);
    setUnmappedOptional([]);
    setConflicts([]);
    setValidationErrors([]);
    setValidRowsCount(0);
    setImportResult(null);
    setError(null);
  };

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 3 }}
      >
        Back to Inventory
      </Button>

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

      {/* Step 1: Upload */}
      {currentStep === 'upload' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <UploadFileIcon sx={{ fontSize: 64, color: 'primary.main', mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Upload Inventory CSV
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              Select a CSV file with your inventory data. Required columns: Name, Primary Unit.
            </Typography>
            <Button variant="contained" component="label" size="large">
              Select CSV File
              <input type="file" accept=".csv" hidden onChange={handleFileChange} />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Analyzing */}
      {currentStep === 'analyzing' && (
        <AIAnalysisLoading description="AI is mapping your columns to inventory fields..." />
      )}

      {/* Step 3: Review Mappings */}
      {currentStep === 'review' && (
        <Card elevation={2}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 3 }}>
              Review Column Mappings
            </Typography>

            {unmappedRequired.length > 0 && (
              <Alert severity="error" sx={{ mb: 3 }}>
                Required fields not mapped: {unmappedRequired.join(', ')}
              </Alert>
            )}

            <MappingReviewTable
              mappings={mappings}
              fields={INVENTORY_FIELDS}
              unmappedRequired={unmappedRequired}
              unmappedOptional={unmappedOptional}
              discardedColumns={discardedColumns}
              onMappingChange={handleMappingChange}
            />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3, gap: 2 }}>
              <Button variant="outlined" onClick={handleReset}>
                Start Over
              </Button>
              <Button
                variant="contained"
                onClick={handleProceedToValidation}
                disabled={unmappedRequired.length > 0}
                endIcon={<ArrowForwardIcon />}
              >
                Validate & Import
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Step 4: Validating */}
      {currentStep === 'validating' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={40} sx={{ mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Validating Data
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Checking for conflicts and validation errors...
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Step 4b: Conflicts */}
      {currentStep === 'conflicts' && (
        <Card elevation={2}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
              <WarningAmberIcon color="warning" sx={{ fontSize: 32 }} />
              <Typography variant="h6">
                Validation Results
              </Typography>
            </Box>

            <Box sx={{ mb: 3 }}>
              <Typography variant="body1" sx={{ mb: 2 }}>
                <strong>{validRowsCount}</strong> rows ready to import
              </Typography>

              {conflicts.length > 0 && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {conflicts.length} row{conflicts.length > 1 ? 's' : ''} have conflicts (duplicate SKUs)
                </Alert>
              )}

              {validationErrors.length > 0 && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {validationErrors.length} row{validationErrors.length > 1 ? 's' : ''} have validation errors
                </Alert>
              )}
            </Box>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
              <Button variant="outlined" onClick={handleReset}>
                Start Over
              </Button>
              {validRowsCount > 0 && (
                <Button
                  variant="contained"
                  onClick={() => setShowConflictDialog(true)}
                >
                  Import {validRowsCount} Valid Rows
                </Button>
              )}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Step 5: Importing */}
      {currentStep === 'importing' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={40} sx={{ mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Importing Data
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Creating inventory items...
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Step 5b: Complete */}
      {currentStep === 'complete' && importResult && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Import Complete
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
              <strong>{importResult.imported_count}</strong> items imported successfully
            </Typography>
            {importResult.skipped_count > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {importResult.skipped_count} rows skipped
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
              <Button variant="outlined" onClick={handleReset}>
                Import More
              </Button>
              <Button
                variant="contained"
                onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
              >
                View Inventory
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Conflict Confirmation Dialog */}
      <Dialog
        open={showConflictDialog}
        onClose={() => setShowConflictDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Import with Skipped Rows?</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ mb: 2 }}>
            <strong>{validRowsCount}</strong> row{validRowsCount !== 1 ? 's' : ''} will be imported.
          </Typography>
          {conflicts.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {conflicts.length} row{conflicts.length !== 1 ? 's' : ''} with conflicts will be skipped.
            </Alert>
          )}
          {validationErrors.length > 0 && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {validationErrors.length} row{validationErrors.length !== 1 ? 's' : ''} with validation errors will be skipped.
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            Do you want to proceed with importing the valid rows?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowConflictDialog(false)}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleImportWithSkip}>
            Import {validRowsCount} Rows
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
