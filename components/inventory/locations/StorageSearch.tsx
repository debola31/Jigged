'use client';

/**
 * Finds a place on the Places board. The page-level search on that tab.
 *
 * ## It used to find parts too — 2026-09-09
 *
 * **Withdrawn:** *"a box that answers whatever you type cannot be the wrong box"*, which is why
 * this searched places AND parts. Wrong now because there are two tabs, and the box sits on the
 * one that is only about places. The dead end that argument closed — typing a part number into
 * the only search on the screen and being told *"Nothing matches"* — is closed by the Inventory
 * tab instead, which is a whole surface for parts rather than a group inside a dropdown.
 *
 * Keeping parts here would mean a search on the Places tab that answers with things the Places tab
 * cannot show, and two boxes that each find parts. One box per tab, each matching what its tab is
 * about.
 *
 * ## Where it sits, and why that matters
 *
 * In the page bar, above the list/detail split, with `Print all labels`. It is the one control on
 * this screen that acts on neither the list nor the selection, so it belongs to neither column —
 * the same reason `Add storage` moved down into the list's own header, where the thing it adds to
 * lives.
 */

import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { orderUnits } from '@/lib/locationGrid';

/** A hit: a unit to select. */
export type StorageHit = { kind: 'place'; id: string; label: string };

export interface StorageSearchProps {
  /** Roots, for matching unit names without a read. */
  tree: InventoryLocationNode[];
  /** A place hit selects the unit. */
  onPick: (hit: StorageHit) => void;
}

export default function StorageSearch({ tree, onPick }: StorageSearchProps) {
  const [text, setText] = useState('');

  /*
   * No debounce and no request any more: the unit list is already in memory, so matching is
   * synchronous. The 250ms wait and the spinner both existed for the part read, which has gone
   * with the parts group.
   */
  const options: StorageHit[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return orderUnits(tree)
      .filter((u) => u.name.toLowerCase().includes(q))
      .map((u) => ({ kind: 'place' as const, id: u.id, label: u.name }));
  }, [text, tree]);

  return (
    <Autocomplete
      options={options}
      // The field is a search, not a selection that sticks: picking navigates and the box clears.
      value={null}
      inputValue={text}
      onInputChange={(_, v, reason) => setText(reason === 'reset' ? '' : v)}
      onChange={(_, hit) => {
        if (!hit) return;
        onPick(hit);
        setText('');
      }}
      // Matching happens above, against unit names in memory.
      filterOptions={(o) => o}
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      noOptionsText={`No storage unit matches “${text.trim()}”.`}
      renderOption={(props, o) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={key} {...rest}>
            <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
              {o.label}
            </Typography>
          </Box>
        );
      }}
      sx={{ width: { xs: '100%', sm: 380 } }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          placeholder="Find a location…"
          slotProps={{
            input: {
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      )}
    />
  );
}
