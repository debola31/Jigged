'use client';

/**
 * Stock count sheet — journey J9 in docs/modules/inventory.md.
 *
 * Scope → Sheet → Review, then commit. Three deliberate choices, all recorded in the spec:
 *
 *  - **No server session.** The sheet is client state autosaved to localStorage, like every
 *    other wizard in this app. Assignment and cross-device resume are the things given up;
 *    they're multi-counter problems a small shop doesn't have yet.
 *  - **Expected is visible, the input starts empty.** Fast, but with nothing to tab past and
 *    accept — the failure mode of a pre-filled count.
 *  - **Uncounted lines are left alone.** No entry means no opinion, so an abandoned sheet can
 *    never silently zero real stock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';

import { usePageTitle } from '@/components/layout/PageTitleProvider';

import {
  buildDraft,
  buildVariances,
  bigVariances,
  clearDraft as clearStoredDraft,
  committableVariances,
  countableCandidates,
  countedTally,
  excludedCandidates,
  readDraft,
  writeDraft,
} from '@/lib/inventoryCountPlan';
import {
  commitCount,
  loadCountCandidates,
  refreshSystemQuantities,
} from '@/utils/inventoryCountAccess';
import type {
  CountCandidate,
  CountCommitProgress,
  CountLine,
  CountVariance,
} from '@/types/inventoryCount';

const STEPS = ['Choose what to count', 'Count', 'Review'];

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function InventoryCountPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  // Without this the Header falls back to "Inventory Details" for any unrecognised
  // /inventory/* route, which is both wrong and confusing mid-count.
  const { setTitle } = usePageTitle();
  useEffect(() => {
    setTitle('Stock Count');
    return () => setTitle(null);
  }, [setTitle]);

  const [activeStep, setActiveStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<CountCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const [lines, setLines] = useState<CountLine[]>([]);
  /** System quantities as they were when the sheet opened — compared against a fresh read at
   *  Review so we can say which parts moved underneath the count. */
  const openedWithRef = useRef<Map<string, number>>(new Map());

  const [variances, setVariances] = useState<CountVariance[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CountCommitProgress | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(null);

  const [resumeOffer, setResumeOffer] = useState<{ partIds: string[]; lines: CountLine[]; savedAt: number } | null>(
    null,
  );

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await loadCountCandidates(companyId);
        if (cancelled) return;
        setCandidates(found);

        // Offer to resume only if the draft's parts still exist — otherwise the lines would
        // reattach to the wrong rows.
        const draft = readDraft(companyId);
        if (draft) {
          const known = new Set(found.map((c) => c.partId));
          const stillValid = draft.partIds.filter((id) => known.has(id));
          if (stillValid.length > 0) {
            setResumeOffer({
              partIds: stillValid,
              lines: draft.lines.filter((l) => known.has(l.partId)),
              savedAt: draft.savedAt,
            });
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load your stocked parts.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const countable = useMemo(() => countableCandidates(candidates), [candidates]);
  const excluded = useMemo(() => excludedCandidates(candidates), [candidates]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? countable.filter((c) => c.partName.toLowerCase().includes(q)) : countable;
  }, [countable, search]);

  const sheetCandidates = useMemo(
    () => lines.map((l) => candidates.find((c) => c.partId === l.partId)).filter(Boolean) as CountCandidate[],
    [lines, candidates],
  );

  const tally = useMemo(() => countedTally(lines), [lines]);

  // ── Draft autosave ──────────────────────────────────────────────────────
  // Only while counting: a draft written at Review or after commit would resurrect a sheet
  // whose numbers are already applied.
  useEffect(() => {
    if (activeStep !== 1 || lines.length === 0) return;
    writeDraft(buildDraft(companyId, lines.map((l) => l.partId), lines, Date.now()));
  }, [activeStep, lines, companyId]);

  const clearDraft = useCallback(() => clearStoredDraft(companyId), [companyId]);

  // Leaving mid-count loses nothing (the draft is saved), but leaving mid-commit stops the
  // write loop partway with no way to tell which lines landed.
  useEffect(() => {
    if (!committing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [committing]);

  // ── Step transitions ────────────────────────────────────────────────────
  const startCounting = (ids: string[], existing?: CountLine[]) => {
    const byId = new Map(candidates.map((c) => [c.partId, c]));
    openedWithRef.current = new Map(ids.map((id) => [id, byId.get(id)?.systemQuantity ?? 0]));
    const priorByPart = new Map((existing ?? []).map((l) => [l.partId, l.counted]));
    setLines(ids.map((id) => ({ partId: id, counted: priorByPart.get(id) ?? null })));
    setActiveStep(1);
  };

  const goToReview = async () => {
    setRefreshing(true);
    try {
      const fresh = await refreshSystemQuantities(lines.map((l) => l.partId));
      const updated = candidates.map((c) =>
        fresh.has(c.partId) ? { ...c, systemQuantity: fresh.get(c.partId) as number } : c,
      );
      setCandidates(updated);
      setVariances(buildVariances(updated, lines, openedWithRef.current));
      setActiveStep(2);
    } catch (e) {
      setSnack({
        msg: e instanceof Error ? e.message : 'Could not re-check current quantities.',
        severity: 'error',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const toCommit = useMemo(() => committableVariances(variances), [variances]);
  const big = useMemo(() => bigVariances(variances), [variances]);
  const moved = useMemo(() => variances.filter((v) => v.movedSinceOpened), [variances]);

  const doCommit = async () => {
    setConfirmOpen(false);
    setCommitting(true);
    setProgress({ done: 0, total: toCommit.length, currentPartName: '' });
    try {
      const result = await commitCount(toCommit, setProgress);
      clearDraft();
      if (result.failures.length === 0) {
        setSnack({
          msg: `Counted ${result.committed} ${result.committed === 1 ? 'item' : 'items'}.`,
          severity: 'success',
        });
        router.push(`/dashboard/${companyId}/inventory`);
      } else {
        setSnack({
          msg: `Saved ${result.committed}. ${result.failures.length} could not be saved — ${result.failures[0].message}`,
          severity: 'error',
        });
      }
    } finally {
      setCommitting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 2 }}
      >
        Back to inventory
      </Button>

      <Stepper activeStep={activeStep} sx={{ mb: 4, maxWidth: 600 }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {loadError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {loadError}
        </Alert>
      )}

      {resumeOffer && activeStep === 0 && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                onClick={() => {
                  clearDraft();
                  setResumeOffer(null);
                }}
              >
                Discard
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  startCounting(resumeOffer.partIds, resumeOffer.lines);
                  setResumeOffer(null);
                }}
              >
                Resume
              </Button>
            </Stack>
          }
        >
          You have an unfinished count from{' '}
          {new Date(resumeOffer.savedAt).toLocaleString()} —{' '}
          {resumeOffer.lines.filter((l) => l.counted !== null).length} of {resumeOffer.partIds.length} counted.
        </Alert>
      )}

      {/* ── Step 1: scope ────────────────────────────────────────────────── */}
      {activeStep === 0 && (
        <Box>
          {countable.length === 0 ? (
            <Card elevation={2}>
              <CardContent sx={{ p: 6, textAlign: 'center' }}>
                <Inventory2OutlinedIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  Nothing to count yet
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Mark a few parts as stocked and they&apos;ll show up here.
                </Typography>
              </CardContent>
            </Card>
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                <TextField
                  placeholder="Search parts..."
                  size="small"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  sx={{ width: 300 }}
                />
                <Box sx={{ flex: 1 }} />
                <Button onClick={() => setSelectedIds(new Set(visible.map((c) => c.partId)))}>
                  Select all {visible.length !== countable.length ? 'shown' : ''}
                </Button>
                <Button
                  variant="contained"
                  disabled={selectedIds.size === 0}
                  onClick={() => startCounting(countable.filter((c) => selectedIds.has(c.partId)).map((c) => c.partId))}
                >
                  Count {selectedIds.size > 0 ? selectedIds.size : ''}{' '}
                  {selectedIds.size === 1 ? 'item' : 'items'}
                </Button>
              </Box>

              <Card elevation={2}>
                <Stack divider={<Divider />}>
                  {visible.map((c) => (
                    <Box
                      key={c.partId}
                      onClick={() =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.partId)) next.delete(c.partId);
                          else next.add(c.partId);
                          return next;
                        })
                      }
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        px: 2,
                        py: 1,
                        minHeight: 56,
                        cursor: 'pointer',
                        '&:hover': { bgcolor: 'action.hover' },
                      }}
                    >
                      <Checkbox checked={selectedIds.has(c.partId)} tabIndex={-1} />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body1" noWrap>
                          {c.partName}
                        </Typography>
                        {c.target.kind === 'location' && (
                          <Typography variant="caption" color="text.secondary">
                            {c.target.locationName}
                          </Typography>
                        )}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {num(c.systemQuantity)} {c.unit}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Card>

              {/* Parts held back, named rather than silently missing. */}
              {excluded.length > 0 && (
                <Alert severity="info" sx={{ mt: 3 }}>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    {excluded.length} {excluded.length === 1 ? 'part is' : 'parts are'} not on this
                    sheet — their stock sits in more than one place, so a single total has no
                    unambiguous home. Count these at their locations.
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    {excluded.slice(0, 8).map((c) => (
                      <Chip key={c.partId} size="small" variant="outlined" label={c.partName} />
                    ))}
                  </Box>
                </Alert>
              )}
            </>
          )}
        </Box>
      )}

      {/* ── Step 2: the sheet ────────────────────────────────────────────── */}
      {activeStep === 1 && (
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2, flexWrap: 'wrap' }}>
            <Typography variant="h6">
              {tally.counted} of {tally.total} counted
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Leave anything you don&apos;t count blank — it won&apos;t be changed.
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={tally.total ? (100 * tally.counted) / tally.total : 0}
            sx={{ height: 8, borderRadius: 4, mb: 3 }}
          />

          <Card elevation={2}>
            <Stack divider={<Divider />}>
              {sheetCandidates.map((c, i) => (
                <Box
                  key={c.partId}
                  sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.5, minHeight: 64 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body1" noWrap>
                      {c.partName}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      System says {num(c.systemQuantity)} {c.unit}
                      {c.target.kind === 'location' ? ` · ${c.target.locationName}` : ''}
                    </Typography>
                  </Box>
                  <TextField
                    label="Counted"
                    type="number"
                    size="small"
                    value={lines[i]?.counted ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setLines((prev) =>
                        prev.map((l, j) =>
                          j === i ? { ...l, counted: raw === '' ? null : Number(raw) } : l,
                        ),
                      );
                    }}
                    inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
                    sx={{ width: 130 }}
                  />
                </Box>
              ))}
            </Stack>
          </Card>

          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <Button onClick={() => setActiveStep(0)}>Back</Button>
            <Button
              variant="contained"
              size="large"
              disabled={tally.counted === 0 || refreshing}
              onClick={goToReview}
              startIcon={refreshing ? <CircularProgress size={16} /> : undefined}
            >
              {refreshing ? 'Checking current stock...' : 'Review'}
            </Button>
          </Box>
        </Box>
      )}

      {/* ── Step 3: review ───────────────────────────────────────────────── */}
      {activeStep === 2 && (
        <Box>
          {committing && progress ? (
            <Card elevation={2}>
              <CardContent sx={{ p: 4 }}>
                <Typography variant="h6" gutterBottom>
                  Saving your count
                </Typography>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    {progress.done} of {progress.total}
                    {progress.currentPartName ? ` · ${progress.currentPartName}` : ''}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={progress.total ? (100 * progress.done) / progress.total : 0}
                  sx={{ height: 8, borderRadius: 4 }}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <Alert severity={toCommit.length > 0 ? 'warning' : 'success'} sx={{ mb: 3 }}>
                {toCommit.length === 0
                  ? 'Everything you counted matches what the system already had — nothing to change.'
                  : `${toCommit.length} ${toCommit.length === 1 ? 'item needs' : 'items need'} adjusting. ${
                      variances.length - toCommit.length
                    } matched.`}
              </Alert>

              {moved.length > 0 && (
                <Alert severity="info" sx={{ mb: 3 }}>
                  {moved.length} {moved.length === 1 ? 'item' : 'items'} moved while you were
                  counting — the numbers below are current as of now.
                </Alert>
              )}

              {toCommit.length > 0 && (
                <Card elevation={2}>
                  <Stack divider={<Divider />}>
                    {toCommit.map((v) => (
                      <Box
                        key={v.candidate.partId}
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.5 }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body1" noWrap>
                            {v.candidate.partName}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {num(v.candidate.systemQuantity)} → {num(v.counted)} {v.candidate.unit}
                          </Typography>
                        </Box>
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: 600, color: v.delta > 0 ? 'success.main' : 'error.main' }}
                        >
                          {v.delta > 0 ? '+' : ''}
                          {num(v.delta)}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </Card>
              )}

              <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                <Button onClick={() => setActiveStep(1)}>Back to counting</Button>
                <Button
                  variant="contained"
                  size="large"
                  disabled={toCommit.length === 0}
                  onClick={() => (big.length > 0 ? setConfirmOpen(true) : doCommit())}
                >
                  Save {toCommit.length} {toCommit.length === 1 ? 'change' : 'changes'}
                </Button>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Big variances are usually miscounts, not real movement — worth one look. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>That&apos;s a big change — sure?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {big.length} {big.length === 1 ? 'item changes' : 'items change'} by more than half
            of what the system had. Worth a re-count if any of these look wrong.
          </DialogContentText>
          <Stack spacing={0.5}>
            {big.slice(0, 6).map((v) => (
              <Typography key={v.candidate.partId} variant="body2" color="text.secondary">
                <b>{v.candidate.partName}</b> — {num(v.candidate.systemQuantity)} →{' '}
                {num(v.counted)} {v.candidate.unit}
              </Typography>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button color="inherit" size="large" onClick={() => setConfirmOpen(false)}>
            Go back
          </Button>
          <Button variant="contained" size="large" onClick={doCommit}>
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snack}
        autoHideDuration={6000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snack?.severity ?? 'success'} onClose={() => setSnack(null)}>
          {snack?.msg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
