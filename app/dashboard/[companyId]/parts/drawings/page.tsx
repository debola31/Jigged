'use client';

/**
 * Add parts from drawings.
 *
 * Drop a folder, review one row per part, create. The deterministic pass runs
 * entirely in this tab — no network, no credits — so the grid is populated before
 * anything optional happens.
 */

import { useCallback, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';

import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { groupDrawingFiles } from '@/lib/drawingFileGroups';
import { buildRows, type BuiltRow } from '@/lib/drawingImportExtract';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import { createPartsFromRows, summarise, type CreatedRow } from '@/utils/drawingImportCreate';
import { assistRows } from '@/utils/drawingFieldsAssist';
import { valueOf } from '@/types/drawingImport';
import DrawingDropStep from '@/components/drawings/DrawingDropStep';
import DrawingReviewStep from '@/components/drawings/DrawingReviewStep';
import DrawingWorkStep, { type WorkPlan } from '@/components/drawings/DrawingWorkStep';

const STEPS = ['Add the files', 'Review the parts', 'How they are made', 'Create'] as const;

export default function AddPartsFromDrawingsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { features, loading: featuresLoading } = useCompanyFeatures();

  const [step, setStep] = useState(0);
  const [rows, setRows] = useState<BuiltRow[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [defaultUnit, setDefaultUnit] = useState('ea');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CreatedRow[] | null>(null);
  const [assisted, setAssisted] = useState(false);
  const [work, setWork] = useState<WorkPlan>({ stems: new Set(), operations: [] });

  /**
   * Read the dropped files, then resolve identity in ONE batched pass. Per-row
   * lookups would be 31 round trips before the grid could render.
   */
  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      const groups = groupDrawingFiles(files);
      if (groups.length === 0) {
        setError('None of those files look like drawings. Add PDF, DXF or STEP files.');
        return;
      }

      setBusy('Reading the drawings…');
      setProgress({ done: 0, total: groups.length });
      try {
        const built = await buildRows(groups, (done, total) => setProgress({ done, total }));

        setBusy('Checking these against your parts…');
        const identities = await resolveIdentities(
          companyId,
          customerId,
          built.map((r) => ({
            stem: r.stem,
            partName: valueOf(r, 'part_name'),
            customerPartNumber: valueOf(r, 'customer_part_number'),
          })),
        );
        const withIdentity = built.map((r) => ({
          ...r,
          identity: identities.get(r.stem) ?? r.identity,
        }));
        setRows(withIdentity);

        // Shape, never content: how many files became how many parts, which
        // front-end read them, and how many need a human. No part numbers.
        posthog.capture('drawings read', {
          file_count: files.length,
          part_count: withIdentity.length,
          read_from_dxf: withIdentity.filter((r) => r.readSource === 'dxf').length,
          read_from_pdf: withIdentity.filter((r) => r.readSource === 'pdf').length,
          unreadable_count: withIdentity.filter((r) => r.readSource === 'none').length,
          with_components: withIdentity.filter((r) => r.cutList).length,
          has_customer: !!customerId,
        });
        setStep(1);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read those files.');
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    [companyId, customerId],
  );

  /** Explicit user action, never a lifecycle hook — this is the one path that spends. */
  const handleAssist = useCallback(async () => {
    setError(null);
    setBusy('Reading the title blocks…');
    try {
      const outcome = await assistRows(companyId, rows, (done, total) =>
        setProgress({ done, total }),
      );
      setRows((current) =>
        current.map((r) => {
          const filled = outcome.filled.get(r.stem);
          return filled ? { ...r, fields: { ...r.fields, ...filled } } : r;
        }),
      );
      setAssisted(true);
      // `dropped_count` is the fidelity check firing. It has never fired in
      // measurement, so a non-zero here is the signal that something changed.
      posthog.capture('drawing title blocks read', {
        asked_count: outcome.askedAbout,
        filled_count: outcome.filled.size,
        skipped_count: outcome.skipped,
        failed_count: outcome.failed,
        dropped_count: outcome.dropped.length,
      });
      if (outcome.failed > 0) {
        setError(
          `${outcome.filled.size} of ${outcome.askedAbout} drawings filled in. ${outcome.failed} could not be read — the rest are unaffected.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the title blocks.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [companyId, rows]);

  const handleCreate = useCallback(async () => {
    setError(null);
    setBusy('Creating parts…');
    setStep(3);
    try {
      // One routing, applied to the parts the user ticked.
      const operationsByStem = new Map(
        [...work.stems].map((stem) => [stem, work.operations]),
      );
      const created = await createPartsFromRows(rows, {
        companyId,
        customerId,
        defaultUnit,
        operationsByStem,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResults(created);
      posthog.capture('parts created from drawings', {
        created_count: created.filter((r) => r.action === 'created').length,
        revived_count: created.filter((r) => r.action === 'revived').length,
        updated_count: created.filter((r) => r.action === 'updated').length,
        failed_count: created.filter((r) => r.action === 'failed').length,
        excluded_count: rows.length - created.length,
        files_attached: created.reduce((n, r) => n + r.filesAttached, 0),
        with_operations: created.filter((r) => r.operationsAdded > 0).length,
        quotable_count: created.filter((r) => r.quotable).length,
        used_ai: assisted,
        has_customer: !!customerId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create these parts.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [rows, companyId, customerId, defaultUnit, assisted, work]);

  const includedCount = useMemo(() => rows.filter((r) => !r.excluded).length, [rows]);

  // A hidden tab is not access control, but this page writes nothing on its own —
  // the flag gates the surface and the backend route gates the spend.
  if (featuresLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!features.drawing_import) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          <AlertTitle>Not enabled for this company</AlertTitle>
          Adding parts from drawings is off. An admin can turn it on in company settings.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts`)}
        >
          Parts
        </Button>
        <Box>
          <Typography variant="h5">Add parts from drawings</Typography>
          <Typography variant="body2" color="text.secondary">
            Drop a folder of drawings. We read what each one says and show you before anything is
            created.
          </Typography>
        </Box>
      </Box>

      <Stepper activeStep={step} sx={{ mb: 4 }}>
        {STEPS.map((label) => (
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

      {busy && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {busy}
              {progress ? ` ${progress.done} of ${progress.total}` : ''}
            </Typography>
            <LinearProgress
              variant={progress ? 'determinate' : 'indeterminate'}
              value={progress ? (100 * progress.done) / Math.max(progress.total, 1) : undefined}
            />
          </CardContent>
        </Card>
      )}

      {step === 0 && (
        <DrawingDropStep
          companyId={companyId}
          customerId={customerId}
          onCustomerChange={setCustomerId}
          defaultUnit={defaultUnit}
          onDefaultUnitChange={setDefaultUnit}
          onFiles={handleFiles}
          disabled={!!busy}
        />
      )}

      {step === 1 && (
        <DrawingReviewStep
          rows={rows}
          onRowsChange={setRows}
          includedCount={includedCount}
          onBack={() => setStep(0)}
          onCreate={() => setStep(2)}
          creating={!!busy}
          onAssist={handleAssist}
          assisted={assisted}
          customerId={customerId}
        />
      )}

      {step === 2 && (
        <DrawingWorkStep
          companyId={companyId}
          rows={rows}
          plan={work}
          onPlanChange={setWork}
          onBack={() => setStep(1)}
          onCreate={handleCreate}
          creating={!!busy}
          includedCount={includedCount}
        />
      )}

      {step === 3 && results && (
        <Card>
          <CardContent>
            {results ? (
              <>
                <Typography variant="h6" gutterBottom>
                  {summarise(results)}
                </Typography>
                {results.length > 0 && !results.some((r) => r.quotable) && (
                  <Alert severity="info" sx={{ my: 2 }}>
                    <AlertTitle>Not quotable yet</AlertTitle>
                    These parts have no priced work on them, so there is no cost to mark up. Add
                    operations on a part — or come back through this flow and set the work — and
                    they become quotable.
                  </Alert>
                )}
                {results.some((r) => r.action === 'failed' || r.fileErrors.length > 0) && (
                  <Alert severity="warning" sx={{ my: 2 }}>
                    <AlertTitle>Some rows need another look</AlertTitle>
                    {results
                      .filter((r) => r.action === 'failed' || r.fileErrors.length > 0)
                      .map((r) => (
                        <Typography key={r.stem} variant="body2">
                          <strong>{r.partName}</strong> — {r.error ?? r.fileErrors.join('; ')}
                        </Typography>
                      ))}
                  </Alert>
                )}
                <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                  {/* The point of the whole flow. Offered only for parts that can
                      actually carry a price — seeding a quote with lines that throw
                      on save would be worse than not offering it. */}
                  {results.some((r) => r.quotable) && (
                    <Button
                      variant="contained"
                      startIcon={<RequestQuoteIcon />}
                      onClick={() => {
                        const ids = results
                          .filter((r) => r.quotable && r.partId)
                          .map((r) => r.partId)
                          .join(',');
                        const customer = customerId ? `&customer=${customerId}` : '';
                        router.push(
                          `/dashboard/${companyId}/quotes/new?parts=${ids}${customer}`,
                        );
                      }}
                    >
                      Quote {results.filter((r) => r.quotable).length} of these
                    </Button>
                  )}
                  <Button
                    variant={results.some((r) => r.quotable) ? 'outlined' : 'contained'}
                    onClick={() => router.push(`/dashboard/${companyId}/parts`)}
                  >
                    Go to Parts
                  </Button>
                  <Button
                    onClick={() => {
                      setRows([]);
                      setResults(null);
                      setAssisted(false);
                      setWork({ stems: new Set(), operations: [] });
                      setStep(0);
                    }}
                  >
                    Add more drawings
                  </Button>
                </Box>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
