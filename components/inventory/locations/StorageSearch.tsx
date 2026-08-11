'use client';

/**
 * One box that finds a place OR a part. The page-level search on Storage.
 *
 * ## The dead end it closes
 *
 * Storage is place-first: you pick a cabinet, then a bin. That is the right default, and it left
 * one question unanswerable from the page — the one where you know the PART and not the place. The
 * only search on the screen filtered storage-unit NAMES, so typing a part number into it produced
 * *"Nothing matches"*: a dead end wearing the clothes of an answer, in the box a person would
 * obviously try first.
 *
 * **One box rather than two.** A separate `Find a part` beside `Find a place` would have fixed the
 * capability and kept the trap — the failure is not that part search is missing, it is that people
 * type a part into the box that is there. A box that answers whatever you type cannot be the wrong
 * box.
 *
 * ## Two kinds of answer, said apart
 *
 * Results are grouped, because a place and a part are different things to have found:
 *
 *   PLACES   Cabinet 3                    → selects the unit
 *   PARTS    BUY-ORING-214                → selects the unit AND opens that bin
 *              Cabinet 3 › Shelf A · 828 ea
 *
 * A part in three bins is **three rows**, not one total. You are not trying to learn how many you
 * own — Parts answers that — you are trying to learn which shelf to walk to, and a sum tells you
 * nothing about which. Ordered by quantity so the shelf holding most of it leads.
 *
 * ## Where it sits, and why that matters
 *
 * In the page bar, above the list/detail split, with `Print all labels`. It is the one control on
 * this screen that acts on neither the list nor the selection, so it belongs to neither column —
 * the same reason `Add storage` moved down into the list's own header, where the thing it adds to
 * lives.
 */

import { useEffect, useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';

import { searchPartPlacements, type PartPlacement } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';
import { orderUnits } from '@/lib/locationGrid';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** A hit: either a unit to select, or a part sitting in one specific place. */
export type StorageHit =
  | { kind: 'place'; id: string; label: string }
  | {
      kind: 'part';
      id: string;
      label: string;
      partName: string;
      /** The full path of the bin it is in — the answer, and the row's second line. */
      where: string;
      qty: string;
      /** The bin itself, so the caller can open it rather than leave the last step to be guessed. */
      locationId: string;
      /** The root unit that bin belongs to, so the grid beside it is the right one. */
      unitId: string;
    };

export interface StorageSearchProps {
  companyId: string;
  /** Roots, for matching unit names without another read. */
  tree: InventoryLocationNode[];
  /** Every location, so a part's `location_id` can be turned into a path and its owning unit. */
  byId: Map<string, InventoryLocation>;
  /** A place hit selects the unit; a part hit selects its unit and opens that place. */
  onPick: (hit: StorageHit) => void;
}

/** Root → leaf names for a location, and the root it belongs to. */
function trail(locationId: string, byId: Map<string, InventoryLocation>) {
  const names: string[] = [];
  let cursor: string | null = locationId;
  let root = locationId;
  const guard = new Set<string>();
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const node: InventoryLocation = byId.get(cursor)!;
    names.unshift(node.name);
    root = node.id;
    cursor = node.parent_id;
  }
  return { path: names.join(' › '), unitId: root };
}

export default function StorageSearch({ companyId, tree, byId, onPick }: StorageSearchProps) {
  const [text, setText] = useState('');
  const [placements, setPlacements] = useState<PartPlacement[]>([]);
  const [loading, setLoading] = useState(false);

  /*
   * Debounced, because every keystroke would otherwise query every stock row in the company. The
   * unit list is already in memory and is matched live below — only the part read waits.
   *
   * `setLoading` sits INSIDE the timeout rather than in the effect body, matching
   * `PartAutocomplete`: it keeps the spinner tied to the fetch rather than to the wait, and keeps
   * the effect off the set-state-in-effect rule.
   */
  useEffect(() => {
    const q = text.trim();
    let active = true;
    // EVERY setState below sits inside the callback, including the clear — a synchronous one in
    // the effect body is what the cascading-render rule is about.
    const timer = setTimeout(async () => {
      if (q.length < 2) {
        if (active) setPlacements([]);
        return;
      }
      setLoading(true);
      try {
        const rows = await searchPartPlacements(companyId, q);
        if (active) setPlacements(rows);
      } catch (e) {
        // A failed lookup is not worth a dialog over a search box; the empty state already says
        // nothing matched, and the console carries the reason.
        console.error('Storage search failed:', e);
        if (active) setPlacements([]);
      } finally {
        if (active) setLoading(false);
      }
      // Clearing needs no wait; only a real query does.
    }, text.trim().length < 2 ? 0 : 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [companyId, text]);

  const options: StorageHit[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];

    const places: StorageHit[] = orderUnits(tree)
      .filter((u) => u.name.toLowerCase().includes(q))
      .map((u) => ({ kind: 'place' as const, id: u.id, label: u.name }));

    const parts: StorageHit[] = placements.map((p) => {
      const { path, unitId } = trail(p.locationId, byId);
      return {
        kind: 'part' as const,
        // A part in three bins is three rows, so the key has to carry the place too.
        id: `${p.partId}::${p.locationId}`,
        label: p.partName,
        partName: p.partName,
        where: path || 'Unknown place',
        qty: `${num(p.quantity)} ${p.primaryUnit ?? ''}`.trim(),
        locationId: p.locationId,
        unitId,
      };
    });

    return [...places, ...parts];
  }, [text, tree, placements, byId]);

  return (
    <Autocomplete
      options={options}
      loading={loading}
      // The field is a search, not a selection that sticks: picking navigates and the box clears.
      value={null}
      inputValue={text}
      onInputChange={(_, v, reason) => setText(reason === 'reset' ? '' : v)}
      onChange={(_, hit) => {
        if (!hit) return;
        onPick(hit);
        setText('');
      }}
      // Matching happens above — against unit names in memory and part names on the server. MUI's
      // own filter would then re-filter the server's results by their LABEL, hiding a part whose
      // match was on something the label does not show.
      filterOptions={(o) => o}
      groupBy={(o) => (o.kind === 'place' ? 'Places' : 'Parts')}
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      noOptionsText={
        text.trim().length < 2 ? 'Keep typing…' : `Nothing in storage matches “${text.trim()}”.`
      }
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={key} {...rest} sx={{ display: 'block' }}>
            <Typography variant="body2" noWrap>
              {o.label}
            </Typography>
            {o.kind === 'part' && (
              // The place IS the answer here, so it is on the row rather than a hover away.
              <Typography variant="caption" color="text.secondary" noWrap>
                {o.where} · {o.qty}
              </Typography>
            )}
          </Box>
        );
      }}
      sx={{ width: { xs: '100%', sm: 380 } }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          placeholder="Find a part or a place…"
          slotProps={{
            input: {
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: (
                <>
                  {loading ? <CircularProgress size={16} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
          }}
        />
      )}
    />
  );
}
