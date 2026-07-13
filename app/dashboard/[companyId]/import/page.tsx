'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import MultiFileDropzone from '@/components/data-import/MultiFileDropzone';
import ColumnMappingStep from '@/components/data-import/ColumnMappingStep';
import ImportReviewView from '@/components/data-import/ImportReviewView';
import EditableDataGrid from '@/components/data-import/EditableDataGrid';
import FixToolbar from '@/components/data-import/FixToolbar';
import MergeVariantsDialog from '@/components/data-import/MergeVariantsDialog';
import SuggestFixesPanel from '@/components/data-import/SuggestFixesPanel';
import { analyzeBundle } from '@/lib/dataImportAnalyzer';
import { summarize } from '@/lib/dataImportReview';
import {
  applyOp,
  buildWorkingFiles,
  invertOp,
  setWorkingEntity,
  setWorkingRole,
  workingToAnalyzed,
  workingToClassification,
  type EditOp,
  type WorkingFile,
} from '@/lib/dataImportEditing';
import { bulkReplace, fillBlanks, mergeVariants } from '@/lib/dataImportActions';
import { ENTITY_IDENTITY_FIELD } from '@/lib/dataImportSchema';
import {
  buildImportPlan,
  runImportPlan,
  type ExecuteResponseShape,
  type ImportSummary,
} from '@/lib/dataImportIngest';
import {
  reconcile,
  filterWorkingByMode,
  type ExistingIdentities,
  type ImportMode,
} from '@/lib/dataImportReconcile';
import { fetchExistingIdentities } from '@/lib/dataImportExisting';
import { API_BASE_URL } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import type {
  EntityType,
  Finding,
  FixSuggestion,
  ImportReview,
  NarrativeResponse,
  StructureResponse,
  SuggestFixesResponse,
  UploadedFilePayload,
} from '@/types/data-import';

const STEPS = ["What you'll need", 'Upload your files', 'Check your files', 'Review', 'Import'];
const SAMPLE_ROWS = 20;

const WHAT_TO_EXPORT = [
  { name: 'Parts & inventory', hint: 'part numbers, descriptions, costs, on-hand qty' },
  { name: 'Vendors', hint: 'suppliers and outside processors' },
  { name: 'Work centers', hint: 'machines and outside operations' },
  { name: 'Routings', hint: 'the operation steps for each part' },
  { name: 'Bills of material', hint: 'which parts go into which assemblies' },
  { name: 'Customers', hint: 'optional, if you have them' },
];

/** Compose the review from structure + freshly-computed findings + the (stable) AI narrative. */
function composeReport(
  structure: StructureResponse,
  deterministic: Finding[],
  narrative: NarrativeResponse | null,
  generatedAt: string,
): ImportReview {
  const gotchas: Finding[] = (narrative?.gotchas ?? []).map((g, i) => ({
    id: `gotcha.${i}`,
    category: 'erp_gotcha',
    severity: 'info',
    entity_type: 'unknown',
    title: g.title || 'Worth verifying',
    detail: g.detail || '',
    count: 0,
    examples: [],
    source_files: [],
    verified: false,
    recommended_action: g.recommended_action || '',
  }));
  return {
    schema_version: 1,
    erp_detection: structure.erp_detection,
    files: structure.files,
    findings: [...deterministic, ...gotchas],
    summary: narrative?.narrative_available ? narrative.summary : '',
    recommendations: narrative?.recommendations ?? [],
    narrative_available: narrative?.narrative_available ?? false,
    ai_provider: narrative?.ai_provider ?? '',
    ai_model: narrative?.ai_model ?? '',
    generated_at: generatedAt,
  };
}

