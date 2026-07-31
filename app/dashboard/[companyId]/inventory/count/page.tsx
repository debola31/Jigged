'use client';

/**
 * Inventory count sheet — journey J9 in docs/modules/inventory.md.
 *
 * "Inventory", not "stock": the nav item is Inventory, so a second word for the same thing is
 * one the user has to learn for no gain. ("Stocked" stays — that's the per-part flag, a real
 * distinct concept with its own switch on the part form.)
 *
 * TWO steps: choose what you're counting, then count it. Save commits — nothing in between.
 *
 * That shape was arrived at by getting it wrong three times, so the reasoning is worth keeping:
 *
 *  - It started as Scope → Sheet → **Review**. The review page restated deltas the counter
 *    would have understood better the instant they typed them, so it's gone — the variance now
 *    appears on the row as you type.
 *  - It was then rebuilt as a **single** page listing every stocked part. That over-corrected:
 *    a wall of empty inputs reads as "fill in this form", hides that counting one part is
 *    perfectly normal, and loses what choosing was quietly doing — making a count a bounded,
 *    finishable task. "I'm counting these five things" beats a row per stocked part.
 *  - Review then came back as a **confirm dialog**, which turned out to be the same mistake in
 *    a smaller box: it showed rows still visible behind it, and its big-change warning fired on
 *    nearly every line. Removed. See `save()`.
 *
 * So the scope step earns its place; restating the count before saving it never did.
 *
 * ## Two ways in, one worksheet
 *
 * With no `?location=`, this is the company-wide sheet described above: pick parts across the shop.
 *
 * With `?location=<id>`, it is **place-scoped**, which is what §5.11 asked for all along — you walk
 * a shop bin by bin, not part by part. Three things change, and they're all consequences of
 * standing at one place rather than looking at the whole catalogue:
 *
 *  - **Nothing is excluded.** Company-wide, a part split across bins can't be counted item-by-item
 *    (count 38 against 10+20+10 and no bin defensibly absorbs the −2). At one bin that ambiguity
 *    doesn't exist, so the parts the other sheet has to name and skip are countable here.
 *  - **Search runs on the server**, because `Unassigned` holds every part a real shop owns and you
 *    cannot filter 9,428 rows in the browser.
 *  - **You can put things away.** Alongside "Count N parts" there's "Move N to…", because the other
 *    thing you do standing at a bin is notice something doesn't belong there. That single addition
 *    is what makes this the put-away tool — at `Unassigned`, this screen *is* how a shop empties
 *    the pile that `trg_auto_track_stocked_part` created.
 *
 * The two write paths stay deliberately different. Counting commits line-by-line and reports
 * per-line failures, because line 50 failing must not invalidate lines 1–49. A move is one atomic
 * RPC, because a half-moved pile is worse than no move — you can't tell what you already did.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import {
  buildDraft,
  buildVariances,
  clearDraft as clearStoredDraft,
  committableVariances,
  countableCandidates,
  commonUnit,
  countedTally,
  excludedCandidates,
  readDraft,
  rowDelta,
  writeDraft,
} from '@/lib/inventoryCountPlan';
import {
  commitCount,
  loadCountCandidates,
  loadLocationCountCandidates,
  refreshLocationQuantities,
  refreshSystemQuantities,
} from '@/utils/inventoryCountAccess';
import {
  PUT_AWAY_MAX,
  bulkPutAway,
  createLocation,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import LocationScanner from '@/components/scanner/LocationScanner';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import type { InventoryLocation } from '@/types/inventoryLocations';
import type {
  CountCandidate,
  CountCommitProgress,
  CountEntries,
  CountVariance,
} from '@/types/inventoryCount';

const STEPS = ['Choose what to count', 'Count'];

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** Column headers: quiet, so the figures carry the row. */
const HEAD_SX = {
  fontSize: 11,
  letterSpacing: '0.09em',
  textTransform: 'uppercase' as const,
  color: 'text.secondary',
  fontWeight: 600,
  whiteSpace: 'nowrap' as const,
};

