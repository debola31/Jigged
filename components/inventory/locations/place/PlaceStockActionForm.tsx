'use client';

/**
 * Add · Remove · Move, standing at one place — several parts at a time.
 *
 * ## A section inside the place drawer, not a page and not a dialog
 *
 * It was a `Dialog` first — which would have stacked a surface on a surface, the exact thing that
 * made `Manage` cover the cabinet you were acting on. Then it was a *view* the drawer swapped to,
 * which was one layer but still cost the contents list, the history and the other three verbs off
 * screen to type one quantity. It opens **in place, under the button that opened it**.
 *
 * ## Several rows, because one at a time was the wrong unit of work
 *
 * `Adjust` had always taken a number per part — you walk to a shelf and count what is on it, not
 * one item on it. The other three were single-part, so putting a delivery of six things away meant
 * six openings of the same form, and emptying the put-away pile meant one part per trip. They now
 * take **a quantity per row**, exactly like Adjust: same table, same rule that a blank row is not
 * an instruction.
 *
 * ## Why this exists at all
 *
 * The Storage tab could not move stock. `Count or put away` was one button that navigated to the
 * count worksheet — which counts, and which can move a selection *out* of a bin. So from Storage
 * you could audit a place and empty it, and you could not put anything into it. Every real stock
 * write lived either on the operator's phone or on a part's own page, both of which are
 * **part-first**: you find the part, then say where. Standing at a cabinet you have the opposite
 * information — you know the place and are looking for the part.
 *
 * ## The four verbs are the four ledger types, and that is the whole vocabulary
 *
 * | Button   | RPC                        | Row written  |
 * |----------|----------------------------|--------------|
 * | Add      | `add_stock_at_location`     | `addition`   |
 * | Remove   | `deplete_stock_at_location` | `depletion`  |
 * | Move     | `transfer_stock`            | `transfer`   |
 * | Adjust   | `adjust_stock_at_location`  | `adjustment` |
 *
 * Nothing else exists. **`Count` and `Put away` were never separate actions** — a count commits one
 * `adjustStockAtLocation` per line (`commitCount`), and put-away is `bulk_put_away` writing ordinary
 * transfer pairs. They are batch *forms* of two of the four.
 *
 * ## One transfer per row, and why that does not break the atomicity rule
 *
 * The count worksheet's put-away is deliberately **one atomic RPC** — `bulk_put_away` — and records
 * its reason: *"a half-moved pile is worse than no move, because you can't tell what you already
 * did."* That objection is about **not knowing**, and it is answered here rather than ignored: this
 * commits row by row and names every row that failed, beside the count that landed. Each
 * `transfer_stock` is itself atomic, so no single part is ever left half-moved; the only partial
 * state is "these four went, this one did not", which is stated on screen.
 *
 * It also cannot use `bulk_put_away`, which moves **whole balances** by part id and has nowhere to
 * put a quantity. Taking three of the twelve on a shelf is the ordinary case here. The worksheet
 * keeps the atomic whole-balance version for the job it was built for.
 *
 * ## When the bin holds a lot
 *
 * `Remove` and `Move` list everything at the place, which is right for the three-part bin that is
 * the normal case and wrong for the put-away pile — measured at 57 rows at one real shop. Above
 * eight rows a filter appears, and **a row you have typed into is exempt from it**. That exemption
 * is the whole safety of the feature: `lines` is derived from every row, because the blank-row rule
 * requires it, so a filter that could hide a typed row would be a way to write something you cannot
 * see. Nothing reorders either — a row stays where it loaded whether you type in it or not, because
 * a list that rearranges under a person mid-count is a second way to lose your place.
 *
 * ## `All`, and why only two verbs get it
 *
 * Emptying a bin should not mean typing `2,099` correctly. `Remove` and `Move` get an **All** on
 * every row, and an `Everything here` above the list for the whole-bin case — because for those two
 * "all" is a number the system already knows: the amount on hand.
 *
 * **`Adjust` deliberately gets neither.** Its equivalent value is `0`, and calling zero "all" is the
 * opposite word for the same button. It would also save nothing — `0` is one character where
 * `2,099` is five and has to match — and a one-tap way to zero an entire shelf is the most
 * destructive thing in this module, which is not what a convenience button should be. The audit's
 * other reading, *"everything matches what we thought"*, is not worth a button either: the worksheet
 * drops zero-delta lines, so it would be a control that writes nothing.
 *
 * **`All` fills the field; it is not a mode.** No "everything" flag reaches the write path — the
 * number lands in the input where you can see it, change it, and read it back before submitting.
 * One write path, and the quantity you are about to commit is always on screen as a number.
 *
 * ## Which parts each verb offers
 *
 * `Remove` and `Move` can only touch what is **here**, so their rows ARE the bin's contents: you
 * cannot take out what is not in the drawer. `Add` has no such list — the catalogue is unbounded —
 * so its rows are built by picking parts, including ones already here. The operator's receive flow
 * excludes those because a phone user tops up from the part's own card; here there is no card to
 * tap, and excluding them would make the common case (more of what is already in the bin) the one
 * thing the button cannot do.
 */

