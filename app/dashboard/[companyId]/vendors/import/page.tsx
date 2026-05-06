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
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import EditIcon from '@mui/icons-material/Edit';
import { MappingReviewTable, ConflictDialog } from '@/components/import';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import type { FieldDefinition, ColumnMapping } from '@/components/import';
import { parseCSV } from '@/utils/csvParser';
import { API_BASE_URL } from '@/lib/api';

const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_ROWS_PER_REQUEST = 500;

const steps = [
  'Upload CSV',
  'AI Analysis',
  'Review Mappings',
  'Validate',
  'Confirm Merges',
  'Import',
];

type ImportStep =
  | 'upload'
  | 'analyzing'
  | 'review'
  | 'validating'
  | 'conflicts'
  | 'merges'
  | 'importing'
  | 'complete';

// Iteration 2: contact_name/email/phone moved into vendor_contacts; the CSV
// path captures one primary contact per vendor via the primary_contact_*
// fields below. notes was dropped (free-form dumping ground; will come back
// as a typed column if/when there's a clear use case).
const VENDOR_FIELDS: FieldDefinition[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'primary_contact_name', label: 'Primary Contact Name', required: false },
  { key: 'primary_contact_email', label: 'Primary Contact Email', required: false },
  { key: 'primary_contact_phone', label: 'Primary Contact Phone', required: false },
  { key: 'primary_contact_role', label: 'Primary Contact Role', required: false },
  { key: 'address_line1', label: 'Address Line 1', required: false },
  { key: 'address_line2', label: 'Address Line 2', required: false },
  { key: 'city', label: 'City', required: false },
  { key: 'state', label: 'State', required: false },
  { key: 'postal_code', label: 'Postal Code', required: false },
  { key: 'country', label: 'Country', required: false },
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
  conflict_type: 'duplicate_name' | 'csv_duplicate';
  existing_vendor_id: string;
  existing_value: string;
}

interface ValidationError {
  row_number: number;
  error_type: string;
  field: string;
  message: string;
}

interface MergeProposal {
  from_name: string;
  to_name: string;
  from_csv_rows: number[];
  confidence: number;
}

interface ValidateResponse {
  has_conflicts: boolean;
  conflicts: ConflictInfo[];
  validation_errors: ValidationError[];
  proposed_merges: MergeProposal[];
  valid_rows_count: number;
  conflict_rows_count: number;
  error_rows_count: number;
  skipped_rows_count: number;
}

interface ImportError {
  row_number: number;
  reason: string;
  data: Record<string, string>;
}

interface ExecuteResponse {
  success: boolean;
  imported_count: number;
  updated_count: number;
  merged_count: number;
  skipped_count: number;
  errors: ImportError[];
}

/**
 * Per-proposal user decision. Default 'pending' so the user must consciously
 * accept or reject each one — this is the whole point of the merge step:
 * post-import is the only moment the user can recognize the source rows fresh
 * enough to spot a wrong merge.
 *
 * - 'pending': not yet decided. Cannot proceed to import while any are pending.
 * - 'confirm': fold from_name into to_name (or edited_to_name when set).
 * - 'reject':  keep both vendors as separate rows.
 */
type MergeDecision = 'pending' | 'confirm' | 'reject';

interface MergeDecisionState {
  decision: MergeDecision;
  edited_to_name: string; // editable canonical name (defaults to proposal.to_name)
}