/** Digits must line up column-to-column — that alignment is the whole point of this layout. */
const NUM_SX = { fontVariantNumeric: 'tabular-nums' as const };
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

export default function InventoryCountPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const { features, loading: featuresLoading } = useCompanyFeatures();

  /**
   * Where "back" goes depends on where counting is entered from, and that differs by flag.
   *
   * With locations ON there are two entry points and both are the board — `Count everything` in its
   * toolbar, and `Count what's here` on a tile's sheet. With locations OFF there is no board at all
   * (the Storage nav item is hidden and `/inventory/locations` redirects), so the only entry point
   * is `Count Inventory` on the **Parts** toolbar.
   *
   * This used to be a single hardcoded push to `/dashboard/{id}/inventory`, which now redirects to
   * Parts — so a user who arrived from Storage was silently dumped on a different page than the one
   * they left. Labelling it "Back to storage" without this branch would just move the bug: it would
   * send flag-off shops to a page that redirects them straight back out.
   */
  const backTo = features.inventory_locations
    ? { href: `/dashboard/${companyId}/inventory/locations`, label: 'Back to storage' }
    : { href: `/dashboard/${companyId}/parts`, label: 'Back to parts' };

  /** `?location=<id>` switches the whole sheet to place-scoped. See the module comment. */
  const locationId = searchParams.get('location');
  const locationMode = Boolean(locationId);

  const [locationName, setLocationName] = useState('');
  const [allLocations, setAllLocations] = useState<InventoryLocation[]>([]);

  // Without this the Header falls back to "Inventory Details" for any unrecognised
  // /inventory/* route, which is both wrong and confusing mid-count.
  const { setTitle } = usePageTitle();
  useEffect(() => {
    setTitle(locationMode && locationName ? `Count ${locationName}` : 'Count Inventory');
    return () => setTitle(null);
  }, [setTitle, locationMode, locationName]);

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CountCandidate[]>([]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [entries, setEntries] = useState<CountEntries>({});
  const [search, setSearch] = useState('');

  /**
   * The search term the server has been asked about.
   *
   * Place-scoped mode filters server-side, so the raw keystrokes are debounced into this before
   * becoming a request. Company-wide mode filters `countable` in memory and ignores it.
   */
  const [serverSearch, setServerSearch] = useState('');

  /** Parts held at this location in total — may exceed the page, so the UI can say so. */
  const [hereTotal, setHereTotal] = useState(0);

  /** Put-away state: the destination, and whether a move is in flight. */
  const [moveTo, setMoveTo] = useState<LocationPickerOption | null>(null);
  const [moving, setMoving] = useState(false);
  const [scanningDest, setScanningDest] = useState(false);

  /** System quantities as the sheet loaded — compared to a fresh read at save, so we can say
   *  which parts moved underneath the count. */
  const openedWithRef = useRef<Map<string, number>>(new Map());

  const [resume, setResume] = useState<{ partIds: string[]; entries: CountEntries; savedAt: number } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CountCommitProgress | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Place-scoped: read one page of THIS bin's contents. `serverSearch` is a dependency, so
        // typing re-runs this against the server — `Unassigned` holds every part a shop owns and
        // cannot be filtered in the browser.
        if (locationId) {
          const locations = await getLocations(companyId);
          if (cancelled) return;
          const here = locations.find((l) => l.id === locationId);
          if (!here) {
            setLoadError('That location no longer exists.');
            return;
          }
          setAllLocations(locations);
          setLocationName(here.name);

          const { candidates: found, total } = await loadLocationCountCandidates(
            locationId,
            here.name,
            { search: serverSearch },
          );
          if (cancelled) return;
          setCandidates(found);
          setHereTotal(total);
          openedWithRef.current = new Map(found.map((c) => [c.partId, c.systemQuantity]));
          return;
        }

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
  }, [companyId, locationId, serverSearch]);

  // Debounce keystrokes into the server-side term. Only place-scoped mode reads it, but the timer
  // is unconditional so the two modes don't need different effect shapes.
  useEffect(() => {
    const id = setTimeout(() => setServerSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const countable = useMemo(() => countableCandidates(candidates), [candidates]);
  const excluded = useMemo(() => excludedCandidates(candidates), [candidates]);

  const visible = useMemo(() => {
    // Already filtered by the server in place-scoped mode; re-filtering here would hide rows
    // while a debounced request was still in flight.
    if (locationMode) return countable;
    const q = search.trim().toLowerCase();
    return q ? countable.filter((c) => c.partName.toLowerCase().includes(q)) : countable;
  }, [countable, search, locationMode]);

  /** The chosen parts, in list order. */
  const sheet = useMemo(
    () => countable.filter((c) => selectedIds.includes(c.partId)),
    [countable, selectedIds],
  );

  /** One unit for the whole sheet, or null when mixed — decides footer vs per-row. */
  const sheetUnit = useMemo(() => commonUnit(sheet), [sheet]);

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
  /**
   * Save commits. There is no confirm step.
   *
   * There was one, and it was removed: it restated the very rows the counter had just typed and
   * could still see, and its "some of these are big" callout fired on nearly every line —
   * against the quantities a shop actually holds (7 on hand, 3 found), a proportional threshold
   * flags almost everything, so the warning carried no information. A dialog that always says
   * the same thing trains people to dismiss it, which is worse than not asking.
   *
   * Nothing here is destructive or hard to undo: a wrong count is fixed by counting again, and
   * every line leaves an `adjustment` row naming both numbers.
   *
   * Quantities are still re-read first. The commit is correct either way (adjust sets
   * absolutes), but `countNote` records "system said X" — without the refresh that X could be
   * a stale number, and the ledger would be quietly wrong.
   */
  const save = async () => {
    setChecking(true);
    let toCommit: CountVariance[];
    try {
      // Place-scoped counts must re-read the balance AT THIS BIN. `refreshSystemQuantities` reads
      // `parts.quantity`, the roll-up across every location — using it here would compare a shelf
      // count against the whole shop's total and report a variance on every line.
      const fresh = locationId
        ? await refreshLocationQuantities(locationId, Object.keys(entries))
        : await refreshSystemQuantities(Object.keys(entries));
      const updated = candidates.map((c) =>
        fresh.has(c.partId) ? { ...c, systemQuantity: fresh.get(c.partId) as number } : c,
      );
      setCandidates(updated);
      toCommit = committableVariances(buildVariances(updated, entries, openedWithRef.current));
    } catch (e) {
      setSnack({
        msg: e instanceof Error ? e.message : 'Could not re-check current quantities.',
        severity: 'error',
      });
      return;
    } finally {
      setChecking(false);
    }

    // The refresh can empty this: someone else may have already set a part to what you counted.
    if (toCommit.length === 0) {
      clearDraft();
      setSnack({ msg: 'Everything already matches — nothing to save.', severity: 'success' });
      router.push(`/dashboard/${companyId}/inventory`);
      return;
    }

    setCommitting(true);
    setProgress({ done: 0, total: toCommit.length, currentPartName: '' });
    try {
      const result = await commitCount(toCommit, setProgress);
      clearDraft();
      if (result.failures.length === 0) {
        const moved = toCommit.filter((v) => v.movedSinceOpened).length;
        setSnack({
          msg:
            `Counted ${result.committed} ${result.committed === 1 ? 'item' : 'items'}.` +
            // Said after the fact rather than as a prompt — the count is what's on the shelf,
            // so a mid-count movement changes nothing about what to save.
            (moved > 0
              ? ` ${moved} ${moved === 1 ? 'item' : 'items'} moved while you were counting; your count is what's saved.`
              : ''),
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

  // ── Put away ────────────────────────────────────────────────────────────
  /**
   * Send every selected part's whole balance to one place.
   *
   * One atomic RPC, deliberately unlike `save()`'s line-by-line commit: a count is a set of
   * independent observations, so line 50 failing mustn't undo lines 1–49 — but a half-moved pile
   * is worse than no move at all, because you can't tell what you already did.
   */
  const putAway = async () => {
    if (!locationId || !moveTo || selectedIds.length === 0) return;
    setMoving(true);
    try {
      const res = await bulkPutAway(locationId, moveTo.id, selectedIds);

      // Refetch from the START. These parts have just left this location, so the result set
      // shifted — holding the previous page's offset would silently skip whatever moved up.
      setSelectedIds([]);
      setEntries({});
      setMoveTo(null);
      const { candidates: found, total } = await loadLocationCountCandidates(
        locationId,
        locationName,
        { search: serverSearch },
      );
      setCandidates(found);
      setHereTotal(total);
      openedWithRef.current = new Map(found.map((c) => [c.partId, c.systemQuantity]));

      setSnack({
        msg:
          `Put ${res.moved} ${res.moved === 1 ? 'part' : 'parts'} away in ${moveTo.label}.` +
          // Skipped means "nothing here to move" — a zero balance, which every stocked part has at
          // Unassigned whether or not it holds anything. Worth saying, not worth alarm.
          (res.skipped > 0 ? ` ${res.skipped} had nothing here to move.` : ''),
        severity: 'success',
      });
    } catch (e) {
      setSnack({
        msg: friendlyErrorMessage(e, { entity: 'stock', fallback: 'Could not put these away.' }),
        severity: 'error',
      });
    } finally {
      setMoving(false);
    }
  };

  /** Every location, for the destination picker. Only loaded in place-scoped mode. */
  const destinationOptions = useMemo<LocationPickerOption[]>(() => {
    const byId = new Map(allLocations.map((l) => [l.id, l] as const));
    const pathOf = (id: string): string => {
      const names: string[] = [];
      let cursor: string | null = id;
      const guard = new Set<string>();
      while (cursor && byId.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        const n: InventoryLocation = byId.get(cursor)!;
        names.unshift(n.name);
        cursor = n.parent_id;
      }
      return names.join(' › ');
    };
    return allLocations
      .map((l) => ({ id: l.id, label: pathOf(l.id), kind: l.kind }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allLocations]);

  const createDestination = async (name: string): Promise<LocationPickerOption> => {
    const created = await createLocation(companyId, { name });
    setAllLocations((prev) => [...prev, created]);
    return { id: created.id, label: created.name, kind: created.kind };
  };

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
      {/* Hidden until the flag resolves rather than guessing a destination — an unresolved
          `features` object reads as flag-off, so a default would render "Back to parts" and then
          swap to "Back to storage", which is the same appear-then-change flicker the Parts toolbar
          had to fix. A back button that changes where it goes is worse than one that arrives late. */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(backTo.href)}
        sx={{ mb: 2, visibility: featuresLoading ? 'hidden' : 'visible' }}
      >
        {backTo.label}
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
            {locationMode
              ? `What's in ${locationName}?`
              : 'Pick the parts you’re about to count.'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {locationMode
              ? 'Tick what you’re counting — or what doesn’t belong here, and send it somewhere else.'
              : 'One part or the whole shop — whatever you’re walking right now. You can always count the rest later.'}
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
                  placeholder={locationMode ? 'Search what’s here…' : 'Search parts...'}
                  size="small"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  sx={{ width: 300 }}
                />
                <Box sx={{ flex: 1 }} />
                <Button
                  onClick={() => setSelectedIds(visible.map((c) => c.partId))}
                  // The RPC refuses more than PUT_AWAY_MAX to bound how long it holds row locks.
                  // Say so here rather than letting someone select 2,000 and be told no.
                  disabled={visible.length > PUT_AWAY_MAX}
                >
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

              {/* ── Put away: the other thing you do standing at a bin ─────────── */}
              {locationMode && (
                <Card elevation={2} sx={{ mb: 3 }}>
                  <CardContent
                    sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}
                  >
                    <Box sx={{ minWidth: 260, flex: 1 }}>
                      <LocationPicker
                        label="Send the ticked parts to…"
                        options={destinationOptions}
                        value={moveTo}
                        onChange={setMoveTo}
                        excludeId={locationId}
                        excludeSystem
                        disabled={moving}
                        onCreate={createDestination}
                        helperText={
                          selectedIds.length === 0
                            ? 'Tick something above first.'
                            : `Moves everything each part has here — ${selectedIds.length} ${
                                selectedIds.length === 1 ? 'part' : 'parts'
                              }.`
                        }
                      />
                    </Box>
                    {/* Standing at the shelf you're filling, its label is right in front of you —
                        which is exactly the continuous-scan case §5.10 says the camera-app round
                        trip can't serve. */}
                    <Tooltip title="Scan the destination label">
                      <IconButton
                        sx={{ mt: 1.5 }}
                        onClick={() => setScanningDest(true)}
                        disabled={moving}
                        aria-label="Scan the destination label"
                      >
                        <QrCodeScannerIcon />
                      </IconButton>
                    </Tooltip>
                    <Button
                      variant="outlined"
                      size="large"
                      sx={{ mt: 1 }}
                      disabled={moving || !moveTo || selectedIds.length === 0}
                      onClick={putAway}
                    >
                      {moving
                        ? 'Putting away…'
                        : `Put ${selectedIds.length || ''} away`.replace('  ', ' ')}
                    </Button>
                  </CardContent>
                </Card>
              )}

              <LocationScanner
                open={scanningDest}
                onClose={() => setScanningDest(false)}
                title="Scan where these are going"
                onScan={(scannedId) => {
                  const dest = destinationOptions.find((o) => o.id === scannedId);
                  // Not one of ours, or it's the bin we're standing at — either way, keep scanning
                  // rather than silently picking a destination the RPC would reject.
                  if (!dest || scannedId === locationId || dest.kind === SYSTEM_KIND) return false;
                  setMoveTo(dest);
                  setScanningDest(false);
                }}
              />

              {/* The page is capped, and `Unassigned` on a real shop holds every part they own —
                  so say what isn't shown rather than presenting a page as the whole bin. */}
              {locationMode && hereTotal > countable.length && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Showing {countable.length} of {num(hereTotal)} parts here. Search to narrow it
                  down — putting a batch away removes it from this list.
                </Alert>
              )}

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
                        {/* Company-wide, the location tells you where this row will be written.
                            Place-scoped it's the same word on every row — the page title already
                            said it — so it's noise. */}
                        {!locationMode && c.target.kind === 'location' && (
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

              {/*
                Parts held back — and now reachable, which is the difference between naming
                a limitation and leaving a dead end.

                The copy already said "count these at their locations"; the chips were inert,
                so it was an instruction with nowhere to follow. Each place is now a link to
                its own worksheet, where the part IS countable: "Shelf A holds 830" adjusts
                Shelf A and says nothing about Shelf B. The capability always existed — only
                the route was missing.
              */}
              {excluded.length > 0 && (
                <Alert severity="info" sx={{ mt: 3 }}>
                  <Typography variant="body2" sx={{ mb: 1.5 }}>
                    {excluded.length} {excluded.length === 1 ? 'part is' : 'parts are'} not on this
                    sheet — their stock sits in more than one place, so a single total has no
                    unambiguous home. Count them where they actually are:
                  </Typography>
                  <Stack spacing={1}>
                    {excluded.slice(0, 8).map((c) => (
                      <Box
                        key={c.partId}
                        sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {c.partName}
                        </Typography>
                        {c.target.kind === 'excluded' &&
                          c.target.locations.map((l) => (
                            <Chip
                              key={l.id}
                              size="small"
                              variant="outlined"
                              clickable
                              label={l.name}
                              onClick={() =>
                                router.push(
                                  `/dashboard/${companyId}/inventory/count?location=${l.id}`,
                                )
                              }
                            />
                          ))}
                      </Box>
                    ))}
                  </Stack>
                  {excluded.length > 8 && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      …and {excluded.length - 8} more.
                    </Typography>
                  )}
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

          {/* A count sheet, with the columns every stocktake system converges on — and the
              ones a shop already knows from a clipboard. Aligned tabular figures are what
              makes an outlier visible without reading a single label; the old prose row
              ("System says 5 each") buried the comparison inside a sentence. */}
          <Card elevation={2}>
            <TableContainer>
              <Table size="small" sx={{ minWidth: 560 }}>
                {/* "Recorded" and "Counted", not "On hand" and "Counted". Both columns are
                    quantities on hand — the only thing separating them is where the number came
                    from, so that is what the headers have to say. "On hand" read as the physical
                    count, which is the neighbouring column.
                    "Change", not "Variance": the footer already says "2 will change" and the
                    button "Save 2 changes", so Variance was the one place this page used a
                    different word for the same number — and the least spoken one. */}
                <TableHead>
                  <TableRow>
                    <TableCell sx={HEAD_SX}>Part</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>
                      Recorded
                    </TableCell>
                    <TableCell align="right" sx={HEAD_SX}>
                      Counted
                    </TableCell>
                    {!sheetUnit && (
                      <TableCell align="right" sx={HEAD_SX}>
                        Unit
                      </TableCell>
                    )}
                    <TableCell align="right" sx={HEAD_SX}>
                      Change
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sheet.map((c) => {
                    const delta = rowDelta(c, entries);
                    const isCounted = delta !== null;
                    const matches = delta === 0;

                    // No row-level "done" tint: the variance cell already says whether a row
                    // has been actioned, and tinting the ground behind the figures only costs
                    // them contrast.
                    return (
                      <TableRow key={c.partId}>
                        <TableCell sx={{ width: '99%' }}>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {c.partName}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {c.description ??
                              (c.target.kind === 'location' ? c.target.locationName : '')}
                          </Typography>
                        </TableCell>

                        <TableCell align="right" sx={{ ...NUM_SX, color: 'text.secondary' }}>
                          {num(c.systemQuantity)}
                        </TableCell>

                        <TableCell align="right" sx={{ py: 1 }}>
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
                              style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                            }}
                            sx={{ width: 108 }}
                          />
                        </TableCell>

                        {/* Only when the sheet is mixed — otherwise the unit is said once, in
                            the footer, instead of repeating down every row. */}
                        {!sheetUnit && (
                          <TableCell align="right" sx={{ color: 'text.secondary' }}>
                            <Typography variant="caption">{c.unit}</Typography>
                          </TableCell>
                        )}

                        {/* Direction, and nothing else: green up, red down, neutral for no
                            change. No per-row warning glyph — on the small quantities a shop
                            actually counts, a proportional threshold fires on almost every
                            line, and a column of cautions is indistinguishable from none. The
                            large-change check still runs once, at the save confirm, where it
                            can be read against the whole batch. */}
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {isCounted &&
                            (matches ? (
                              <Typography
                                component="span"
                                variant="body2"
                                sx={{ color: 'text.disabled' }}
                              >
                                No change
                              </Typography>
                            ) : (
                              <Typography
                                component="span"
                                variant="body2"
                                sx={{
                                  ...NUM_SX,
                                  fontWeight: 700,
                                  color: (delta as number) > 0 ? 'success.main' : 'error.main',
                                }}
                              >
                                {signed(delta as number)}
                              </Typography>
                            ))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
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
            {sheetUnit ? ` · all in ${sheetUnit}` : ''}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            size="large"
            disabled={changes === 0 || checking}
            onClick={save}
            startIcon={checking ? <CircularProgress size={16} /> : undefined}
          >
            {checking ? 'Checking...' : `Save ${changes} ${changes === 1 ? 'change' : 'changes'}`}
          </Button>
        </Box>
      )}

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
