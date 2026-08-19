'use client';

/**
 * Add parts from drawings.
 *
 * Drop a folder, review one row per part, create. The deterministic pass runs
 * entirely in this tab — no network, no credits — so the grid is populated before
 * anything optional happens.
 */

import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';

import { groupDrawingFiles } from '@/lib/drawingFileGroups';
import { buildRows, type BuiltRow } from '@/lib/drawingImportExtract';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import {
  createPartsFromRows,
  summarise,
  type CreatedRow,
  type ResolvedMaterial,
} from '@/utils/drawingImportCreate';
import { isUsable } from '@/components/drawings/MaterialLines';
import { valueOf } from '@/types/drawingImport';
import DrawingDropStep from '@/components/drawings/DrawingDropStep';
import DrawingWorkspaceStep, { type WorkByStem } from '@/components/drawings/DrawingWorkspaceStep';
import type { MaterialLine } from '@/components/drawings/MaterialLines';

const STEPS = ['Add the files', 'Set them up', 'Create'] as const;

/**
 * The user's material lines, as the writer needs them.
 *
 * Half-typed rows are dropped rather than written: an empty line is somebody
 * mid-thought, not a material.
 */
function resolveMaterials(
  byStem: Map<string, MaterialLine[]>,
): Map<string, ResolvedMaterial[]> {
  const out = new Map<string, ResolvedMaterial[]>();
  for (const [stem, lines] of byStem) {
    const usable = lines.filter(isUsable).map((l) => ({
      partId: l.part?.id ?? null,
      name: l.part ? l.part.part_name : l.name.trim(),
      quantity: Number(l.quantity) || 0,
      unit: l.unit.trim(),
      costPerUnit:
        l.costPerUnit.trim() === '' || !Number.isFinite(Number(l.costPerUnit))
          ? null
          : Number(l.costPerUnit),
    }));
    if (usable.length > 0) out.set(stem, usable);
  }
  return out;
}

export default function AddPartsFromDrawingsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [step, setStep] = useState(0);
  const [rows, setRows] = useState<BuiltRow[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  /**
   * `each`, not `ea`. The picker treats `ea` as a DEPRECATED ALIAS and shows it
   * under "unknown" with a warning triangle — so the default we shipped was the
   * one value the control complains about.
   */
  const [defaultUnit, setDefaultUnit] = useState('each');
  const [defaultSource, setDefaultSource] = useState<'made' | 'bought'>('made');
  const [busy, setBusy] = useState<string | null>(null);
  // Distinct from `busy`: only the final write. The primary button reads from this,
  // and while the title blocks were being read it used to say "Creating…".
  const [creating, setCreating] = useState(false);
  /** Set when someone presses Quote and nothing can carry a price — see §4. */
  const [quoteBlocked, setQuoteBlocked] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CreatedRow[] | null>(null);
  const [work, setWork] = useState<WorkByStem>(new Map());
  const [fileCount, setFileCount] = useState(0);

  /**
   * What each part is made of, keyed by stem — the user's own lines, not the
   * drawing's cut list. A cut list only exists on the odd weldment, so inferring
   * meant "Add materials" had nothing to offer for most of a package.
   */
  const [materials, setMaterials] = useState<Map<string, MaterialLine[]>>(new Map());

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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read those files.');
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
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

  const handleCreate = useCallback(async () => {
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
        materialsByStem: resolveMaterials(materials),
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
        has_customer: !!customerId,
      });

      /**
       * No automatic hand-off to a quote.
       *
       * Filing is the outcome this flow promises, and a part is only quotable once
       * someone has said how long its stations take — which is a consensus, not a
       * form field. The results screen offers the quote when there is genuinely
       * something to quote, and says nothing when there is not.
       */
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create these parts.');
    } finally {
      setBusy(null);
      setCreating(false);
      setProgress(null);
    }
  }, [rows, companyId, customerId, defaultUnit, work, materials]);

  // A hidden tab is not access control, but this page writes nothing on its own —
  // the flag gates the surface and the backend route gates the spend.
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
          materials={materials}
          onMaterialsChange={setMaterials}
          defaultUnit={defaultUnit}
          onBack={() => setStep(0)}
          onCreate={handleCreate}
          creating={creating}
          customerId={customerId}
        />
      )}

      {step === 2 && results && (
        <Card>
          <CardContent>
            {(() => {
              const quotableCount = results.filter((r) => r.quotable).length;
              return (
              <>
                <Typography variant="h6" gutterBottom>
                  {summarise(results)}
                </Typography>
                {results.length > 0 && !results.some((r) => r.quotable) && (
                  <Alert severity="info" sx={{ my: 2 }}>
                    <AlertTitle>What is left before these can be quoted</AlertTitle>
                    A part is quotable once something says what it costs — how long its stations
                    take, or what its materials cost. Stations on their own are a route, not a
                    price. Open any of these on the Parts page and add times to its operations.
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
                {quoteBlocked && (
                  <Alert severity="warning" sx={{ my: 2 }} onClose={() => setQuoteBlocked(false)}>
                    None of these can be quoted yet — a quote line needs a price, and these have no
                    cost to mark up. Add times to their operations on the Parts page and they
                    become quotable.
                  </Alert>
                )}
                <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                  {/*
                    THE POINT OF THE WHOLE FLOW, and it is always here.
                    
                    A disabled button would have been the obvious way to say "not
                    yet", and interaction-standards §4 argues against it: a
                    disabled control is not focusable, so keyboard and screen
                    reader users never learn it exists or why, and the state this
                    button would express is not a stable lock — it is something
                    the user can go and change. So it stays live and explains on
                    attempt, which is rule 1 rather than rule 2.
                  */}
                  <Button
                    variant="contained"
                    startIcon={<RequestQuoteIcon />}
                    onClick={() => {
                      if (!goToQuote(results)) setQuoteBlocked(true);
                    }}
                  >
                    {quotableCount > 0
                      ? `Quote ${quotableCount} of these`
                      : 'Create a quote from these'}
                  </Button>
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
                      setQuoteBlocked(false);
                                      setWork(new Map());
                      setFileCount(0);
                      setMaterials(new Map());
                      setStep(0);
                    }}
                  >
                    Add more drawings
                  </Button>
                </Box>
              </>
              );
            })()}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
