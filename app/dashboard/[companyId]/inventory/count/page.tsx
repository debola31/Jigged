'use client';

/**
 * Stock count sheet — journey J9 in docs/modules/inventory.md.
 *
 * TWO steps: choose what you're counting, then count it. Save opens a confirm dialog.
 *
 * Both halves of that shape were arrived at by getting it wrong first, so the reasoning is
 * worth keeping:
 *
 *  - It started as Scope → Sheet → **Review**. The review page restated deltas the counter
 *    would have understood better the instant they typed them, so it's gone — the variance now
 *    appears on the row as you type, and the dialog is the summary.
 *  - It was then rebuilt as a **single** page listing every stocked part. That over-corrected:
 *    a wall of empty inputs reads as "fill in this form", hides that counting one part is
 *    perfectly normal, and loses what choosing was quietly doing — making a count a bounded,
 *    finishable task. "I'm counting these five things" beats a row per stocked part.
 *
 * So the scope step earns its place; the review step didn't.
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
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckIcon from '@mui/icons-material/Check';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import {
  bigVariances,
  buildDraft,
  buildVariances,
  clearDraft as clearStoredDraft,
  committableVariances,
  countableCandidates,
  countedTally,
  excludedCandidates,
  isBigDelta,
  readDraft,
  rowDelta,
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
  CountEntries,
  CountVariance,
} from '@/types/inventoryCount';

const STEPS = ['Choose what to count', 'Count'];

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

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

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CountCandidate[]>([]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [entries, setEntries] = useState<CountEntries>({});
  const [search, setSearch] = useState('');

  /** System quantities as the sheet loaded — compared to a fresh read at save, so we can say
   *  which parts moved underneath the count. */
  const openedWithRef = useRef<Map<string, number>>(new Map());

  const [resume, setResume] = useState<{ partIds: string[]; entries: CountEntries; savedAt: number } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<CountVariance[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CountCommitProgress | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await loadCountCandidates(companyId);
        if (cancelled) return;
        setCandidates(found);
        openedWithRef.current = new Map(found.map((c) => [c.partId, c.systemQuantity]));

        // Offer a resume only for parts that still exist, so numbers can't reattach to the
        // wrong row after the catalogue changes.
        const draft = readDraft(companyId);
        if (draft) {
          const known = new Set(found.map((c) => c.partId));
          const partIds = draft.partIds.filter((id) => known.has(id));
          const kept = Object.fromEntries(
            Object.entries(draft.entries).filter(([id]) => known.has(id)),
          );
          if (partIds.length > 0) setResume({ partIds, entries: kept, savedAt: draft.savedAt });
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

  /** The chosen parts, in list order. */
  const sheet = useMemo(
    () => countable.filter((c) => selectedIds.includes(c.partId)),
    [countable, selectedIds],
  );

  const counted = countedTally(entries);
  const changes = useMemo(
    () =>
      sheet.filter((c) => {
        const d = rowDelta(c, entries);
        return d !== null && d !== 0;
      }).length,
    [sheet, entries],
  );

  // ── Draft autosave ──────────────────────────────────────────────────────
  // Only while counting: a draft written before a scope exists, or after commit, would offer
  // to resume something meaningless.
  useEffect(() => {
    if (step !== 1 || selectedIds.length === 0) return;
    writeDraft(buildDraft(companyId, selectedIds, entries, Date.now()));
  }, [step, selectedIds, entries, companyId]);

  const clearDraft = useCallback(() => clearStoredDraft(companyId), [companyId]);

  // Leaving mid-count loses nothing (the draft is saved), but leaving mid-save stops the write
  // loop partway with no way to tell which parts landed.
  useEffect(() => {
    if (!committing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [committing]);

  const toggle = (partId: string) =>
    setSelectedIds((prev) =>
      prev.includes(partId) ? prev.filter((id) => id !== partId) : [...prev, partId],
    );

  const setCount = (partId: string, raw: string) =>
    setEntries((prev) => {
      const next = { ...prev };
      if (raw === '') delete next[partId];
      else next[partId] = Number(raw);
      return next;
    });

  // ── Save ────────────────────────────────────────────────────────────────
  /** Re-read current quantities, then show what will change. The commit is safe either way
   *  (adjust sets absolutes), but confirming against a stale snapshot would mislead. */
  const startSave = async () => {
    setChecking(true);
    try {
      const fresh = await refreshSystemQuantities(Object.keys(entries));
      const updated = candidates.map((c) =>
        fresh.has(c.partId) ? { ...c, systemQuantity: fresh.get(c.partId) as number } : c,
      );
      setCandidates(updated);
      setConfirm(committableVariances(buildVariances(updated, entries, openedWithRef.current)));
    } catch (e) {
      setSnack({
        msg: e instanceof Error ? e.message : 'Could not re-check current quantities.',
        severity: 'error',
      });
    } finally {
      setChecking(false);
    }
  };

  const doCommit = async () => {
    const toCommit = confirm ?? [];
    setConfirm(null);
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

  const big = useMemo(() => (confirm ? bigVariances(confirm) : []), [confirm]);
  const moved = useMemo(() => (confirm ?? []).filter((v) => v.movedSinceOpened), [confirm]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (committing) {
    return (
      <Box sx={{ maxWidth: 560, mx: 'auto', mt: 6 }}>
        <Card elevation={2}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h6" gutterBottom>
              Saving your count
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {progress?.done ?? 0} of {progress?.total ?? 0}
                {progress?.currentPartName ? ` · ${progress.currentPartName}` : ''}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {progress?.total ? Math.round((100 * progress.done) / progress.total) : 0}%
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={progress?.total ? (100 * progress.done) / progress.total : 0}
              sx={{ height: 8, borderRadius: 4 }}
            />
          </CardContent>
        </Card>
      </Box>
    );
  }

  return (
    <Box sx={{ pb: step === 1 ? 12 : 4 }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 2 }}
      >
        Back to inventory
      </Button>

      <Stepper activeStep={step} sx={{ mb: 4, maxWidth: 460 }}>
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

      {resume && step === 0 && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                onClick={() => {
                  clearDraft();
                  setResume(null);
                }}
              >
                Discard
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  setSelectedIds(resume.partIds);
                  setEntries(resume.entries);
                  setResume(null);
                  setStep(1);
                }}
              >
                Resume
              </Button>
            </Stack>
          }
        >
          You have an unfinished count from {new Date(resume.savedAt).toLocaleString()} —{' '}
          {Object.keys(resume.entries).length} of {resume.partIds.length} counted.
        </Alert>
      )}

      {/* ── Step 1: what are you counting? ───────────────────────────────── */}
      {step === 0 && (
        <Box>
          <Typography variant="body1" sx={{ mb: 0.5 }}>
            Pick the parts you&apos;re about to count.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            One part or the whole shop — whatever you&apos;re walking right now. You can always
            count the rest later.
          </Typography>

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
                <Button onClick={() => setSelectedIds(visible.map((c) => c.partId))}>
                  Select all{visible.length !== countable.length ? ' shown' : ''}
                </Button>
                <Button
                  variant="contained"
                  size="large"
                  disabled={selectedIds.length === 0}
                  onClick={() => setStep(1)}
                >
                  {selectedIds.length === 0
                    ? 'Count'
                    : `Count ${selectedIds.length} ${selectedIds.length === 1 ? 'part' : 'parts'}`}
                </Button>
              </Box>

              <Card elevation={2}>
                <Stack divider={<Divider />}>
                  {visible.map((c) => (
                    <Box
                      key={c.partId}
                      onClick={() => toggle(c.partId)}
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
                      <Checkbox
                        checked={selectedIds.includes(c.partId)}
                        tabIndex={-1}
                        inputProps={{ 'aria-label': `Count ${c.partName}` }}
                      />
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

      {/* ── Step 2: count them ───────────────────────────────────────────── */}
      {step === 1 && (
        <Box>
          <Typography variant="body1" sx={{ mb: 0.5 }}>
            Enter what you actually have.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Anything you leave blank stays exactly as it is. Nothing saves until you press Save.
          </Typography>

          <Card elevation={2}>
            <Stack divider={<Divider />}>
              {sheet.map((c) => {
                const delta = rowDelta(c, entries);
                const isCounted = delta !== null;
                const matches = delta === 0;
                const bigChange = delta !== null && isBigDelta(c, delta);

                return (
                  <Box
                    key={c.partId}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      px: 2,
                      py: 1.5,
                      minHeight: 68,
                      // A counted row should read as done at a glance while scanning the list.
                      bgcolor: isCounted ? 'action.hover' : 'transparent',
                    }}
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

                    {/* The delta, the instant it's known — this is what the review page used
                        to do a screen later. */}
                    <Box sx={{ width: 108, textAlign: 'right' }}>
                      {isCounted &&
                        (matches ? (
                          <Chip
                            size="small"
                            icon={<CheckIcon />}
                            label="Matches"
                            color="success"
                            variant="outlined"
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 700,
                              color: bigChange
                                ? 'warning.main'
                                : (delta as number) > 0
                                  ? 'success.main'
                                  : 'error.main',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'flex-end',
                              gap: 0.5,
                            }}
                          >
                            {bigChange && <WarningAmberIcon fontSize="small" />}
                            {signed(delta as number)}
                          </Typography>
                        ))}
                    </Box>

                    <TextField
                      type="number"
                      size="small"
                      value={entries[c.partId] ?? ''}
                      onChange={(e) => setCount(c.partId, e.target.value)}
                      placeholder="—"
                      inputProps={{
                        min: 0,
                        step: 'any',
                        inputMode: 'decimal',
                        'aria-label': `Counted quantity for ${c.partName}`,
                        style: { textAlign: 'right' },
                      }}
                      InputProps={{
                        endAdornment: <InputAdornment position="end">{c.unit}</InputAdornment>,
                      }}
                      sx={{ width: 132 }}
                    />
                  </Box>
                );
              })}
            </Stack>
          </Card>
        </Box>
      )}

      {/* Sticky footer: progress and the only commit affordance. */}
      {step === 1 && (
        <Box
          sx={{
            position: 'fixed',
            bottom: 0,
            left: { xs: 0, md: 240 },
            right: 0,
            px: 3,
            py: 2,
            // The theme's `paper` is deliberately translucent (glassmorphism), which is fine
            // for a card sitting on the page and wrong for a bar with content scrolling under
            // it — rows showed straight through. Opaque base + the same blur the cards use.
            bgcolor: 'background.default',
            backgroundImage: (t) =>
              `linear-gradient(${t.palette.background.paper}, ${t.palette.background.paper})`,
            backdropFilter: 'blur(15px)',
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
            zIndex: (t) => t.zIndex.appBar - 1,
          }}
        >
          <Button onClick={() => setStep(0)}>Back</Button>
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            {counted} of {sheet.length} counted
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {changes === 0
              ? counted === 0
                ? 'Nothing entered yet'
                : 'Everything matches so far'
              : `${changes} will change`}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            size="large"
            disabled={changes === 0 || checking}
            onClick={startSave}
            startIcon={checking ? <CircularProgress size={16} /> : undefined}
          >
            {checking ? 'Checking...' : `Save ${changes} ${changes === 1 ? 'change' : 'changes'}`}
          </Button>
        </Box>
      )}

      {/* The old Review page, compressed into the moment it's useful. */}
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {big.length > 0
            ? `Save ${confirm?.length} ${confirm?.length === 1 ? 'change' : 'changes'}? Some are big.`
            : `Save ${confirm?.length} ${confirm?.length === 1 ? 'change' : 'changes'}?`}
        </DialogTitle>
        <DialogContent>
          {moved.length > 0 && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {moved.length} {moved.length === 1 ? 'item' : 'items'} moved while you were
              counting — these are current as of now.
            </Alert>
          )}
          {big.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {big.length} {big.length === 1 ? 'change is' : 'changes are'} more than half of
              what the system had. Worth a re-count if any look wrong.
            </Alert>
          )}
          <Stack divider={<Divider />}>
            {(confirm ?? []).map((v) => (
              <Box
                key={v.candidate.partId}
                sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {v.candidate.partName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {num(v.candidate.systemQuantity)} → {num(v.counted)} {v.candidate.unit}
                  </Typography>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, color: v.delta > 0 ? 'success.main' : 'error.main' }}
                >
                  {signed(v.delta)}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button color="inherit" size="large" onClick={() => setConfirm(null)}>
            Keep counting
          </Button>
          <Button variant="contained" size="large" onClick={doCommit}>
            Save
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