export default function ImportDataPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  const [activeStep, setActiveStep] = useState(0);
  const [files, setFiles] = useState<UploadedFilePayload[]>([]);
  const [report, setReport] = useState<ImportReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Working dataset threaded through Map → Review: editable entity + column mapping, then
  // editable rows. Edits re-run the analyzer client-side (no server round-trip), so the
  // review updates live. The AI narrative is computed once (on Map confirm) and reused.
  const [structure, setStructure] = useState<StructureResponse | null>(null);
  const [narrative, setNarrative] = useState<NarrativeResponse | null>(null);
  const [working, setWorking] = useState<WorkingFile[]>([]);
  const [journal, setJournal] = useState<EditOp[]>([]);
  const [redoStack, setRedoStack] = useState<EditOp[]>([]);
  const [gridIndex, setGridIndex] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [suggestions, setSuggestions] = useState<FixSuggestion[] | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestAvailable, setSuggestAvailable] = useState(true);
  const [existing, setExisting] = useState<ExistingIdentities | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('both');

  async function authToken(): Promise<string> {
    const supabase = getSupabase();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Your session has expired. Please sign in again.');
    return session.access_token;
  }

  async function postJson<T>(path: string, body: unknown, token: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `Analysis failed (${res.status})`;
      try {
        const b = await res.json();
        if (b?.detail && typeof b.detail === 'string') detail = b.detail;
      } catch {
        /* keep default */
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  }

  // Upload → Map: classify each file + map its columns (AI structure pass), then let the
  // owner confirm/correct on the Map step BEFORE anything is analyzed.
  async function runStructure() {
    setError(null);
    setBusy(true);
    try {
      const token = await authToken();
      const result = await postJson<StructureResponse>(
        '/api/data-import/structure',
        {
          company_id: companyId,
          files: files.map((f) => ({
            filename: f.filename,
            headers: f.headers,
            row_count: f.rows.length,
            sample_rows: f.rows.slice(0, SAMPLE_ROWS).map((r) => f.headers.map((h) => r[h] ?? '')),
          })),
        },
        token,
      );
      setStructure(result);
      setWorking(buildWorkingFiles(files, result.files));
      setActiveStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  // Map → Review: run the deterministic analyzer on the CONFIRMED mapping, then the grounded
  // AI narrative once. The confirmed classification replaces the AI's guess in the review.
  async function confirmMapping() {
    if (!structure) return;
    setError(null);
    setBusy(true);
    try {
      const token = await authToken();
      const findings = analyzeBundle(workingToAnalyzed(working));
      const narrativeResult = await postJson<NarrativeResponse>(
        '/api/data-import/narrative',
        {
          company_id: companyId,
          erp_detection: structure.erp_detection,
          findings: findings.map((f) => ({
            id: f.id,
            category: f.category,
            severity: f.severity,
            title: f.title,
            detail: f.detail,
            count: f.count,
            examples: f.examples.slice(0, 3),
          })),
          file_summaries: working.map((wf) => ({
            filename: wf.filename,
            entity_type: wf.entityType,
            row_count: wf.rows.length,
          })),
        },
        token,
      );
      const confirmed: StructureResponse = {
        erp_detection: structure.erp_detection,
        files: workingToClassification(working),
      };
      setStructure(confirmed);
      setNarrative(narrativeResult);
      setJournal([]);
      setRedoStack([]);
      setGridIndex(0);
      setReport(composeReport(confirmed, findings, narrativeResult, new Date().toISOString()));
      setActiveStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function handleEntityChange(fileIndex: number, entityType: EntityType) {
    setWorking((w) => setWorkingEntity(w, fileIndex, entityType));
  }

  function handleRoleChange(fileIndex: number, field: string, rawHeader: string) {
    setWorking((w) => setWorkingRole(w, fileIndex, field, rawHeader));
  }

  // Re-run the deterministic analyzer over the edited working set and refresh the review.
  function recompute(next: WorkingFile[]) {
    if (!structure) return;
    const findings = analyzeBundle(workingToAnalyzed(next));
    setReport((prev) =>
      composeReport(structure, findings, narrative, prev?.generated_at ?? new Date().toISOString()),
    );
  }

  // Apply one remediation op (a single cell edit or a bulk batch): it lands on the undo
  // journal as one unit and re-runs the analyzer. This is the single path the grid, the
  // bulk toolbar, and the merge dialog all go through.
  function applyRemediation(op: EditOp) {
    if (op.edits.length === 0) return;
    const next = applyOp(working, op);
    setWorking(next);
    setJournal((j) => [...j, op]);
    setRedoStack([]);
    recompute(next);
  }

  function handleCellEdit(
    fileIndex: number,
    rowId: string,
    colId: string,
    oldValue: string,
    newValue: string,
  ) {
    applyRemediation({ label: `Edit ${colId}`, edits: [{ fileIndex, rowId, colId, oldValue, newValue }] });
  }

  function undo() {
    if (journal.length === 0) return;
    const last = journal[journal.length - 1];
    const next = applyOp(working, invertOp(last));
    setWorking(next);
    setJournal((j) => j.slice(0, -1));
    setRedoStack((r) => [...r, last]);
    recompute(next);
  }

  function redo() {
    if (redoStack.length === 0) return;
    const last = redoStack[redoStack.length - 1];
    const next = applyOp(working, last);
    setWorking(next);
    setRedoStack((r) => r.slice(0, -1));
    setJournal((j) => [...j, last]);
    recompute(next);
  }

  // Review → Import: the actual dependency-ordered write, reusing the per-entity execute routes.
  async function runImport() {
    setError(null);
    setImporting(true);
    try {
      const token = await authToken();
      const plan = buildImportPlan(filterWorkingByMode(working, existing ?? {}, importMode));
      const post = (endpoint: string, body: unknown) =>
        postJson<ExecuteResponseShape>(endpoint, body, token);
      setImportSummary(await runImportPlan(plan, companyId, post));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  // Explicit-action only (AI-cost rule): the owner clicks "Suggest how to fix these".
  async function requestSuggestions() {
    if (!report) return;
    setSuggestLoading(true);
    try {
      const token = await authToken();
      const resp = await postJson<SuggestFixesResponse>(
        '/api/data-import/suggest-fixes',
        {
          company_id: companyId,
          findings: report.findings
            .filter((f) => f.verified)
            .map((f) => ({
              id: f.id,
              category: f.category,
              severity: f.severity,
              title: f.title,
              detail: f.detail,
              count: f.count,
              examples: f.examples.slice(0, 3),
            })),
          file_summaries: working.map((wf) => ({
            filename: wf.filename,
            entity_type: wf.entityType,
            row_count: wf.rows.length,
          })),
        },
        token,
      );
      setSuggestions(resp.suggestions);
      setSuggestAvailable(resp.suggestions_available);
    } catch {
      setSuggestions([]);
      setSuggestAvailable(false);
    } finally {
      setSuggestLoading(false);
    }
  }

  // Review → Import: read what's already in Jigged (for new-vs-existing + create/update modes),
  // then advance. Best-effort read; the Import step renders immediately and updates when it lands.
  function goToImport() {
    setImportSummary(null);
    setExisting(null);
    setActiveStep(4);
    fetchExistingIdentities(companyId)
      .then(setExisting)
      .catch(() => setExisting({}));
  }

  const activeFile = working[gridIndex];
  const mergeDefaultCol = activeFile
    ? activeFile.columnRoles[ENTITY_IDENTITY_FIELD[activeFile.entityType] ?? ''] ??
      activeFile.headers[0] ??
      ''
    : '';

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Bring your existing shop data into Jigged. We&apos;ll help you check and fix it first, and
        show you exactly what will come in — nothing is imported until you say so.
      </Typography>

      <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
        {STEPS.map((label) => (
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

      {busy ? (
        <AIAnalysisLoading
          description={
            activeStep === 1
              ? 'Reading your files and detecting the source system…'
              : 'Checking your data and writing the summary…'
          }
        />
      ) : (
        <>
          {/* Step 0 — What you'll need */}
          {activeStep === 0 && (
            <Card elevation={2}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="h6" gutterBottom>
                  Export these from your current system as CSV
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Add whatever you have — you don&apos;t need all of them, and you can add more later.
                  Most shop systems (JobBOSS, E2, Tangle, spreadsheets) can export each list to CSV.
                </Typography>
                <Stack spacing={1.25}>
                  {WHAT_TO_EXPORT.map((w) => (
                    <Box key={w.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <DescriptionOutlinedIcon color="action" />
                      <Typography variant="body1" sx={{ fontWeight: 600 }}>
                        {w.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        — {w.hint}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
                <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="contained" size="large" onClick={() => setActiveStep(1)}>
                    Get started
                  </Button>
                </Box>
              </CardContent>
            </Card>
          )}

          {/* Step 1 — Upload */}
          {activeStep === 1 && (
            <Box>
              <MultiFileDropzone files={files} onChange={setFiles} />
              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={() => setActiveStep(0)}>Back</Button>
                <Button
                  variant="contained"
                  size="large"
                  startIcon={<AutoAwesomeIcon />}
                  disabled={files.length === 0}
                  onClick={runStructure}
                >
                  Analyze {files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'}` : ''}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 2 — Map columns (confirm what each file is + how columns map) */}
          {activeStep === 2 && (
            <Box>
              <Typography variant="h6" gutterBottom>
                Here&apos;s what we found in your files
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                We read your files and matched everything we could. Just handle the few items
                flagged below, then continue — you can still change anything on the next step.
              </Typography>
              <ColumnMappingStep
                files={working}
                onEntityChange={handleEntityChange}
                onRoleChange={handleRoleChange}
              />
              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={() => setActiveStep(1)}>Back to files</Button>
                <Button variant="contained" size="large" onClick={confirmMapping}>
                  Looks right — continue
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 3 — Review + fix (live re-analyze) */}
          {activeStep === 3 && report && (
            <Box>
              <ImportReviewView report={report} onUploadMore={() => setActiveStep(1)} />

              {working.length > 0 && (
                <>
                  <Divider sx={{ my: 4 }} />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
                    <Typography variant="h6" sx={{ flex: 1 }}>
                      Fix your data
                    </Typography>
                    <Button size="small" startIcon={<UndoIcon />} disabled={journal.length === 0} onClick={undo}>
                      Undo
                    </Button>
                    <Button size="small" startIcon={<RedoIcon />} disabled={redoStack.length === 0} onClick={redo}>
                      Redo
                    </Button>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Fix a whole column at once below, or double-click any cell to edit. The review
                    above updates as you go — no spreadsheet needed.
                  </Typography>
                  <SuggestFixesPanel
                    suggestions={suggestions}
                    loading={suggestLoading}
                    available={suggestAvailable}
                    onRequest={requestSuggestions}
                  />
                  {activeFile && (
                    <FixToolbar
                      key={activeFile.filename}
                      file={activeFile}
                      onBulkReplace={(colId, find, replace) =>
                        applyRemediation(bulkReplace(working, gridIndex, colId, find, replace))
                      }
                      onFillBlanks={(colId, value) =>
                        applyRemediation(fillBlanks(working, gridIndex, colId, value))
                      }
                      onOpenMerge={() => setMergeOpen(true)}
                    />
                  )}
                  <EditableDataGrid
                    files={working}
                    activeIndex={gridIndex}
                    onActiveIndexChange={setGridIndex}
                    onCellEdit={handleCellEdit}
                  />
                  {activeFile && (
                    <MergeVariantsDialog
                      open={mergeOpen}
                      onClose={() => setMergeOpen(false)}
                      file={activeFile}
                      defaultColId={mergeDefaultCol}
                      onMerge={(colId, canonical, variants) =>
                        applyRemediation(mergeVariants(working, gridIndex, colId, canonical, variants))
                      }
                    />
                  )}
                </>
              )}

              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={() => setActiveStep(2)}>Back to mapping</Button>
                <Button variant="contained" size="large" onClick={goToImport}>
                  Continue to import
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 4 — Import (pre-commit plan → confirm → dependency-ordered write → summary) */}
          {activeStep === 4 && report && (
            <ImportStep
              report={report}
              working={working}
              existing={existing}
              importMode={importMode}
              onModeChange={setImportMode}
              importing={importing}
              summary={importSummary}
              onImport={runImport}
              onBack={() => setActiveStep(3)}
            />
          )}
        </>
      )}
    </Box>
  );
}

function ImportStep({
  report,
  working,
  existing,
  importMode,
  onModeChange,
  importing,
  summary,
  onImport,
  onBack,
}: {
  report: ImportReview;
  working: WorkingFile[];
  existing: ExistingIdentities | null;
  importMode: ImportMode;
  onModeChange: (mode: ImportMode) => void;
  importing: boolean;
  summary: ImportSummary | null;
  onImport: () => void;
  onBack: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const rec = useMemo(() => reconcile(working, existing ?? {}), [working, existing]);
  const plan = useMemo(
    () => buildImportPlan(filterWorkingByMode(working, existing ?? {}, importMode)),
    [working, existing, importMode],
  );
  const planByEntity = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of plan) m.set(b.entity, (m.get(b.entity) ?? 0) + b.rows.length);
    return [...m.entries()];
  }, [plan]);
  const blocking = summarize(report).verdict.counts.critical;

  if (summary) {
    return (
      <Card elevation={2}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h6" gutterBottom>
            {summary.failed ? 'Import finished with some errors' : 'Import complete'}
          </Typography>
          <Alert
            severity={summary.failed ? 'warning' : 'success'}
            icon={summary.failed ? undefined : <CheckCircleOutlineIcon />}
            sx={{ mb: 2 }}
          >
            Created {summary.totalCreated.toLocaleString()}
            {summary.totalUpdated > 0 ? `, updated ${summary.totalUpdated.toLocaleString()}` : ''}
            {summary.totalSkipped > 0 ? `, skipped ${summary.totalSkipped.toLocaleString()}` : ''}
            {summary.totalErrors > 0
              ? ` · ${summary.totalErrors} error${summary.totalErrors === 1 ? '' : 's'}`
              : ''}
            .
          </Alert>
          <Stack spacing={1}>
            {summary.byEntity.map((e) => (
              <Box key={e.entity} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 130, textTransform: 'capitalize' }}>
                  {e.entity.replace('_', ' ')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {e.created.toLocaleString()} created
                  {e.updated > 0 ? `, ${e.updated} updated` : ''}
                  {e.skipped > 0 ? `, ${e.skipped} skipped` : ''}
                  {e.errorCount > 0 ? `, ${e.errorCount} error${e.errorCount === 1 ? '' : 's'}` : ''}
                </Typography>
              </Box>
            ))}
          </Stack>
          {summary.totalSkipped + summary.totalErrors > 0 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Skipped rows usually reference something not yet in Jigged. Fix them on the Review step
              and re-run — re-importing is safe (existing records update in place, they don&apos;t
              duplicate).
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Review what will be created
        </Typography>
        {rec.hasExisting && (
          <Box sx={{ mb: 2 }}>
            <Alert severity="info" sx={{ mb: 1.5 }}>
              <strong>{rec.totalMatched.toLocaleString()}</strong> of your rows match records already
              in Jigged, and <strong>{rec.totalNew.toLocaleString()}</strong> are new. Choose what to
              do — existing records update in place; nothing is duplicated.
            </Alert>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={importMode}
              onChange={(_, v) => {
                if (v) onModeChange(v as ImportMode);
              }}
              disabled={importing}
              sx={{ flexWrap: 'wrap' }}
            >
              <ToggleButton value="both">Add new + update existing</ToggleButton>
              <ToggleButton value="create">Add new only</ToggleButton>
              <ToggleButton value="update">Update existing only</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Here&apos;s what will import, in order (so linked records connect up):
        </Typography>
        <Stack spacing={1} sx={{ mb: 2 }}>
          {planByEntity.map(([entity, count], i) => (
            <Box key={entity} sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
              <Chip size="small" label={i + 1} />
              <Typography variant="body2" sx={{ fontWeight: 600, textTransform: 'capitalize', minWidth: 130 }}>
                {entity.replace('_', ' ')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {count.toLocaleString()} row{count === 1 ? '' : 's'}
              </Typography>
            </Box>
          ))}
        </Stack>

        {blocking > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            You still have <strong>{blocking} blocking issue{blocking === 1 ? '' : 's'}</strong>. Rows
            that can&apos;t be resolved will be skipped (and reported) — fix them on the Review step
            for a complete import.
          </Alert>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onBack} disabled={importing}>
            Back to review
          </Button>
          <Button
            variant="contained"
            size="large"
            disabled={importing || plan.length === 0}
            onClick={() => setConfirmOpen(true)}
          >
            {importing ? 'Importing…' : 'Import into Jigged'}
          </Button>
        </Box>

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
          <DialogTitle>Import into Jigged?</DialogTitle>
          <DialogContent>
            <Typography variant="body2">
              This creates and updates records in your Jigged company. Existing records (matched by
              name / part number) update in place — nothing is duplicated, and rows that can&apos;t be
              resolved are skipped and reported. You can re-run safely.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => {
                setConfirmOpen(false);
                onImport();
              }}
            >
              Yes, import
            </Button>
          </DialogActions>
        </Dialog>
      </CardContent>
    </Card>
  );
}