import { useMemo, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';

import ErrorAlert from '@/components/common/ErrorAlert';
import JobTagPicker, { loadJobsForPart, loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import { getStockedParts } from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import {
  addStockAtLocation,
  depleteStockAtLocation,
  getLocationContents,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { useLoad } from '@/hooks/useLoad';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import type { JobWithRelations } from '@/types/job';

/** The three verbs that act on stock at one place. `adjust` has its own form. */
export type PlaceStockAction = 'add' | 'deplete' | 'move';

const TITLES: Record<PlaceStockAction, string> = {
  add: 'Add stock here',
  deplete: 'Remove stock from here',
  move: 'Move stock somewhere else',
};

/**
 * The submit, named with its noun.
 *
 * Bare `Add` collided with the toggle that opened this section — two buttons reading `Add` on one
 * page, one of which opens a form and one of which writes a ledger row. The noun costs four
 * characters and removes the question.
 */
const SUBMIT: Record<PlaceStockAction, string> = {
  add: 'Add stock',
  deplete: 'Remove stock',
  move: 'Move stock',
};

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** Rows above which a filter earns its place. Matches the unit-level drawer's own threshold. */
const FILTER_FROM = 8;

/** One line of the form: a part, and how much of it. `onHand` is null when it is not here yet. */
interface Row {
  partId: string;
  partName: string;
  primaryUnit: string;
  onHand: number | null;
}

export interface PlaceStockActionFormProps {
  action: PlaceStockAction;
  companyId: string;
  /** The place being acted on. Fixed — this is the whole point of the component. */
  locationId: string;
  locationName: string;
  /** Everywhere a `move` may land. Excludes this place — see the picker below. */
  moveDestinations: LocationPickerOption[];
  /**
   * Narrow the whole form to ONE part.
   *
   * Set when this is opened from a part rather than from a place — you searched for an o-ring,
   * found which shelf it is on, and want to take five off it. The rows collapse to that part and
   * `Add` stops offering the catalogue, because the part is not in question; only the number is.
   *
   * The same component either way. A separate part-and-place form would be a third code path to
   * the same four RPCs, with its own drift in what a blank row means and its own version of the
   * disarm-what-landed rule.
   */
  restrictTo?: { partId: string; partName: string; primaryUnit: string | null };
  /** Back to the place overview. The drawer stays open. */
  onCancel: () => void;
  onDone: () => void | Promise<void>;
}

export default function PlaceStockActionForm({
  action,
  companyId,
  locationId,
  locationName,
  moveDestinations,
  restrictTo,
  onCancel,
  onDone,
}: PlaceStockActionFormProps) {
  const fromHere = action !== 'add';

  /** part id → what was typed, verbatim. Strings, so a half-typed "1." is not yet a number. */
  const [qty, setQty] = useState<Record<string, string>>({});
  /** part id → unit, only where the person changed it away from the part's own. */
  const [unitFor, setUnitFor] = useState<Record<string, string>>({});
  /** `add` only: the rows built by picking. The catalogue is unbounded, so rows are chosen. */
  const [picked, setPicked] = useState<Row[]>([]);
  /**
   * The picker's text, controlled so it can be CLEARED on every pick.
   *
   * Left uncontrolled, MUI keeps the chosen label in the box while `value` resets to null — so the
   * list stays filtered to the thing you just added and the next part appears to be missing.
   */
  const [pickText, setPickText] = useState('');
  const [destination, setDestination] = useState<LocationPickerOption | null>(null);
  /** Only rendered above `FILTER_FROM` rows; a three-part bin needs no search box. */
  const [filter, setFilter] = useState('');
  const [job, setJob] = useState<JobWithRelations | null>(null);
  /**
   * One note for the batch.
   *
   * The single-part form had this and the batch rewrite dropped it — a silent capability loss, and
   * the note is often the only record of WHY ("scrapped, bad heat"). Per batch rather than per row
   * because the reason is the same for everything you are carrying in one trip; a per-row note
   * would be a second column on a row already carrying three controls.
   */
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ partName: string; message: string }>>([]);
  /** How many lines landed in the last partial save — captured, not recomputed from live state. */
  const [saved, setSaved] = useState(0);
  /**
   * The caught error object, not a formatted string: `ErrorAlert` needs the object to tell a
   * billing block from an ordinary failure. Validation messages stay plain strings, which it
   * renders as-is.
   */
  const [error, setError] = useState<unknown>(null);

  /*
   * One read, chosen by verb.
   *
   * `Add` needs the catalogue; the other two need the bin. `useLoad` rather than a mount effect:
   * the house hook handles the stale-response race, and keeps the fetch out of an effect body that
   * would otherwise setState synchronously. Read here rather than handed down as a prop so the
   * drawer's contents list and this form cannot disagree about what is in the drawer — one of them
   * is reading a snapshot either way, and the one about to WRITE is the one that must be current.
   */
  const { data, loading, error: loadError } = useLoad(
    async () =>
      // Restricted to one part, even `Add` reads the BIN — it needs how much is already here to
      // show on the row, and it has no picker to fill from the catalogue.
      action === 'add' && !restrictTo
        ? ({ kind: 'parts', parts: await getStockedParts(companyId) } as const)
        : ({ kind: 'contents', page: await getLocationContents(locationId) } as const),
    [action, companyId, locationId, restrictTo],
  );

  /** Best-effort author: a failed lookup writes no name rather than blocking a stock correction. */
  const { data: member } = useLoad(() => getCurrentMember(companyId).catch(() => null), [companyId]);
  const operatorId = member?.id ?? null;


  /** Everything that could be picked for an `add`, minus what is already a row. */
  const addable = useMemo(() => {
    if (data?.kind !== 'parts') return [];
    const already = new Set(picked.map((r) => r.partId));
    return data.parts
      .filter((p) => !already.has(p.id))
      .map((p) => ({
        partId: p.id,
        partName: p.part_name,
        primaryUnit: p.primary_unit || 'ea',
        onHand: null as number | null,
      }));
  }, [data, picked]);

  /** The rows on screen. The bin's contents for Remove and Move; whatever was picked for Add. */
  const rows: Row[] = useMemo(() => {
    const here =
      data?.kind === 'contents'
        ? data.page.contents.map((c) => ({
            partId: c.part_id,
            partName: c.part_name,
            primaryUnit: c.primary_unit || 'ea',
            onHand: c.quantity as number | null,
          }))
        : [];

    if (restrictTo) {
      /*
       * One row, and it exists even when the bin holds none of this part.
       *
       * `Add` is the case that needs it: you are putting something on a shelf that does not have
       * any yet, so there is nothing in the contents read to build a row from. Falling back to the
       * part itself with a null `onHand` is what makes the row appear at all — and null is the
       * right value, since "we have no record here" is not the same as "there are zero".
       */
      const found = here.find((r) => r.partId === restrictTo.partId);
      return [
        found ?? {
          partId: restrictTo.partId,
          partName: restrictTo.partName,
          primaryUnit: restrictTo.primaryUnit || 'ea',
          onHand: null,
        },
      ];
    }

    if (action === 'add') return picked;
    return here;
  }, [action, picked, data, restrictTo]);

  const clipped =
    data?.kind === 'contents' ? Math.max(0, data.page.total - data.page.contents.length) : 0;

  const unitsFor = (row: Row) =>
    Array.from(new Set([row.primaryUnit, ...getStandardUnitsForUnit(row.primaryUnit)])).filter(
      Boolean,
    );

  const unitOf = (row: Row) => unitFor[row.partId] ?? row.primaryUnit;

  /** Rows carrying a usable quantity. A blank, a stray minus, a half-typed decimal are not lines. */
  const lines = useMemo(
    () =>
      rows
        .map((row) => ({ row, value: parseFloat(qty[row.partId] ?? '') }))
        .filter((l) => Number.isFinite(l.value) && l.value > 0),
    [rows, qty],
  );

  /** Put this row's whole on-hand in its quantity box, in the part's own unit. */
  const fillRow = (row: Row) => {
    if (row.onHand == null) return;
    setQty((q) => ({ ...q, [row.partId]: String(row.onHand) }));
    setUnitFor((u) => ({ ...u, [row.partId]: row.primaryUnit }));
  };

  /*
   * THE JOBS THIS MATERIAL COULD PLAUSIBLY HAVE GONE TO.
   *
   * Keyed by the SET of parts being removed, not by the quantities — so typing `1`, `12`, `120`
   * into a box re-queries nothing, and adding a second part to the batch does.
   *
   * The tag is one per batch, so the set is the UNION across the filled rows: issuing a shaft and
   * an o-ring to one job, a job that consumes either is a plausible answer. Intersection would be
   * stricter and mostly empty — few jobs list every loose item that goes out with them.
   *
   * With nothing filled in yet there is nothing to narrow by, so every active job is offered. The
   * list narrows as the batch takes shape rather than starting empty, which would read as broken.
   */
  const partKey = useMemo(
    () => lines.map((l) => l.row.partId).sort().join(','),
    [lines],
  );

  const { data: jobs, loading: loadingJobs } = useLoad(async () => {
    if (action !== 'deplete') return [];
    const ids = partKey ? partKey.split(',') : [];
    if (ids.length === 0) return loadTaggableJobs(companyId).catch(() => []);
    const perPart = await Promise.all(ids.map((id) => loadJobsForPart(companyId, id)));
    const byId = new Map<string, (typeof perPart)[number][number]>();
    for (const list of perPart) for (const j of list) byId.set(j.id, j);
    // `loadJobsForPart` already returns most-recently-updated first; the map preserves the order
    // the first list arrived in, so re-sorting here would only undo that.
    return [...byId.values()];
  }, [action, companyId, partKey]);

  /** Filtered rows — with every line exempt, so nothing about to be written can be off screen. */
  const filled = useMemo(() => new Set(lines.map((l) => l.row.partId)), [lines]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => filled.has(r.partId) || r.partName.toLowerCase().includes(q));
  }, [rows, filter, filled]);

  /** Every row on screen, filled with its whole on-hand. The empty-the-bin case. */
  const fillAllVisible = () => {
    setQty((q) => {
      const next = { ...q };
      for (const row of visible) if (row.onHand != null) next[row.partId] = String(row.onHand);
      return next;
    });
    setUnitFor((u) => {
      const next = { ...u };
      for (const row of visible) if (row.onHand != null) next[row.partId] = row.primaryUnit;
      return next;
    });
  };

  const submit = async () => {
    if (lines.length === 0) return;
    if (action === 'move' && !destination) {
      setError('Choose where it is going.');
      return;
    }

    setSaving(true);
    setError(null);
    setFailures([]);
    setProgress({ done: 0, total: lines.length });

    /*
     * Row by row, and every failure named.
     *
     * `transfer_stock` and its siblings are each atomic, so no ONE part is ever left half-done. The
     * only partial state is "these four went, this one did not" — which is reported below rather
     * than left to be discovered, and that is the whole of the objection the worksheet's atomic
     * put-away was protecting against.
     */
    const failed: Array<{ partName: string; message: string }> = [];
    const succeeded: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const { row, value } = lines[i];
      setProgress({ done: i, total: lines.length });
      const unit = unitOf(row);
      try {
        if (action === 'add') {
          await addStockAtLocation(row.partId, locationId, value, unit, {
            notes: notes || undefined,
            operatorId: operatorId || undefined,
          });
        } else if (action === 'deplete') {
          await depleteStockAtLocation(row.partId, locationId, value, unit, {
            notes: notes || undefined,
            operatorId: operatorId || undefined,
            jobId: job?.id,
          });
        } else {
          await transferStock(row.partId, locationId, destination!.id, value, unit, {
            notes: notes || undefined,
            operatorId: operatorId || undefined,
          });
        }
        /*
         * One event per WRITE, not one per batch. `stock updated` has always meant "a stock write
         * happened" and carries the part and quantity; collapsing a batch into one event would
         * make those two properties describe an arbitrary member of it.
         */
        posthog.capture('stock updated', {
          surface: 'storage',
          action,
          part_id: row.partId,
          quantity: value,
          unit,
          location_id: locationId,
        });
        succeeded.push(row.partId);
      } catch (e) {
        failed.push({
          partName: row.partName,
          message: e instanceof Error ? e.message : 'Could not save this line.',
        });
      }
    }

    setProgress(null);
    setSaving(false);
    await onDone();

    if (failed.length > 0) {
      /*
       * DISARM WHAT LANDED, or retrying doubles it.
       *
       * The form stays open so a failed line can be fixed without re-typing the others — and until
       * this ran, the quantities of the lines that SUCCEEDED were still in the boxes, so the button
       * still read `Remove stock (5)` and pressing it, the single most obvious next move, ran those
       * four again. `add_stock_at_location` is a delta, not a set, so adding 12 twice leaves 24 in
       * the bin and nothing to undo it with.
       *
       * The comment that used to sit here described exactly this hazard as the reason the form stays
       * open. It stayed open and stayed armed.
       */
      setQty((q) => {
        const next = { ...q };
        for (const id of succeeded) delete next[id];
        return next;
      });
      // A picked `add` row that landed is done with; leaving it would put a zero-quantity row back
      // in a list whose whole purpose is the parts you are still adding.
      if (action === 'add') setPicked((p) => p.filter((r) => !succeeded.includes(r.partId)));
      setSaved(succeeded.length);
      setFailures(failed);
      return;
    }
    onCancel();
  };

  // Restricted, the row always exists — the part is the subject, so there is nothing to refuse.
  const nothingHere = !restrictTo && fromHere && !loading && rows.length === 0;

  return (
    <Box
      sx={{
        // Inset and bordered so it reads as belonging to the verb above it rather than as the next
        // thing on the page.
        mt: 1.5,
        p: 1.5,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
      }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
        {TITLES[action]}
      </Typography>

      <Stack spacing={2}>
        {(error ?? loadError) != null && <ErrorAlert error={error ?? loadError} />}

        {failures.length > 0 && (
          <Alert severity="warning">
            {/* The captured count, not `lines.length - failures.length` — the lines that landed have
                just been cleared out of `lines`, so recomputing it would report zero. */}
            {saved} saved and cleared from this list. These did not:{' '}
            {failures.map((f) => `${f.partName} (${f.message})`).join('; ')}
          </Alert>
        )}

        {clipped > 0 && (
          <Alert severity="info">
            Showing the {rows.length} largest of {num(rows.length + clipped)} parts here.
          </Alert>
        )}

        {/* `Add` builds its own rows: the catalogue is unbounded, so there is nothing to list. */}
        {action === 'add' && !restrictTo && (
          <Autocomplete
            options={addable}
            loading={loading}
            value={null}
            inputValue={pickText}
            onInputChange={(_, v, reason) => setPickText(reason === 'reset' ? '' : v)}
            // Cleared on every pick so the field is ready for the next one — this is a row builder,
            // not a selection that stays selected.
            onChange={(_, v) => {
              if (v) setPicked((p) => [...p, v]);
              setPickText('');
            }}
            getOptionLabel={(o) => o.partName}
            isOptionEqualToValue={(a, b) => a.partId === b.partId}
            renderInput={(params) => (
              <TextField {...params} label="Add a part to this list" size="small" />
            )}
          />
        )}

        {loading && rows.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : nothingHere ? (
          // Not an error — an empty bin is an ordinary state, and the honest answer is that there
          // is nothing to take out of it rather than a list with no rows in it.
          <Alert severity="info">
            Nothing is recorded at {locationName} yet, so there is nothing to{' '}
            {action === 'deplete' ? 'remove' : 'move'}. Add stock here first.
          </Alert>
        ) : rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Pick a part above to start the list.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {/*
              The whole-bin case: emptying a shelf, or putting the entire pile away.

              Fills what is ON SCREEN, so a filtered list fills only what it is showing — and since
              a filled row is exempt from the filter, everything it just filled stays visible. The
              set you are about to write is never larger than the set you can see.
            */}
            {fromHere && !restrictTo && rows.length > 1 && (
              <Stack direction="row" justifyContent="flex-end">
                <Button size="small" onClick={fillAllVisible}>
                  Everything here
                </Button>
              </Stack>
            )}

            {/* A search box on a three-row bin is a control that costs more than it saves. */}
            {!restrictTo && rows.length > FILTER_FROM && (
              <TextField
                size="small"
                placeholder="Filter by part…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                helperText={
                  filter.trim() && lines.length > 0
                    ? `Showing ${visible.length} of ${rows.length} — including ${lines.length} you have filled in.`
                    : ' '
                }
              />
            )}
            {visible.map((row) => {
              const typed = qty[row.partId] ?? '';
              const value = parseFloat(typed);
              const over = row.onHand != null && Number.isFinite(value) && value > row.onHand;
              return (
                <Stack
                  key={row.partId}
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={{ xs: 0.5, sm: 1.5 }}
                  alignItems={{ xs: 'stretch', sm: 'center' }}
                  sx={{ minHeight: 48, py: { xs: 0.5, sm: 0 } }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap title={row.partName}>
                      {row.partName}
                    </Typography>
                    {/* What is on hand, on the row the quantity is typed into — so "remove 40"
                        from a bin holding 12 is caught by the person, not by an RPC afterwards. */}
                    <Typography variant="caption" color={over ? 'error.main' : 'text.secondary'}>
                      {row.onHand == null
                        ? row.primaryUnit
                        : `${num(row.onHand)} ${row.primaryUnit} here${over ? ' — more than that' : ''}`}
                    </Typography>
                  </Box>

                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      size="small"
                      type="number"
                      value={typed}
                      onChange={(e) => setQty((s) => ({ ...s, [row.partId]: e.target.value }))}
                      sx={{ width: 96 }}
                      error={over}
                      slotProps={{
                        htmlInput: {
                          min: 0,
                          step: 'any',
                          // The heading is a column away on a phone, and forty rows sharing the
                          // name "Quantity" name none of them.
                          'aria-label': `Quantity for ${row.partName}`,
                        },
                      }}
                    />
                    <TextField
                      select
                      size="small"
                      value={unitOf(row)}
                      onChange={(e) =>
                        setUnitFor((s) => ({ ...s, [row.partId]: e.target.value }))
                      }
                      sx={{ width: 92 }}
                      slotProps={{ htmlInput: { 'aria-label': `Unit for ${row.partName}` } }}
                    >
                      {unitsFor(row).map((u) => (
                        <MenuItem key={u} value={u}>
                          {u}
                        </MenuItem>
                      ))}
                    </TextField>
                    {row.onHand != null && (
                      <Button
                        size="small"
                        onClick={() => fillRow(row)}
                        // The amount as of when this drawer opened. If someone empties the bin
                        // meanwhile the RPC refuses the line and says so by name — a safe failure,
                        // and the same one you would get having typed the number by hand.
                        aria-label={`Use all ${num(row.onHand)} ${row.primaryUnit} of ${row.partName}`}
                        sx={{ minWidth: 48 }}
                      >
                        All
                      </Button>
                    )}
                    {action === 'add' && (
                      <IconButton
                        aria-label={`Remove ${row.partName} from this list`}
                        onClick={() =>
                          setPicked((p) => p.filter((r) => r.partId !== row.partId))
                        }
                        sx={{ width: 40, height: 40 }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Stack>
                </Stack>
              );
            })}
          </Stack>
        )}

        {/* One destination for the batch. Carrying a handful of things to one shelf is the act
            this models; a per-row destination would be a different feature and a longer row. */}
        {action === 'move' && rows.length > 0 && (
          <LocationPicker
            label="Move to"
            options={moveDestinations}
            value={destination}
            onChange={setDestination}
            size="small"
            // Cannot move something to where it already is, and the put-away pile is a holding
            // area rather than a destination you would choose on purpose.
            excludeId={locationId}
            excludeSystem
            required
          />
        )}

        {/* One job for the batch: you are issuing this handful of material to one job. */}
        {action === 'deplete' && rows.length > 0 && (
          <JobTagPicker
            jobs={jobs ?? []}
            loading={loadingJobs}
            value={job}
            onChange={setJob}
            helperText={
              lines.length > 0
                ? 'Jobs that use what you are removing.'
                : undefined
            }
          />
        )}

        {rows.length > 0 && (
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            size="small"
            multiline
            minRows={2}
          />
        )}

        {progress && progress.total > 0 && (
          <Box>
            <LinearProgress variant="determinate" value={(progress.done / progress.total) * 100} />
            <Typography variant="caption" color="text.secondary">
              Saving {progress.done} of {progress.total}…
            </Typography>
          </Box>
        )}

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button onClick={onCancel} disabled={saving}>
            {failures.length > 0 ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="contained" onClick={submit} disabled={saving || lines.length === 0}>
            {saving
              ? 'Saving…'
              : lines.length > 1
                ? `${SUBMIT[action]} (${lines.length})`
                : SUBMIT[action]}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
