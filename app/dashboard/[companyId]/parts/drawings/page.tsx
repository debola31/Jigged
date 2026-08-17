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

import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { groupDrawingFiles } from '@/lib/drawingFileGroups';
import { buildRows, type BuiltRow } from '@/lib/drawingImportExtract';
import { resolveIdentities } from '@/utils/drawingImportIdentity';
import { createPartsFromRows, summarise, type CreatedRow } from '@/utils/drawingImportCreate';
import { valueOf } from '@/types/drawingImport';
import DrawingDropStep from '@/components/drawings/DrawingDropStep';
import DrawingReviewStep from '@/components/drawings/DrawingReviewStep';

const STEPS = ['Add the files', 'Review the parts', 'Create'] as const;

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
        setRows(built.map((r) => ({ ...r, identity: identities.get(r.stem) ?? r.identity })));
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

  const handleCreate = useCallback(async () => {
    setError(null);
    setBusy('Creating parts…');
    setStep(2);
    try {
      const created = await createPartsFromRows(rows, {
        companyId,
        customerId,
        defaultUnit,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResults(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create these parts.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [rows, companyId, customerId, defaultUnit]);

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
          onCreate={handleCreate}
          creating={!!busy}
        />
      )}

      {step === 2 && (
        <Card>
          <CardContent>
            {results ? (
              <>
                <Typography variant="h6" gutterBottom>
                  {summarise(results)}
                </Typography>
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
                <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                  <Button
                    variant="contained"
                    onClick={() => router.push(`/dashboard/${companyId}/parts`)}
                  >
                    Go to Parts
                  </Button>
                  <Button
                    onClick={() => {
                      setRows([]);
                      setResults(null);
                      setStep(0);
                    }}
                  >
                    Add more drawings
                  </Button>
                </Box>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Creating parts…
              </Typography>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