export default function ImportVendorsPage() {
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
  const [proposedMerges, setProposedMerges] = useState<MergeProposal[]>([]);
  const [mergeDecisions, setMergeDecisions] = useState<MergeDecisionState[]>([]);
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
      case 'merges':
        return 4;
      case 'importing':
      case 'complete':
        return 5;
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
            `${API_BASE_URL}/api/vendors/import/analyze`,
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
          const optionalFields = VENDOR_FIELDS.filter((f) => !f.required).map((f) => f.key);
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

    const optionalFields = VENDOR_FIELDS.filter((f) => !f.required).map((f) => f.key);
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

      const response = await fetch(`${API_BASE_URL}/api/vendors/import/validate`, {
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

      // Conflicts (DB / CSV duplicates) and validation errors block first.
      // Once those are dismissed, the merge step runs over what's left.
      if (data.has_conflicts || data.validation_errors.length > 0) {
        setConflicts(data.conflicts);
        setValidationErrors(data.validation_errors);
        setValidRowsCount(data.valid_rows_count);
        setProposedMerges(data.proposed_merges);
        setCurrentStep('conflicts');
        setShowConflictDialog(true);
      } else if (data.proposed_merges.length > 0) {
        // No blocking conflicts, but we have merge proposals — go to merge step.
        setProposedMerges(data.proposed_merges);
        setMergeDecisions(
          data.proposed_merges.map((p) => ({
            decision: 'pending',
            edited_to_name: p.to_name,
          })),
        );
        setCurrentStep('merges');
      } else {
        // No conflicts, no proposed merges — go straight to import.
        await executeImport(false, []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      setCurrentStep('review');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Called after the conflicts dialog is resolved — user chose to skip the
   * conflicting rows and continue. If merges were proposed, we go to the
   * merge step; otherwise execute directly.
   */
  const handleProceedFromConflicts = () => {
    setShowConflictDialog(false);
    if (proposedMerges.length > 0) {
      setMergeDecisions(
        proposedMerges.map((p) => ({
          decision: 'pending',
          edited_to_name: p.to_name,
        })),
      );
      setCurrentStep('merges');
    } else {
      executeImport(true, []);
    }
  };

  const handleMergeDecisionChange = (
    index: number,
    decision: MergeDecision,
  ) => {
    setMergeDecisions((prev) =>
      prev.map((d, i) => (i === index ? { ...d, decision } : d)),
    );
  };

  const handleEditedNameChange = (index: number, newName: string) => {
    setMergeDecisions((prev) =>
      prev.map((d, i) => (i === index ? { ...d, edited_to_name: newName } : d)),
    );
  };

  const pendingMerges = mergeDecisions.filter((d) => d.decision === 'pending').length;
  const confirmedMerges = mergeDecisions.filter((d) => d.decision === 'confirm').length;
  const rejectedMerges = mergeDecisions.filter((d) => d.decision === 'reject').length;

  const handleConfirmAllRemaining = () => {
    setMergeDecisions((prev) =>
      prev.map((d) => (d.decision === 'pending' ? { ...d, decision: 'confirm' } : d)),
    );
  };

  const handleRejectAllRemaining = () => {
    setMergeDecisions((prev) =>
      prev.map((d) => (d.decision === 'pending' ? { ...d, decision: 'reject' } : d)),
    );
  };

  const handleProceedFromMerges = async () => {
    if (pendingMerges > 0) return; // button is disabled but defense in depth.

    // Build the confirmed_merges payload — only confirmed proposals are sent;
    // rejected ones simply don't appear, which the backend treats as "import
    // both as separate vendors."
    const confirmed = mergeDecisions
      .map((d, i) => {
        if (d.decision !== 'confirm') return null;
        const proposal = proposedMerges[i];
        const toName = d.edited_to_name.trim() || proposal.to_name;
        return { from_name: proposal.from_name, to_name: toName };
      })
      .filter((m): m is { from_name: string; to_name: string } => m !== null);

    // Reaching the merges step from the conflicts dialog means we already
    // chose to skip-conflict; otherwise no conflicts existed. Either way,
    // skip_conflicts=true is safe — there's nothing left to skip if the list
    // was empty to start with.
    await executeImport(true, confirmed);
  };

  const executeImport = async (
    skipConflicts: boolean,
    confirmedMergesPayload: Array<{ from_name: string; to_name: string }>,
  ) => {
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
      let totalMerged = 0;
      let totalSkipped = 0;
      const allErrors: ImportError[] = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const response = await fetch(`${API_BASE_URL}/api/vendors/import/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: companyId,
            mappings: mappingsObj,
            rows: batch,
            skip_conflicts: skipConflicts,
            confirmed_merges: confirmedMergesPayload,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `Import failed on batch ${batchIndex + 1}`);
        }

        const data: ExecuteResponse = await response.json();
        totalImported += data.imported_count;
        totalUpdated += data.updated_count || 0;
        totalMerged += data.merged_count || 0;
        totalSkipped += data.skipped_count;
        if (data.errors) {
          allErrors.push(...data.errors);
        }
      }

      setImportResult({
        success: true,
        imported_count: totalImported,
        updated_count: totalUpdated,
        merged_count: totalMerged,
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
    setProposedMerges([]);
    setMergeDecisions([]);
    setImportResult(null);
    setError(null);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/vendors`)}
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
        {currentStep === 'merges' && (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button variant="outlined" color="primary" onClick={handleReset}>
              Start Over
            </Button>
            <Button
              variant="contained"
              onClick={handleProceedFromMerges}
              disabled={loading || pendingMerges > 0}
            >
              {pendingMerges > 0
                ? `${pendingMerges} pending decision${pendingMerges === 1 ? '' : 's'}`
                : `Import (${confirmedMerges} merge${confirmedMerges === 1 ? '' : 's'} confirmed)`}
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
              Select a CSV file with vendor data. The first row should contain column headers.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              You&rsquo;ll have a chance to merge near-duplicate vendor names (e.g.
              &ldquo;Acme LL&rdquo; → &ldquo;Acme LLC&rdquo;) before the rows are written.
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
        <AIAnalysisLoading description="AI is mapping your columns to vendor fields..." />
      )}

      {currentStep === 'review' && (
        <MappingReviewTable
          mappings={mappings}
          fields={VENDOR_FIELDS}
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
              Checking for Conflicts &amp; Merges
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Looking for duplicate names and proposing merges across similar vendor names...
            </Typography>
          </CardContent>
        </Card>
      )}

      {currentStep === 'merges' && (
        <Card elevation={2}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <MergeTypeIcon color="primary" />
              <Typography variant="h6">Confirm Merges</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              We found {proposedMerges.length} pair{proposedMerges.length === 1 ? '' : 's'} of
              vendor names that look like the same vendor. Confirm to merge into the canonical
              name, reject to keep them separate, or edit the canonical name. Rejected proposals
              import as separate vendors.
            </Typography>

            <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }}>
              <Chip
                label={`${pendingMerges} pending`}
                color={pendingMerges > 0 ? 'warning' : 'default'}
                sx={{ fontWeight: 500 }}
              />
              <Chip
                label={`${confirmedMerges} confirmed`}
                color={confirmedMerges > 0 ? 'success' : 'default'}
                sx={{ fontWeight: 500 }}
              />
              <Chip
                label={`${rejectedMerges} rejected`}
                color={rejectedMerges > 0 ? 'default' : 'default'}
                sx={{ fontWeight: 500 }}
              />
              <Box sx={{ flex: 1 }} />
              {pendingMerges > 0 && (
                <>
                  <Button size="small" onClick={handleConfirmAllRemaining}>
                    Confirm All Remaining
                  </Button>
                  <Button size="small" onClick={handleRejectAllRemaining}>
                    Reject All Remaining
                  </Button>
                </>
              )}
            </Stack>

            <Divider sx={{ mb: 2 }} />

            <Stack spacing={2}>
              {proposedMerges.map((proposal, idx) => {
                const decision = mergeDecisions[idx];
                if (!decision) return null;

                const decisionColor =
                  decision.decision === 'confirm'
                    ? 'success.main'
                    : decision.decision === 'reject'
                      ? 'text.disabled'
                      : 'warning.main';

                return (
                  <Card
                    key={`${proposal.from_name}__${proposal.to_name}`}
                    elevation={1}
                    sx={{
                      borderLeft: 4,
                      borderColor: decisionColor,
                      bgcolor: 'background.default',
                    }}
                  >
                    <CardContent sx={{ pb: '16px !important' }}>
                      <Box
                        sx={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 2,
                          alignItems: 'center',
                        }}
                      >
                        <Box sx={{ flex: 1, minWidth: 240 }}>
                          <Typography variant="caption" color="text.secondary">
                            From
                          </Typography>
                          <Typography
                            variant="body1"
                            fontWeight={500}
                            sx={{
                              textDecoration:
                                decision.decision === 'confirm' ? 'line-through' : 'none',
                              color:
                                decision.decision === 'reject'
                                  ? 'text.primary'
                                  : 'text.primary',
                            }}
                          >
                            {proposal.from_name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            CSV row{proposal.from_csv_rows.length === 1 ? '' : 's'}{' '}
                            {proposal.from_csv_rows.join(', ')} · confidence{' '}
                            {Math.round(proposal.confidence * 100)}%
                          </Typography>
                        </Box>

                        <Box sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary' }}>
                          <MergeTypeIcon />
                        </Box>

                        <Box sx={{ flex: 1, minWidth: 240 }}>
                          <Typography variant="caption" color="text.secondary">
                            To (canonical)
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <TextField
                              size="small"
                              fullWidth
                              value={decision.edited_to_name}
                              onChange={(e) =>
                                handleEditedNameChange(idx, e.target.value)
                              }
                              disabled={decision.decision === 'reject'}
                              slotProps={{
                                input: {
                                  startAdornment: <EditIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
                                },
                              }}
                            />
                            {decision.edited_to_name !== proposal.to_name &&
                              decision.decision !== 'reject' && (
                                <Tooltip title="Reset to suggested name">
                                  <IconButton
                                    size="small"
                                    onClick={() =>
                                      handleEditedNameChange(idx, proposal.to_name)
                                    }
                                  >
                                    <ArrowBackIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              )}
                          </Box>
                        </Box>

                        <Box sx={{ minWidth: 220 }}>
                          <ToggleButtonGroup
                            size="small"
                            exclusive
                            value={decision.decision}
                            onChange={(_e, val) => {
                              if (val === null) return;
                              handleMergeDecisionChange(idx, val as MergeDecision);
                            }}
                          >
                            <ToggleButton value="confirm" color="success">
                              Confirm
                            </ToggleButton>
                            <ToggleButton value="reject">Reject</ToggleButton>
                          </ToggleButtonGroup>
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
                );
              })}
            </Stack>
          </CardContent>
        </Card>
      )}

      {currentStep === 'importing' && (
        <Card elevation={2}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <CircularProgress size={64} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Importing Vendors
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
              <Box
                sx={{
                  display: 'flex',
                  gap: 3,
                  justifyContent: 'center',
                  mt: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Box>
                  <Typography variant="h4" color="success.main">
                    {importResult.imported_count}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Imported
                  </Typography>
                </Box>
                {importResult.updated_count > 0 && (
                  <Box>
                    <Typography variant="h4" color="info.main">
                      {importResult.updated_count}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Updated
                    </Typography>
                  </Box>
                )}
                {importResult.merged_count > 0 && (
                  <Box>
                    <Typography variant="h4" color="primary.main">
                      {importResult.merged_count}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Merged
                    </Typography>
                  </Box>
                )}
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
                onClick={() => router.push(`/dashboard/${companyId}/vendors`)}
              >
                View Vendors
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
              const field = VENDOR_FIELDS.find((f) => f.key === fieldKey);
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
        onConfirm={handleProceedFromConflicts}
        entityName="Vendors"
        conflictColumns={[{ key: 'csv_name', label: 'Name' }]}
        getConflictLabel={(conflict) => {
          switch (conflict.conflict_type) {
            case 'csv_duplicate':
              return 'Duplicate Name in CSV';
            case 'duplicate_name':
              return 'Name Exists in Database';
            default:
              return 'Conflict';
          }
        }}
        getErrorMessage={(error) => error.message || `Missing: ${error.field}`}
      />
    </Box>
  );
}
