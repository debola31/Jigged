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
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';

import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { groupDrawingFiles } from '@/lib/drawingFileGroups';
import { buildRows, type BuiltRow } from '@/lib/drawingImportExtract';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import { createPartsFromRows, summarise, type CreatedRow } from '@/utils/drawingImportCreate';
import { assistRows } from '@/utils/drawingFieldsAssist';
import { valueOf } from '@/types/drawingImport';
import DrawingDropStep from '@/components/drawings/DrawingDropStep';
import DrawingWorkspaceStep, { type WorkByStem } from '@/components/drawings/DrawingWorkspaceStep';
import {
  planComponents,
  applyComponentEdits,
  NO_COMPONENT_EDITS,
  type ComponentEdits,
  type ComponentPlan,
} from '@/lib/drawingComponents';

const STEPS = ['Add the files', 'Set them up', 'Create'] as const;

export default function AddPartsFromDrawingsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { features, loading: featuresLoading } = useCompanyFeatures();

  const [step, setStep] = useState(0);
  const [rows, setRows] = useState<BuiltRow[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [defaultUnit, setDefaultUnit] = useState('ea');
  const [defaultSource, setDefaultSource] = useState<'made' | 'bought'>('made');
  const [busy, setBusy] = useState<string | null>(null);
  // Distinct from `busy`: only the final write. The primary button reads from this,
  // and while the title blocks were being read it used to say "Creating…".
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CreatedRow[] | null>(null);
  const [assisted, setAssisted] = useState(false);
  const [work, setWork] = useState<WorkByStem>(new Map());
  const [fileCount, setFileCount] = useState(0);
  const [assistFailed, setAssistFailed] = useState(false);
  const [componentEdits, setComponentEdits] = useState<ComponentEdits>(NO_COMPONENT_EDITS);

  /**
   * DERIVED, not stored. Excluding a weldment has to drop its components, so the
   * plan is a pure function of the rows — and the user's costs live apart, so that
   * recompute cannot wipe them.
   */
  const components = useMemo(
    () => applyComponentEdits(planComponents(rows), componentEdits),
    [rows, componentEdits],
  );

  /** Fold a panel edit back into the stored answers rather than the derived plan. */
  const handleComponentsChange = useCallback((next: ComponentPlan) => {
    setComponentEdits({
      costs: Object.fromEntries(next.materials.map((m) => [m.key, m.costPerUnit])),
      units: Object.fromEntries(next.materials.map((m) => [m.key, m.unit])),
      excluded: [...next.materials, ...next.made].filter((c) => !c.include).map((c) => c.key),
    });
  }, []);

  /**
   * Read the title blocks closely.
   *
   * Takes its rows as an ARGUMENT rather than reading state: it runs immediately
   * after `setRows`, and React has not re-rendered yet, so `rows` here would be
   * the previous import's — or on the first run, empty.
   *
   * Reached two ways, both of them a press the user made: the button on step 1
   * (which does this as part of reading the files) and the offer on step 2, which
   * stands as the retry when this fails.
   */
  const runAssist = useCallback(async (target: BuiltRow[]) => {
    setError(null);
    setBusy('Reading the title blocks…');
    try {
      setAssistFailed(false);
      const outcome = await assistRows(companyId, target, (done, total) =>
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
      setAssistFailed(true);
      setError(err instanceof Error ? err.message : 'Could not read the title blocks.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [companyId]);

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

      setFileCount(files.length);
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
        const withIdentity = built.map((r) => {
          const identity = identities.get(r.stem) ?? r.identity;
          // A live part of this name belongs to someone else, so this row cannot
          // have it. Put the name it WILL get into the field now: a column showing
          // "1003308" while creating "1003308-2" is worse than either name alone,
          // and the user can still type over it.
          if (identity.kind === 'name_taken') {
            return {
              ...r,
              identity,
              edits: { ...r.edits, part_name: identity.suggestedName },
            };
          }
          return { ...r, identity };
        }).map((r) => ({
          // Answered once on the previous step for the whole package.
          ...r,
          edits: { ...r.edits, source: defaultSource },
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

        /**
         * Then read the drawings closely, as part of the SAME press.
         *
         * This does not break the no-AI-on-load rule: the rule is about lifecycle
         * hooks — mount, effect, poll — and this is a button the user pressed with
         * files they chose. What it is not is a second button asking permission
         * for something they already asked for.
         *
         * It runs AFTER the rows are on screen, so the deterministic result is
         * never held hostage to it, and a failure leaves the offer standing rather
         * than losing the import.
         */
        await runAssist(withIdentity);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read those files.');
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companyId, customerId, defaultSource],
  );

  /** Straight into the quote, seeded with the parts that can actually carry a price. */
  const goToQuote = useCallback(
    (created: CreatedRow[]) => {
      const ids = created
        .filter((r) => r.quotable && r.partId)
        .map((r) => r.partId)
        .join(',');
      if (!ids) return false;
      const customer = customerId ? `&customer=${customerId}` : '';
      router.push(`/dashboard/${companyId}/quotes/new?parts=${ids}${customer}`);
      return true;
    },
    [companyId, customerId, router],
  );

  const handleCreate = useCallback(async (thenQuote: boolean) => {
    setError(null);
    setBusy('Creating parts…');
    setCreating(true);
    setStep(2);
    try {
      const created = await createPartsFromRows(rows, {
        companyId,
        customerId,
        defaultUnit,
        operationsByStem: work,
        components,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResults(created);
      posthog.capture('parts created from drawings', {
        created_count: created.filter((r) => r.action === 'created').length,
        updated_count: created.filter((r) => r.action === 'updated').length,
        failed_count: created.filter((r) => r.action === 'failed').length,
        excluded_count: rows.length - created.length,
        files_attached: created.reduce((n, r) => n + r.filesAttached, 0),
        with_operations: created.filter((r) => r.operationsAdded > 0).length,
        components_linked: created.reduce((n, r) => n + r.componentsLinked, 0),
        quotable_count: created.filter((r) => r.quotable).length,
        used_ai: assisted,
        has_customer: !!customerId,
        then_quote: thenQuote,
      });

      /**
       * The goal was never parts. If they asked to quote and anything can carry a
       * price, go — the results screen is a receipt, and standing between someone
       * and the thing they came for is the step this redesign removed elsewhere.
       *
       * If NOTHING is quotable we stay put, because the quote form would throw on
       * every line and "we couldn't" is better said here than there.
       */
      if (thenQuote) goToQuote(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create these parts.');
    } finally {
      setBusy(null);
      setCreating(false);
      setProgress(null);
    }
  }, [rows, companyId, customerId, defaultUnit, assisted, work, components, goToQuote]);

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
      {/*
        No page heading and no back link. The app header already names this page,
        and Parts is one item down the sidebar — repeating both cost a third of the
        screen above the fold for nothing anyone needed.
      */}
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

      {/*
        Not while the workspace is up: it shows the read inline, and two progress
        bars stacked made a background task look like a gate across the page.
      */}
      {busy && step !== 1 && (
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
          defaultSource={defaultSource}
          onDefaultSourceChange={setDefaultSource}
          onFiles={handleFiles}
          disabled={!!busy}
        />
      )}

      {step === 1 && (
        <DrawingWorkspaceStep
          companyId={companyId}
          rows={rows}
          onRowsChange={setRows}
          fileCount={fileCount}
          work={work}
          onWorkChange={setWork}
          components={components}
          onComponentsChange={handleComponentsChange}
          onBack={() => setStep(0)}
          onCreate={handleCreate}
          creating={creating}
          reading={!!busy && !creating}
          readProgress={progress}
          onAssist={() => void runAssist(rows)}
          assistFailed={assistFailed}
          customerId={customerId}
        />
      )}

      {step === 2 && results && (
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
                      onClick={() => goToQuote(results)}
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
                      setWork(new Map());
                      setFileCount(0);
                      setAssistFailed(false);
                      setComponentEdits(NO_COMPONENT_EDITS);
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
