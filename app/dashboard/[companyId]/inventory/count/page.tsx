'use client';

/**
 * Inventory count sheet — journey J9 in docs/modules/inventory.md.
 *
 * "Inventory", not "stock" — but no longer for the reason first written here. That reason was
 * "the nav item is Inventory", which stopped being true when the nav item became **Storage**
 * (#622). It survives on the stronger ground: this screen counts **items**, and *inventory* is
 * the industry's word for items and quantities, while *storage* means the places. Counting a
 * shelf is an inventory action performed at a storage location. ("Stocked" stays — that's the
 * per-part flag, a real distinct concept with its own switch on the part form.)
 *
 * TWO steps: choose what you're counting, then count it. Save commits — nothing in between.
 *
 * That shape was arrived at by getting it wrong three times, so the reasoning is worth keeping:
 *
 *  - It started as Scope → Sheet → **Review**. The review page restated deltas the counter
 *    would have understood better the instant they typed them, so it's gone — the variance now
 *    appears on the row as you type.
 *  - It was then rebuilt as a **single** page listing every part. That over-corrected:
 *    a wall of empty inputs reads as "fill in this form", hides that counting one part is
 *    perfectly normal, and loses what choosing was quietly doing — making a count a bounded,
 *    finishable task. "I'm counting these five things" beats a row per part.
 *  - Review then came back as a **confirm dialog**, which turned out to be the same mistake in
 *    a smaller box: it showed rows still visible behind it, and its big-change warning fired on
 *    nearly every line. Removed. See `save()`.
 *
 * So the scope step earns its place; restating the count before saving it never did.
 *
 * ## Two ways in, one worksheet
 *
 * **Storage is no longer one of them.** Auditing a bin and auditing a whole cabinet both happen in a
 * drawer on the Storage page itself as of 2026-08-10 — same `commitCount`, same `adjustment` rows,
 * without leaving the grid you are auditing. What still arrives here is the shop-wide sheet from the
 * Parts toolbar, and one part at one place from its own balance row.
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
 *  - **Search runs on the server**, because a bin's contents were never loaded into memory to
 *    filter, and only the server knows the `total` the pager reports.
 *  - **You can put things away.** Alongside "Count N parts" there's "Move N to…", because the other
 *    thing you do standing at a bin is notice something doesn't belong there. That single addition
 *    is what makes this the put-away tool — at `Unassigned`, this screen *is* how a shop empties
 *    the pile that lands there.
 *
 * Both of those used to be justified by "`Unassigned` holds every part a real shop owns — 9,428 at
 * Contour". **That stopped being true in `20260802144310`**, which pruned the zero-balance residue
 * and added `CHECK (quantity > 0)`, so the seeding trigger no longer leaves a row per part. Contour's `Unassigned` holds **57** rows today, against a `LOCATION_PAGE_SIZE` of
 * 100 — the pager has never actually rendered in production. Both features stay: they are correct,
 * cheap and tested, and the bound is still real, just much further away than the prose claimed.
 *
 * The two write paths stay deliberately different. Counting commits line-by-line and reports
 * per-line failures, because line 50 failing must not invalidate lines 1–49. A move is one atomic
 * RPC, because a half-moved pile is worse than no move — you can't tell what you already did.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
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
import AddIcon from '@mui/icons-material/Add';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import {
  buildVariances,
  committableVariances,
  contestedParts,
  countRowKey,
  groupByPart,
  type CountGroup,
  commonUnit,
  rowDelta,
} from '@/lib/inventoryCountPlan';
import {
  commitCount,
  loadCountCandidates,
  loadCountCandidatesForPlaces,
  loadPartAtLocationCandidate,
  loadPartEverywhereCandidates,
  type CountPlace,
} from '@/utils/inventoryCountAccess';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { COUNT_PICKER_LIMIT } from '@/lib/queryLimits';
import { getCurrentMember } from '@/utils/operatorAccess';
import {
  LOCATION_PAGE_SIZE,
  PUT_AWAY_MAX,
  bulkPutAway,
  createLocation,
  getBalancesForParts,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import { compareLocationNames, computePathNames } from '@/lib/locationTree';
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

  /**
   * Where "back" goes depends on where counting is entered from.
   *
   * Two entry points are the Storage board — `Count everything` in its toolbar, and `Count what's
   * here` on a tile's sheet — and the rest arrive from a part page or another count.
   *
   * This used to be a single hardcoded push to `/dashboard/{id}/inventory`, which now redirects to
   * Parts — so a user who arrived from Storage was silently dumped on a different page than the
   * one they left.
   *
   * Used by all three exits from this flow — the Back button, the post-save redirect, and the
   * "everything already matches" redirect. They were three separate copies of the same wrong
   * literal; the post-save one mattered most, because it fires exactly when someone wants to go
   * count the next shelf and it was dropping them on Parts with the board gone.
   *
   * Withdrawn: a fourth branch sent shops without the `inventory_locations` flag to Parts instead,
   * because for them the board did not exist. The flag was retired Aug 2026 and every shop has a
   * board, so the Storage default is now correct for everyone.
   */
  /** `?location=<id>` switches the whole sheet to place-scoped. See the module comment. */
  const locationId = searchParams.get('location');
  const locationMode = Boolean(locationId);

  /**
   * `?part=<id>` narrows a place-scoped count to ONE part — the sheet you reach from "Count here"
   * on the part page. Meaningless without a location: counting a part means counting it somewhere.
   */
  const partIdParam = searchParams.get('part');
  const partScope = Boolean(locationId && partIdParam);
  /**
   * `?part=<id>` with NO location: one part, every place it sits, on one sheet.
   *
   * The journey the excluded-part chips have been describing. A split part is kept off the
   * company-wide sheet because a single total has no unambiguous home — but each chip was its own
   * one-row sheet, so a part in three places meant three trips through the picker. Every row
   * targets its own location, so `commitCount` already writes each to its own shelf.
   */
  const everywhereScope = Boolean(partIdParam && !locationId);
  /** Either part-first mode: no picker, one pre-chosen set, straight to the sheet. */
  const partFirst = partScope || everywhereScope;
  const [partName, setPartName] = useState('');

  /**
   * Where "back" goes, and where a finished count lands.
   *
   * `?from=` is set by whoever sent you here, because the destination is not derivable: the same
   * one-row sheet is reachable from a part page and from an excluded-part chip on another count,
   * and dumping someone on Storage from either is the bug this branch already exists to prevent.
   *
   * Every arm resolves synchronously from the URL, so the Back button renders on first paint. It
   * used to carry a `flagged` marker and a visibility guard for the one arm that had to wait on a
   * feature flag; that flag is gone and so is the wait.
   */
  const from = searchParams.get('from');
  const returnTo = partFirst && partIdParam
    ? { href: `/dashboard/${companyId}/parts/${partIdParam}?tab=inventory`, label: 'Back to part' }
    : from === 'count'
      ? { href: `/dashboard/${companyId}/inventory/count`, label: 'Back to the count' }
      : from === 'parts'
        ? { href: `/dashboard/${companyId}/parts`, label: 'Back to parts' }
        : { href: `/dashboard/${companyId}/inventory/locations`, label: 'Back to storage' };

  /**
   * Which page of this bin we are looking at.
   *
   * `Unassigned` holds every part that has not been put away, and it is the bin that most needs
   * emptying — so a hard cap of one page made the single most important place uncountable. The
   * justification for paging is query cost, not DOM weight: `getLocationContentsPage` pairs an
   * exact count with a range, and this is an office computer.
   */
  const [page, setPage] = useState(0);
  const [paging, setPaging] = useState(false);
  /** Bumped to force a re-read after a write that changed what is here. */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Remounts the add-a-part picker after each pick.
   *
   * `PartAutocomplete` keeps its own `inputValue`, and it is a controlled-`value` component with
   * nothing to control here — we consume the pick and hold no selection. Passing `value={null}`
   * alone leaves the typed text sitting in the box after the row has been added. A key change is
   * the honest reset.
   */
  const [addNonce, setAddNonce] = useState(0);
  /** Same reset, for the sheet's "+ Count it somewhere else" pickers. */
  const [placeNonce, setPlaceNonce] = useState(0);
  const [addingPart, setAddingPart] = useState(false);

  const [locationName, setLocationName] = useState('');
  const [allLocations, setAllLocations] = useState<InventoryLocation[]>([]);

  // Without this the Header falls back to "Inventory Details" for any unrecognised
  // /inventory/* route, which is both wrong and confusing mid-count.
  const { setTitle } = usePageTitle();
  useEffect(() => {
    // Guard against the empty string: `partName` is only known after the one-row load resolves,
    // and "Count  in Shelf A" is worse than the generic title for the moment in between.
    if (partScope && partName && locationName) setTitle(`Count ${partName} in ${locationName}`);
    else if (everywhereScope && partName) setTitle(`Count ${partName} everywhere`);
    // `Bulk Adjust`, matching the button that opens it. A count IS a batch of adjustments —
    // `commitCount` writes one `adjustStockAtLocation` per line — so naming the page for the tool
    // while the button named the outcome made two names for one thing. The shop-wide entry keeps
    // `Count Inventory`: it is reached from Parts, where the noun is the items, not the places.
    else if (locationMode && locationName) setTitle(`Bulk Adjust ${locationName}`);
    else setTitle('Count Inventory');
    return () => setTitle(null);
  }, [setTitle, locationMode, locationName, partScope, everywhereScope, partName]);

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CountCandidate[]>([]);

  /**
   * The chosen parts, BY VALUE — not a list of ids into `candidates`.
   *
   * This is a data-loss fix, not a refactor. `candidates` is replaced wholesale whenever the
   * server list changes (a debounced search today, a page turn as of this change), and `save()`
   * built its variances by mapping over `candidates`. So a number typed for a part that then fell
   * out of the result set was **silently never committed** — no warning, no failure, the sheet
   * just reported fewer changes than you made. Holding the candidate itself means the sheet
   * survives anything that happens to the list it came from.
   */
  const [selected, setSelected] = useState<Map<string, CountCandidate>>(new Map());
  const [entries, setEntries] = useState<CountEntries>({});
  const [search, setSearch] = useState('');

  /**
   * The search term the server has been asked about.
   *
   * Place-scoped mode filters server-side, so the raw keystrokes are debounced into this before
   * becoming a request. Company-wide mode filters `countable` in memory and ignores it — including
   * **as a dependency** — see the loader's note on why the term now reaches the server in
   * both modes.
   */
  const [serverSearch, setServerSearch] = useState('');

  /**
   * The term the page-reset has already been applied for. A ref, not state: it must not
   * be a dependency of the debounce effect, or settling it would re-arm the timer.
   */
  const appliedSearchRef = useRef('');

  /** Parts held at this location in total — may exceed the page, so the UI can say so. */
  const [hereTotal, setHereTotal] = useState(0);
  /**
   * True when `?location=` names a container, so the sheet spans the bins beneath it.
   *
   * Gates the bulk put-away below: `bulk_put_away` moves parts FROM one location, and on a subtree
   * sheet the ticked rows come from several. Counting is unaffected — every line already commits at
   * its own bin — so this hides one control rather than restricting the sheet.
   */
  const [countingSubtree, setCountingSubtree] = useState(false);

  /**
   * The bins this sheet actually spans, and which of them a newly-found part goes into.
   *
   * Only meaningful when `countingSubtree` — a single-bin sheet has exactly one answer and asking
   * would be a dropdown of one. Held here rather than recomputed because the walk that produces it
   * runs inside the load effect, against the full location list this component does not keep.
   */
  const [leafOptions, setLeafOptions] = useState<LocationPickerOption[]>([]);
  const [addTo, setAddTo] = useState<LocationPickerOption | null>(null);

  /** Put-away state: the destination, and whether a move is in flight. */
  const [moveTo, setMoveTo] = useState<LocationPickerOption | null>(null);
  const [moving, setMoving] = useState(false);
  const [scanningDest, setScanningDest] = useState(false);

  /** System quantities as the sheet loaded — compared to a fresh read at save, so we can say
   *  which parts moved underneath the count. */
  const openedWithRef = useRef<Map<string, number>>(new Map());

  /**
   * Remember what the system said when each row was FIRST seen — first-seen-wins.
   *
   * This is what `movedSinceOpened` compares against, i.e. "somebody else changed this while you
   * were counting". Re-seeding the whole map on every load would reset that baseline every time
   * the list reloaded, so turning to page 2 and back would erase the evidence that a part moved
   * under you. Only rows never seen before get recorded.
   */
  const rememberOpenedWith = useCallback((rows: CountCandidate[]) => {
    for (const c of rows) {
      const key = countRowKey(c);
      if (!openedWithRef.current.has(key)) {
        openedWithRef.current.set(key, c.systemQuantity);
      }
    }
  }, []);

  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);
  /**
   * A save held at the gate: stock moved between two places on this sheet (#656).
   *
   * Held rather than committed-and-explained, because by the time it is explained the wrong
   * number is already in the database and the operator has walked away.
   */
  const [pending, setPending] = useState<{
    toCommit: CountVariance[];
    unseenPlaces: string[];
    contested: CountVariance[][];
  } | null>(null);
  const [progress, setProgress] = useState<CountCommitProgress | null>(null);
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(null);

  /**
   * Who is running this count, so the ledger names them.
   *
   * Its OWN effect, keyed on the company. Folding it into the loader would re-fetch the member on
   * every page turn and every keystroke of the debounced search, for a value that cannot change
   * while the page is open.
   */
  const [operatorId, setOperatorId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCurrentMember(companyId)
      .then((m) => !cancelled && setOperatorId(m?.id ?? null))
      .catch(() => !cancelled && setOperatorId(null));
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  /**
   * The loader's page, still gated to the mode that has one.
   *
   * `serverSearch` is NO LONGER gated, and that reversal is the point. It used to be
   * `locationMode ? serverSearch : ''` because the company-wide sheet filtered in the browser, so
   * feeding it a term re-ran `loadCountCandidates` + `getBalancesForParts` + `getLocations` only
   * to receive the identical array back. That was true while `is_stocked` bounded the catalogue to
   * a few hundred rows. It is gone, so the company-wide picker is server-searched too and the
   * refetch a keystroke triggers is now the entire mechanism rather than waste.
   *
   * `page` stays gated: only the place-scoped sheet pages, and leaving it raw would make a
   * company-wide keystroke reload at whatever page index the last bin visit left behind.
   */
  const placePage = locationMode ? page : 0;

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A separate flag from `loading`: that one swaps the whole page for a spinner, which on a
      // page turn would throw away the toolbar and the pager you just pressed.
      setPaging(true);
      try {
        // Place-scoped: read one page of THIS bin's contents. `serverSearch` is a dependency, so
        // typing re-runs this against the server — a bin's contents are not in memory to filter,
        // and only the server knows the `total` the pager reports.
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

          // One part at one place: skip the picker entirely and go straight to a one-row sheet.
          // There is nothing to choose, so making someone tick a single checkbox first would be
          // a step that exists only because the other mode has one.
          if (partIdParam) {
            const only = await loadPartAtLocationCandidate(
              companyId,
              partIdParam,
              locationId,
              here.name,
            );
            if (cancelled) return;
            setPartName(only.partName);
            setCandidates([only]);
            setHereTotal(1);
            // `countRowKey`, not the bare part id: every other writer and every reader of
            // `selected` keys by row. A part-id key is invisible while this sheet has one row,
            // and becomes a duplicate (part, place) the moment a place can be added to it.
            setSelected(new Map([[countRowKey(only), only]]));
            setEntries({});
            rememberOpenedWith([only]);
            setStep(1);
            return;
          }

          /*
           * A container is counted through its bins.
           *
           * Since 20260806160053 a place with sub-locations holds no stock of its own, so a
           * one-bin sheet for a cabinet would be permanently blank. "Count Cabinet 1-A" means the
           * bins under it — which is also how you would physically do it, walking bin to bin — and
           * `commitCount` already writes each line at its own `target.locationId`, so a sheet
           * spanning ten bins needs no new write path.
           *
           * A leaf resolves to a one-element list, i.e. exactly what this always did.
           */
          const byId = new Map(locations.map((l) => [l.id, l] as const));
          const childrenOf = (id: string) => locations.filter((l) => l.parent_id === id);
          const leaves: CountPlace[] = [];
          const walk = (node: InventoryLocation) => {
            const kids = childrenOf(node.id);
            if (kids.length === 0) {
              leaves.push({
                id: node.id,
                name: node.name,
                // Full path once a sheet spans several bins — the page title can no longer say
                // which place a row belongs to. A single bin keeps its bare name.
                path: computePathNames(node.id, byId).join(' › ') || node.name,
              });
              return;
            }
            [...kids]
              .sort((a, b) => a.sort_order - b.sort_order || compareLocationNames(a.name, b.name))
              .forEach(walk);
          };
          walk(here);
          const subtree = leaves.length > 1 || leaves[0]?.id !== here.id;
          setCountingSubtree(subtree);
          // The bins a found part may be added to. Empty on a single-bin sheet, where the sheet's
          // own location IS the answer and a picker of one is friction.
          setLeafOptions(
            subtree ? leaves.map((l) => ({ id: l.id, label: l.path || l.name })) : [],
          );
          setAddTo(null);

          const { candidates: found, total } = await loadCountCandidatesForPlaces(
            leaves.length === 1 && leaves[0].id === here.id
              ? [{ id: here.id, name: here.name, path: here.name }]
              : leaves,
            {
              search: serverSearch,
              offset: placePage * LOCATION_PAGE_SIZE,
              limit: LOCATION_PAGE_SIZE,
            },
          );
          if (cancelled) return;
          setCandidates(found);
          setHereTotal(total);
          rememberOpenedWith(found);
          return;
        }

        if (partIdParam) {
          const [{ partName: name, candidates: rows }, locations] = await Promise.all([
            loadPartEverywhereCandidates(companyId, partIdParam),
            // For "+ Count it somewhere else": this sheet has no picker step, so nothing else
            // would have loaded them.
            getLocations(companyId),
          ]);
          if (cancelled) return;
          setAllLocations(locations);
          setPartName(name);
          setCandidates(rows);
          setSelected(new Map(rows.map((c) => [countRowKey(c), c])));
          setEntries({});
          rememberOpenedWith(rows);
          setStep(1);
          return;
        }

        const [found, locations] = await Promise.all([
          loadCountCandidates(companyId, serverSearch),
          // For "+ Count it somewhere else" on the sheet. Found in the browser, not by a test:
          // `allLocations` was loaded only in the place-scoped and everywhere branches, so on the
          // company-wide sheet the picker rendered with an EMPTY option list — a control that
          // opens onto nothing, which reads as broken rather than as unavailable.
          getLocations(companyId),
        ]);
        if (cancelled) return;
        setCandidates(found);
        setAllLocations(locations);
        rememberOpenedWith(found);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load your parts.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setPaging(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, locationId, partIdParam, serverSearch, placePage, reloadKey, rememberOpenedWith]);

  // Debounce keystrokes into the server-side term. BOTH modes read it now — the company-wide
  // picker became server-searched when `is_stocked` stopped bounding the catalogue — so the
  // 300ms here is what keeps a keystroke from being a query.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = search.trim();
      setServerSearch(next);
      // A new term is a new result set; staying on page 3 of the old one shows nothing.
      //
      // Only reset when the term actually CHANGED. This timer also fires ~300ms after
      // mount, when the term has not changed, and an unconditional reset there races
      // whatever the operator did in the meantime: page to 2 within 300ms of opening a
      // bin and the reset lands afterwards, silently yanking them back to page 1. It is
      // invisible locally because the timer usually expires before anyone can click, and
      // deterministic on a loaded CI runner — which is how it was found, as
      // `InventoryCountPage.test.tsx > 'pages through a bin instead of showing one
      // capped page'` failing on main.
      if (next !== appliedSearchRef.current) {
        appliedSearchRef.current = next;
        setPage(0);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  // The server filters BOTH modes now, so there is nothing left to narrow here. Re-filtering on
  // the undebounced `search` would hide rows for 300ms while the matching request was still in
  // flight — the list would empty out as you typed and refill when it landed.
  const visible = candidates;

  /**
   * The picker's rows: ONE PER PART, not one per place.
   *
   * Ticking a part means "count this part wherever it is" — the sheet is what expands it into a
   * row per place. Keeping the picker part-grained is deliberate: multiplying it by
   * places-per-part would cost a lot and buy nothing. Nobody picks a *shelf* when deciding which
   * parts to walk.
   *
   * This list is NO LONGER unbounded-and-browser-filtered, and the note that used to sit here is
   * worth keeping as the reason. It said: the list is bounded because it filters on `is_stocked`,
   * so the biggest real one is **722 rows** at Contour rather than the 8,451-part catalogue
   * ([#658](https://github.com/debola31/Jigged/issues/658)); revisit above ~5k, because
   * server-side search would trade an instant filter for a debounced round trip and at 722 that
   * is the worse screen.
   *
   * Dropping `is_stocked` deleted the bound, not the reasoning — every part is stockable, so this
   * became the 8,451-row case its own note said to revisit. It is now server-searched and capped
   * at `COUNT_PICKER_LIMIT`, with the hint below telling you when you are seeing a capped view.
   */
  const groups = useMemo(() => groupByPart(visible), [visible]);

  /**
   * The chosen parts, alphabetical.
   *
   * Sorted rather than "in list order" because the list order no longer exists once a sheet can
   * span pages — and a sheet whose rows move when you turn a page is worse than one that never
   * matched the grid.
   */
  /** Distinct parts on the sheet — what the CTA counts. `selected.size` counts ROWS. */
  const selectedParts = useMemo(
    () => new Set([...selected.values()].map((c) => c.partId)).size,
    [selected],
  );

  /** The sheet, grouped: a part and every place of it, ordered part-name then place-path. */
  const sheetGroups = useMemo(() => groupByPart([...selected.values()]), [selected]);

  /** The same rows, flat — for the footer tallies, the unit check and `save()`. */
  const sheet = useMemo(() => sheetGroups.flatMap((g) => g.rows), [sheetGroups]);

  /** One unit for the whole sheet, or null when mixed — decides footer vs per-row. */
  const sheetUnit = useMemo(() => commonUnit(sheet), [sheet]);

  /**
   * Counted rows ON THE SHEET, not keys in `entries`.
   *
   * `countedTally(entries)` counted a number you had typed and then unticked, so "12 of 10
   * counted" was reachable. Deriving from the sheet keeps the tally honest without destroying
   * the entry — untick, re-tick, and your number is still there.
   */
  const counted = useMemo(
    () => sheet.filter((c) => entries[countRowKey(c)] !== undefined).length,
    [sheet, entries],
  );
  const changes = useMemo(
    () =>
      sheet.filter((c) => {
        const d = rowDelta(c, entries);
        return d !== null && d !== 0;
      }).length,
    [sheet, entries],
  );

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

  /**
   * Tick a part: put EVERY place of it on the sheet, or take them all off.
   *
   * The picker's unit is the part — "count this one wherever it is" — while the sheet's unit is
   * the row. All-or-nothing rather than a tri-state: a part is either on your walk or it is not,
   * and per-place deselection is a decision for the sheet, where the places are actually visible.
   */
  const toggleGroup = (g: CountGroup) =>
    setSelected((prev) => {
      // Unticking drops the rows from the sheet but deliberately leaves their entries alone, so
      // re-ticking restores the numbers rather than making someone type them again.
      const next = new Map(prev);
      const allOn = g.rows.every((r) => next.has(countRowKey(r)));
      for (const r of g.rows) {
        const key = countRowKey(r);
        if (allOn) next.delete(key);
        else next.set(key, r);
      }
      return next;
    });

  /**
   * Put a part on the sheet that this bin does not think it holds.
   *
   * The whole point of a count. `getLocationContentsPage` filters `.gt('quantity', 0)`, so the
   * single most valuable discovery — *the system says zero and I am holding twelve* — was not
   * merely hard to record, it was unrepresentable: the row did not exist to type a number into.
   *
   * `loadPartAtLocationCandidate` reads the real balance rather than assuming zero, which matters
   * for the mirror case: confirming an empty shelf against a system that says twelve has to be
   * able to commit, and a delta of zero is dropped.
   */
  const addPartHere = async (option: PartSelectOption | null) => {
    if (!option || !locationId) return;
    setAddNonce((n) => n + 1);

    /*
     * On a subtree sheet the row must target a BIN, never the cabinet.
     *
     * `adjust_stock_at_location` refuses a place that has sub-locations, so targeting the container
     * produced a row you could tick, type into, and only then be told "That place has
     * sub-locations, so stock goes in one of those rather than in it" — after the count, which is
     * the one moment a person is least willing to redo. Asked here instead, before the row exists.
     */
    const target = countingSubtree ? addTo : { id: locationId, label: locationName };
    if (!target) {
      setSnack({
        msg: `Choose which location ${option.part_name} is in — a cabinet holds no stock itself.`,
        severity: 'error',
      });
      return;
    }

    /*
     * Already on the sheet AT THIS PLACE — not merely already on the sheet.
     *
     * The guard was per-PART, which was right while a sheet meant one bin. A subtree sheet spans a
     * whole cabinet, and finding the same o-ring in Shelf A and again in Shelf B is an ordinary
     * morning: rejecting the second would make the more thorough count the one the software
     * refuses to record. Row-scoped, matching `countRowKey`, which is what `selected` is keyed by.
     */
    const dupKey = `${option.id}::${target.id}`;
    if ([...selected.values()].some((c) => countRowKey(c) === dupKey)) {
      setSnack({
        msg: `${option.part_name} is already on the sheet at ${target.label}.`,
        severity: 'success',
      });
      return;
    }
    setAddingPart(true);
    try {
      const c = await loadPartAtLocationCandidate(companyId, option.id, target.id, target.label);
      setSelected((prev) => new Map(prev).set(countRowKey(c), c));
      // Prepend so it is visible without hunting: it is not on this page of the server list, and
      // may not be on any page.
      // Dedupe by ROW, not by part: a part legitimately appears once per place, so dropping
      // every row that shares a part id would delete its other shelves from the list.
      setCandidates((prev) => [c, ...prev.filter((x) => countRowKey(x) !== countRowKey(c))]);
      rememberOpenedWith([c]);
      // Not cleared: on a subtree sheet you are standing at one bin working through it, so the
      // next thing you find is far more likely to be in the same place than in a different one.
    } catch (e) {
      setSnack({
        msg: e instanceof Error ? e.message : 'Could not add that part.',
        severity: 'error',
      });
    } finally {
      setAddingPart(false);
    }
  };

  const setCount = (rowKey: string, raw: string) =>
    setEntries((prev) => {
      const next = { ...prev };
      if (raw === '') delete next[rowKey];
      else next[rowKey] = Number(raw);
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
    /** Every counted line, including the zero-delta ones `toCommit` drops. */
    let allVariances: CountVariance[] = [];
    /** Filled by the pre-save read; reported after the commit, never blocking it. */
    let unseenPlaces: string[] = [];
    try {
      /**
       * Re-read what the system believes, PER ROW, at the bin that row is about.
       *
       * Never against `parts.quantity`: that is the roll-up across every place, so using it for a
       * shelf row compares a shelf count to the whole shop's total and reports a variance on
       * every line. (The read that did so, `refreshSystemQuantities`, was deleted with the
       * aggregate row in 20260802015837 — there is no longer a row it would be right for.)
       *
       * Driven off each row's own target rather than a page-level `locationId`, because the
       * all-places sheet has no single location — its rows span several.
       *
       * The rows come from the SHEET, not from `candidates`: a part typed on a page or search you
       * have since navigated away from is no longer in that array, and its correction used to be
       * dropped without a word.
       */
      const countedRows = sheet.filter((c) => entries[countRowKey(c)] !== undefined);

      /*
       * One batched read for every counted PART, rather than one per bin.
       *
       * Two reasons it reads by part and not by (part, place). It is fewer requests — a sheet
       * spanning eight shelves was eight round trips. And it can see a place the sheet does NOT
       * hold: if a part gained stock somewhere while the count was open, that place is invisible
       * to a read scoped to the rows already on the sheet, and the counter would never learn of
       * it. Reported afterwards rather than blocking, because leaving a place blank deliberately
       * leaves it untouched — "I only walked Shelf A" is the normal case, not an error.
       */
      const countedPartIds = [...new Set(countedRows.map((c) => c.partId))];
      const freshByPart = await getBalancesForParts(companyId, countedPartIds);

      const freshAt = (partId: string, locationId: string): number | undefined =>
        freshByPart.get(partId)?.find((b) => b.locationId === locationId)?.quantity;

      const updated = sheet.map((c) => {
        if (entries[countRowKey(c)] === undefined) return c;
        // A bin emptied since the sheet loaded has no row at all (20260802144310 deletes rather
        // than zeroes), so an absent row means zero — not "unknown". Reading it as unknown would
        // keep the stale figure and silently mis-report the variance.
        return { ...c, systemQuantity: freshAt(c.partId, c.target.locationId) ?? 0 };
      });

      // Places a counted part has acquired since the sheet loaded. Not on anyone's sheet, so not
      // committed — but named after the save, because "I counted that part" and "that part has
      // stock I never saw" is exactly the gap a stocktake exists to close.
      unseenPlaces = countedPartIds.flatMap((partId) => {
        const onSheet = new Set(
          countedRows.filter((c) => c.partId === partId).map((c) => c.target.locationId),
        );
        const partName = countedRows.find((c) => c.partId === partId)?.partName ?? '';
        return (freshByPart.get(partId) ?? [])
          .filter((b) => !onSheet.has(b.locationId))
          .map((b) => `${partName} also has stock at ${[...b.path, b.locationName].join(' › ')}`);
      });
      setSelected(new Map(updated.map((c) => [countRowKey(c), c])));
      // Kept whole: `committableVariances` drops zero-delta lines, and a zero delta is precisely
      // what the second half of a between-shelves move looks like. The gate below needs both.
      allVariances = buildVariances(updated, entries, openedWithRef.current);
      toCommit = committableVariances(allVariances);
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
      setSnack({ msg: 'Everything already matches — nothing to save.', severity: 'success' });
      router.push(returnTo.href);
      return;
    }

    /*
     * The gate. Stock moved BETWEEN two places you counted (#656).
     *
     * Each count was true when it was taken; the pair is not. Count Shelf A at 40, a coworker
     * moves 6 A→B, count Shelf B at 18, save: Shelf B's delta is now zero so it is dropped, and
     * Shelf A writes 40 absolutely — putting back six units that legitimately left. Total 58
     * where the truth is 52.
     *
     * This is why the check runs against EVERY counted row and not `toCommit`: the half that
     * reveals the problem is exactly the half `committableVariances` discards.
     *
     * Deliberately scoped to a part with two or more counted rows. For a single row the existing
     * rule is right and stays — the count IS what is on the shelf, and a mid-count movement
     * changes nothing about what to save, so it is reported afterwards rather than asked about.
     */
    const contested = contestedParts(allVariances);
    if (contested.length > 0) {
      setPending({ toCommit, unseenPlaces, contested });
      return;
    }

    await runCommit(toCommit, unseenPlaces);
  };

  /** The write itself, once `save()`'s gate has let it through (or the user has overridden it). */
  const runCommit = async (toCommit: CountVariance[], unseenPlaces: string[]) => {
    setPending(null);
    setCommitting(true);
    setProgress({ done: 0, total: toCommit.length, currentPartName: '', currentLocationName: '' });
    try {
      const result = await commitCount(toCommit, { onProgress: setProgress, operatorId });
      if (result.failures.length === 0) {
        // Named, not tallied. "1 item moved" on a sheet holding one part at three shelves does
        // not say which shelf to go back and look at.
        const moved = toCommit
          .filter((v) => v.movedSinceOpened)
          .map((v) => `${v.candidate.partName} at ${v.candidate.target.locationPath}`);
        setSnack({
          msg:
            `Counted ${result.committed} ${result.committed === 1 ? 'item' : 'items'}.` +
            // Said after the fact rather than as a prompt — the count is what's on the shelf,
            // so a mid-count movement changes nothing about what to save.
            (moved.length > 0
              ? ` ${moved.join(', ')} moved while you were counting; your count is what's saved.`
              : '') +
            (unseenPlaces.length > 0 ? ` ${unseenPlaces.join('. ')}, which wasn't on your sheet.` : ''),
          severity: 'success',
        });
        router.push(returnTo.href);
      } else {
        setSnack({
          msg: `Saved ${result.committed}. ${result.failures.length} could not be saved — ${result.failures[0].partName} at ${result.failures[0].locationName}: ${result.failures[0].message}`,
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
    // `countingSubtree`: the RPC moves parts out of ONE location, and here the ticked rows come
    // from several bins. The control is hidden in that mode; this is the backstop.
    if (!locationId || !moveTo || selected.size === 0 || countingSubtree) return;
    setMoving(true);
    try {
      // `.values()`, not `.keys()`: the map is keyed by row now, and the RPC wants part ids.
      const res = await bulkPutAway(
        locationId,
        moveTo.id,
        [...selected.values()].map((c) => c.partId),
      );

      // Refetch from the START. These parts have just left this location, so the result set
      // shifted — holding the previous page's offset would silently skip whatever moved up.
      setSelected(new Map());
      setEntries({});
      setMoveTo(null);
      // The rows just left this bin, so the result set shifted under the current offset. Reusing
      // it would silently skip whatever moved up into it.
      openedWithRef.current = new Map();
      setPage(0);
      setReloadKey((k) => k + 1);
      setEntries({});
      setMoveTo(null);
      const { candidates: found, total } = await loadCountCandidatesForPlaces(
        [{ id: locationId, name: locationName, path: locationName }],
        { search: serverSearch },
      );
      setCandidates(found);
      setHereTotal(total);
      rememberOpenedWith(found);

      setSnack({
        msg:
          `Moved ${res.moved} ${res.moved === 1 ? 'part' : 'parts'} to ${moveTo.label}.` +
          // Skipped means "nothing here to move" — a zero balance, which a part can have at
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

  /**
   * "+ Count it somewhere else" — B4, and the founder's sentence read literally:
   * *"a user count even just select where a part is and how much is there."*
   *
   * An affordance on the sheet, deliberately not a picker STEP. On `?part=` the user already
   * chose the part by pressing "Count all N places"; inserting a step would re-ask a question
   * they answered. And a place the part has never been in is exactly the one you need when the
   * system is wrong about where something lives.
   *
   * Three things it must not do, each of which would lose typed counts:
   *  - touch the URL, or `serverSearch`: the loader effect depends on both, and its part-scoped
   *    branches call `setEntries({})`, so either would wipe the sheet.
   *  - add a second row for a place already listed — two entries for one (part, place) commit
   *    twice to the same shelf, last write silently winning. Idempotent instead.
   *  - assume a zero balance. `loadPartAtLocationCandidate` READS it, so confirming an empty
   *    shelf against a system that says twelve can still commit (a delta of 0 is dropped).
   */
  const addPartAtPlace = async (part: { id: string; name: string }, place: LocationPickerOption) => {
    // Before the early return, not after: the picker must clear whether the place was added or
    // refused. Leaving the refused name in the box left the control filtered to that one option,
    // so the NEXT place could not be picked at all.
    setPlaceNonce((n) => n + 1);

    const existing = [...selected.values()].find(
      (c) => c.partId === part.id && c.target.locationId === place.id,
    );
    if (existing) {
      setSnack({
        msg: `${part.name} is already on the sheet for ${place.label}.`,
        severity: 'success',
      });
      return;
    }
    try {
      const c = await loadPartAtLocationCandidate(companyId, part.id, place.id, place.label);
      setSelected((prev) => new Map(prev).set(countRowKey(c), c));
      rememberOpenedWith([c]);
    } catch (e) {
      setSnack({
        msg: e instanceof Error ? e.message : 'Could not add that location.',
        severity: 'error',
      });
    }
  };

  /**
   * Where a count may write, for the destination picker and for "+ Count it somewhere else".
   *
   * Containers are excluded: since 20260806160053 stock cannot sit at a place that has
   * sub-locations, so counting one could only ever commit zero rows or raise.
   */
  const destinationOptions = useMemo<LocationPickerOption[]>(
    () => stockDestinationOptions(allLocations),
    [allLocations],
  );

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
      {/* Renders immediately: every `returnTo` arm now resolves from the URL alone. It used to be
          held hidden until the `inventory_locations` flag resolved, because an unresolved
          `features` object reads as flag-off and the label would have swapped from "Back to parts"
          to "Back to storage" — the appear-then-change flicker the Parts toolbar had to fix. With
          the flag retired there is nothing left to wait for. */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(returnTo.href)}
        sx={{ mb: 2 }}
      >
        {returnTo.label}
      </Button>

      {/* No stepper in part-scope: there is one row, already chosen, so "Pick / Count" describes
          a journey that does not happen. */}
      {!partFirst && (
      <Stepper activeStep={step} sx={{ mb: 4, maxWidth: 460 }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      )}

      {loadError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {loadError}
        </Alert>
      )}

      {/* ── Step 1: what are you counting? ───────────────────────────────────
          Suppressed entirely in part-scope: there is one row and it is already chosen. Leaving
          it mounted also put the "Nothing to count yet" card directly under
          the error Alert whenever the one-row load threw, since that path never reaches step 1. */}
      {step === 0 && !partFirst && (
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

          {/* The toolbar stays mounted whenever a search is running, in EITHER mode, even with no
              rows. The search runs against the SERVER, so a term that matches nothing empties
              `candidates` — and unmounting on that took the search field with it, leaving no way
              to clear the term you had just typed. Only the list area is allowed to go empty.

              `!serverSearch` is what widened this from place-scoped to both: the company-wide
              picker became server-searched when `is_stocked` stopped bounding the catalogue, so it
              inherited the same trap the same day. The card below is now strictly "this company
              has no parts", which is the only thing an empty UNSEARCHED result can mean. */}
          {candidates.length === 0 && !locationMode && !serverSearch ? (
            <Card elevation={2}>
              <CardContent sx={{ p: 6, textAlign: 'center' }}>
                <Inventory2OutlinedIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  Nothing to count yet
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Every part can hold stock, so anything in your catalogue shows up here. There
                  isn&apos;t one yet.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/parts/new?from=parts`)}
                >
                  Add a part
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {/*
                `flex-start`, not `center`.
                
                The add-a-part field carries helper text and the search field does not, so centring
                them aligned their MIDDLES and left the two input boxes visibly off by half a line.
                Aligning the tops lines up the boxes, which is the part a person is looking at.
              */}
              <Box
                sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}
              >
                <TextField
                  placeholder={locationMode ? 'Search what’s here…' : 'Search parts...'}
                  size="small"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  sx={{ width: 300 }}
                  /* Says so when the view is capped, because a capped list has one failure mode an
                     unbounded one does not: the part you wanted is simply not on it, and nothing
                     on screen would otherwise tell you. Only shown at the cap — below it, the list
                     is everything that matched. */
                  helperText={
                    !locationMode && groups.length >= COUNT_PICKER_LIMIT
                      ? `Showing the first ${COUNT_PICKER_LIMIT} — search to narrow.`
                      : ' '
                  }
                />
                {/* Only place-scoped. A shop-wide count reaches the whole catalogue through the
                    search above, so there is nothing that could be missing from it. */}
                {locationMode && (
                  <Box sx={{ width: 320 }}>
                    <PartAutocomplete
                      key={addNonce}
                      companyId={companyId}
                      value={null}
                      onChange={addPartHere}
                      label="Found something not listed?"
                      size="small"
                      disabled={addingPart}
                      helperText="Adds it to this sheet even if the system says none is here."
                    />
                  </Box>
                )}
                {/*
                  WHICH BIN it goes in, and it is not optional on a subtree sheet.

                  `addPartHere` used to target the sheet's own `?location=`, which on a cabinet is
                  the CONTAINER — and `adjust_stock_at_location` refuses one, so a part added this
                  way could be typed, counted and only then rejected with "That place has
                  sub-locations". A container holds no stock; its bins do. So when the sheet spans
                  several bins, say which.
                */}
                {locationMode && countingSubtree && (
                  <Box sx={{ width: 300 }}>
                    <LocationPicker
                      label="…into which location?"
                      options={leafOptions}
                      value={addTo}
                      onChange={setAddTo}
                      size="small"
                      helperText="Stock lives in the bins, not in the cabinet."
                    />
                  </Box>
                )}
                <Box sx={{ flex: 1 }} />
                <Button
                  // A UNION with what is already ticked, because "select all" on page 3 must not
                  // silently drop pages 1 and 2.
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev);
                      for (const c of visible) next.set(countRowKey(c), c);
                      return next;
                    })
                  }
                  // The RPC refuses more than PUT_AWAY_MAX to bound how long it holds row locks.
                  // Say so here rather than letting someone select 2,000 and be told no — but
                  // only where put-away exists. It renders in place-scoped mode only, so this cap
                  // was taking select-all away from company-wide shops for a button they can't see.
                  disabled={locationMode && visible.length > PUT_AWAY_MAX}
                >
                  {/* In place-scoped mode `visible === countable` by construction, so the old
                      comparison never fired and the label always read "Select all" even on
                      page 1 of 95. Key it off whether a pager exists. */}
                  Select all{hereTotal > LOCATION_PAGE_SIZE || visible.length !== candidates.length ? ' shown' : ''}
                </Button>
                <Button
                  variant="contained"
                  size="large"
                  disabled={selected.size === 0}
                  onClick={() => setStep(1)}
                >
                  {/* `selected.size` is a ROW count, and rows are (part, place). Calling it
                      "parts" made a 20-part shop with two bins read "Count 40 parts" — the same
                      species of nonsense as the held-back notice this change deletes. */}
                  {selectedParts === 0
                    ? 'Count'
                    : `Count ${selectedParts} ${selectedParts === 1 ? 'part' : 'parts'}` +
                      (selected.size > selectedParts ? ` in ${selected.size} locations` : '')}
                </Button>
              </Box>

              {/* ── Put away: the other thing you do standing at a bin ───────────

                  Withheld on a subtree sheet. `bulk_put_away` moves parts out of ONE location, and
                  when you are counting a whole cabinet the ticked rows come from several bins — so
                  "send the ticked parts to…" has no single source to send them from. Counting is
                  unaffected; each line still commits at its own bin. Putting away stays available
                  one level down, standing at the bin, which is where it belongs anyway. */}
              {locationMode && !countingSubtree && (
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
                          selected.size === 0
                            ? 'Tick something above first.'
                            : `Moves everything each part has here — ${selected.size} ${
                                selected.size === 1 ? 'part' : 'parts'
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
                      // The cap belongs on the ACTION, not only the select-all button: ticking
                      // rows one at a time across pages can reach it without ever pressing that.
                      disabled={moving || !moveTo || selected.size === 0 || selected.size > PUT_AWAY_MAX}
                      onClick={putAway}
                    >
                      {moving
                        ? 'Moving…'
                        : `Move ${selected.size || ''} to…`.replace('  ', ' ')}
                    </Button>
                  </CardContent>
                </Card>
              )}

              <LocationScanner
                open={scanningDest}
                onClose={() => setScanningDest(false)}
                title="Scan where these are going"
                /* So a label printed by another shop is refused with "belongs to a different
                   company" instead of falling through to the generic "can't be used here" below.
                   The check underneath would catch it anyway — it isn't in `destinationOptions` —
                   but it can't tell that apart from "you scanned the bin you're standing at", and
                   naming the actual cause is the difference between a useful message and a shrug. */
                expectedCompanyId={companyId}
                surface="inventory_count"
                onScan={(scannedId) => {
                  const dest = destinationOptions.find((o) => o.id === scannedId);
                  // Not one of ours, or it's the bin we're standing at — either way, keep scanning
                  // rather than silently picking a destination the RPC would reject.
                  if (!dest || scannedId === locationId || dest.kind === SYSTEM_KIND) return false;
                  setMoveTo(dest);
                  setScanningDest(false);
                }}
              />

              {/* A pager, not a notice. Saying "showing 100 of N, search to narrow it down" was
                  honest and still left the bin that most needs emptying impossible to work
                  through. Ticks survive a page turn: the sheet holds the chosen rows themselves,
                  not indexes into this list.

                  The N that motivated this was 9,428 — `Unassigned` when the auto-track trigger
                  left a row there for every part. `20260802144310` ended that; the real
                  figure is 57 at Contour, so this pager has never rendered in production. Kept
                  anyway: it is the right shape, and it costs nothing until it is needed. */}
              {locationMode && hereTotal > LOCATION_PAGE_SIZE && (
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ mb: 2, flexWrap: 'wrap' }}
                >
                  <Typography variant="body2" color="text.secondary">
                    {page * LOCATION_PAGE_SIZE + 1}–
                    {Math.min((page + 1) * LOCATION_PAGE_SIZE, hereTotal)} of {num(hereTotal)} here
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Button
                    size="small"
                    disabled={paging || page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="small"
                    disabled={paging || (page + 1) * LOCATION_PAGE_SIZE >= hereTotal}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </Stack>
              )}

              {/* Branch on what's VISIBLE, and say why it's empty. A company-wide search that
                  matched nothing used to render a blank card with no message at all. */}
              {visible.length === 0 ? (
                <Alert severity="info" sx={{ mb: 2 }}>
                  {search.trim()
                    ? `Nothing matches “${search.trim()}”.`
                    : locationMode
                      ? `${locationName} is empty.`
                      : 'Nothing to count yet — add a part first.'}
                </Alert>
              ) : (
              <Card elevation={2}>
                <Stack divider={<Divider />}>
                  {/* ONE ROW PER PART, even when it sits in several places. See `groups`. */}
                  {groups.map((g) => {
                    const allOn = g.rows.every((r) => selected.has(countRowKey(r)));
                    const places =
                      g.rows.length === 1 ? g.rows[0].target.locationPath : `${g.rows.length} locations`;
                    return (
                      <Box
                        key={g.partId}
                        onClick={() => toggleGroup(g)}
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
                          checked={allOn}
                          tabIndex={-1}
                          /* The place is in the name because a part can appear once per shelf on
                             the sheet this leads to; "Count BUY-ORING-214" three times over is an
                             ambiguous accessible name. */
                          inputProps={{
                            'aria-label':
                              g.rows.length === 1
                                ? `Count ${g.partName}`
                                : `Count ${g.partName} in ${g.rows.length} locations`,
                          }}
                        />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body1" noWrap>
                            {g.partName}
                          </Typography>
                          {/* Company-wide, this says where the count will be written. Place-scoped
                              it's the same word on every row — the page title already said it. */}
                          {!locationMode && (
                            <Typography variant="caption" color="text.secondary" noWrap>
                              {places}
                            </Typography>
                          )}
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {num(g.total)} {g.unit}
                        </Typography>
                      </Box>
                    );
                  })}
                </Stack>
              </Card>
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
                  {sheetGroups.map((g) => {
                    /*
                     * A part in one place is one flat row, exactly as before. A part in several
                     * gets a header plus an indented row per place.
                     *
                     * The header's `Counted` cell is deliberately EMPTY — not a dash, not a
                     * disabled field. A total field there would rebuild the very ambiguity this
                     * whole change removes: 38 against 10+20+10 has no defensible bin, and the
                     * fix is not to resolve that question but to never ask it. Typing per place
                     * is the answer, so the only inputs are on place rows.
                     */
                    const multi = g.rows.length > 1;
                    const countedHere = g.rows.filter(
                      (r) => entries[countRowKey(r)] !== undefined,
                    ).length;
                    const groupDelta = g.rows.reduce(
                      (sum, r) => sum + (rowDelta(r, entries) ?? 0),
                      0,
                    );

                    const placeRow = (c: CountCandidate) => {
                      const delta = rowDelta(c, entries);
                      const isCounted = delta !== null;
                      const matches = delta === 0;

                      // No row-level "done" tint: the variance cell already says whether a row
                      // has been actioned, and tinting the ground behind the figures only costs
                      // them contrast.
                      return (
                        // `countRowKey`, not `partId`: the sheet holds the SAME part once per
                        // shelf, and React's duplicate-key warning is explicit that it "may cause
                        // children to be duplicated and/or omitted".
                        <TableRow key={countRowKey(c)}>
                          <TableCell sx={{ width: '99%', pl: multi ? 5 : 2 }}>
                            {!multi && (
                              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                {c.partName}
                              </Typography>
                            )}
                            {/*
                              Both, joined — never `description ?? place`.
                              The `??` let a description outrank the place, so three rows of a
                              described part rendered identically: same name, same sub-line,
                              different Recorded figures and an input each. That is a
                              wrong-shelf write, not a cosmetic slip.
                              On a grouped part the header already carries name + description,
                              so a place row shows only its path.
                            */}
                            <Typography variant="caption" color="text.secondary">
                              {multi
                                ? c.target.locationPath
                                : [c.description, c.target.locationPath]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Typography>
                          </TableCell>

                          <TableCell align="right" sx={{ ...NUM_SX, color: 'text.secondary' }}>
                            {num(c.systemQuantity)}
                          </TableCell>

                          <TableCell align="right" sx={{ py: 1 }}>
                            <TextField
                              type="number"
                              size="small"
                              value={entries[countRowKey(c)] ?? ''}
                              onChange={(e) => setCount(countRowKey(c), e.target.value)}
                              placeholder="—"
                              inputProps={{
                                min: 0,
                                step: 'any',
                                inputMode: 'decimal',
                                // The place is part of the name: without it a part on three
                                // shelves has three controls sharing one accessible name, which
                                // is unusable by screen reader and untestable by role.
                                'aria-label': `Counted quantity for ${c.partName} in ${c.target.locationPath}`,
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
                    };

                    if (!multi) return placeRow(g.rows[0]);

                    return (
                      <Fragment key={g.partId}>
                        <TableRow sx={{ bgcolor: 'action.hover' }}>
                          <TableCell sx={{ width: '99%' }}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {g.partName}
                              </Typography>
                              <Chip size="small" label={`${g.rows.length} locations`} />
                            </Stack>
                            {g.description && (
                              <Typography variant="caption" color="text.secondary">
                                {g.description}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell align="right" sx={{ ...NUM_SX, color: 'text.secondary' }}>
                            {num(g.total)}
                          </TableCell>
                          {/* Empty on purpose — see the note above. */}
                          <TableCell />
                          {!sheetUnit && <TableCell />}
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            {countedHere > 0 && (
                              <>
                                <Typography
                                  component="div"
                                  variant="body2"
                                  sx={{
                                    ...NUM_SX,
                                    fontWeight: 700,
                                    color:
                                      groupDelta === 0
                                        ? 'text.disabled'
                                        : groupDelta > 0
                                          ? 'success.main'
                                          : 'error.main',
                                  }}
                                >
                                  {groupDelta === 0 ? 'No change' : signed(groupDelta)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {countedHere} of {g.rows.length} locations counted
                                </Typography>
                              </>
                            )}
                          </TableCell>
                        </TableRow>
                        {g.rows.map(placeRow)}
                        {/* Not offered in place-scoped mode: that sheet is about ONE bin, and
                            "Found something not listed?" above already adds a part to it. */}
                        {!locationMode && (
                          <TableRow>
                            <TableCell colSpan={sheetUnit ? 4 : 5} sx={{ pl: 5, py: 1 }}>
                              <LocationPicker
                                key={placeNonce}
                                label={`Count ${g.partName} somewhere else`}
                                options={destinationOptions}
                                value={null}
                                onChange={(place) => {
                                  if (place) {
                                    void addPartAtPlace({ id: g.partId, name: g.partName }, place);
                                  }
                                }}
                                unit={g.unit}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
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
          {/* No step-0 to go back TO in part-scope: the picker is suppressed there, so this
              button rendered a blank page under the header. Caught in the browser, not by a
              test — the step-0 block is conditional and the footer was not. */}
          {!partFirst && <Button onClick={() => setStep(0)}>Back</Button>}
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

      {/*
        Stock moved BETWEEN two places on this sheet (#656).

        A prompt, not a notice, and this is the one place on this page that blocks. Everywhere
        else a mid-count movement is reported afterwards, because the count IS what is on the
        shelf. That reasoning holds only while the rows are independent observations — and a
        transfer between two rows of the same part moves the same stock twice, so writing both
        absolutely puts back what legitimately left. By the time it could be explained the wrong
        number is already committed and the counter has walked away.
      */}
      <Dialog open={pending !== null} onClose={() => setPending(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Stock moved between locations you counted</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Both numbers were right when you wrote them, but something moved between the shelves
            in between — so saving them together would put back stock that has already left.
          </Typography>
          {(pending?.contested ?? []).map((rows) => (
            <Box key={rows[0].candidate.partId} sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {rows[0].candidate.partName}
              </Typography>
              {rows.map((v) => (
                <Typography
                  key={countRowKey(v.candidate)}
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block' }}
                >
                  {v.candidate.target.locationPath}: you counted {num(v.counted)}
                  {v.movedSinceOpened
                    ? ` — now reads ${num(v.candidate.systemQuantity)}, changed since you looked`
                    : ''}
                </Typography>
              ))}
            </Box>
          ))}
          <Typography variant="body2" color="text.secondary">
            The figures above have been refreshed. Recount the locations that changed, or save anyway
            if you know these numbers are right.
          </Typography>
        </DialogContent>
        <DialogActions>
          {/* Safe action first and on the right, as the default. Saving anyway stays reachable —
              the counter may have just walked both shelves again and know better than we do. */}
          <Button
            onClick={() => pending && void runCommit(pending.toCommit, pending.unseenPlaces)}
            color="inherit"
          >
            Save anyway
          </Button>
          <Button variant="contained" onClick={() => setPending(null)} autoFocus>
            Let me recount
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
