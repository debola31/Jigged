'use client';

/**
 * Stock count sheet — journey J9 in docs/modules/inventory.md.
 *
 * ONE page. You land on your stocked parts and type what you actually have; the delta appears
 * on the row as you type, and Save opens a single confirm dialog.
 *
 * An earlier build was Scope → Sheet → Review. Three problems, all from speccing the data flow
 * and not the interaction:
 *  - the scope step made you declare what you'd count *before* counting — structure before
 *    value, the same mistake §5.5 diagnoses in the location builder. Physically you walk to a
 *    shelf and write down what's there; the set emerges from the counting.
 *  - the review page restated deltas you'd have understood better the instant you typed them.
 *  - the count field didn't read as a field.
 *
 * So: no scope gate, inline deltas, dash placeholder in an obviously-empty input, and plain
 * language instead of "1 item needs adjusting. 0 matched."
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
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

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CountCandidate[]>([]);
  const [entries, setEntries] = useState<CountEntries>({});
  const [search, setSearch] = useState('');
  const [resumedAt, setResumedAt] = useState<number | null>(null);

  /** System quantities as the sheet loaded — compared to a fresh read at save, so we can say
   *  which parts moved underneath the count. */
  const openedWithRef = useRef<Map<string, number>>(new Map());

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

        // Restore only entries whose part still exists, so numbers can't reattach to the
        // wrong row after the catalogue changes.
        const draft = readDraft(companyId);
        if (draft) {
          const known = new Set(found.map((c) => c.partId));
          const restored = Object.fromEntries(
            Object.entries(draft.entries).filter(([partId]) => known.has(partId)),
          );
          if (Object.keys(restored).length > 0) {
            setEntries(restored);
            setResumedAt(draft.savedAt);
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

  const counted = countedTally(entries);
  const changes = useMemo(
    () =>
      countable.filter((c) => {
        const d = rowDelta(c, entries);
        return d !== null && d !== 0;
      }).length,
    [countable, entries],
  );

  // ── Draft autosave ──────────────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    if (counted === 0) return;
    writeDraft(buildDraft(companyId, entries, Date.now()));
  }, [entries, counted, companyId, loading]);

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

  const setCount = (partId: string, raw: string) => {
    setEntries((prev) => {
      const next = { ...prev };
      if (raw === '') delete next[partId];
      else next[partId] = Number(raw);
      return next;
    });
  };

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
    <Box sx={{ pb: 12 }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 2 }}
      >
        Back to inventory
      </Button>

      {/* Say what this is. The old build dropped you straight into a checkbox list. */}
      <Typography variant="body1" sx={{ mb: 0.5 }}>
        Walk your shop and enter what you actually have.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Anything you leave blank stays exactly as it is. Nothing saves until you press Save.
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {loadError}
        </Alert>
      )}

      {resumedAt && (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Button
              size="small"
              onClick={() => {
                setEntries({});
                setResumedAt(null);
                clearDraft();
              }}
            >
              Start over
            </Button>
          }
        >
          Picked up your unfinished count from {new Date(resumedAt).toLocaleString()}.
        </Alert>
      )}

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
          <TextField
            placeholder="Search parts..."
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: 300, mb: 3 }}
          />

          <Card elevation={2}>
            <Stack divider={<Divider />}>
              {visible.map((c) => {
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

      {/* Sticky footer: progress and the only commit affordance on the page. */}
      {countable.length > 0 && (
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
            backgroundImage: (t) => `linear-gradient(${t.palette.background.paper}, ${t.palette.background.paper})`,
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
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            {counted} counted
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
