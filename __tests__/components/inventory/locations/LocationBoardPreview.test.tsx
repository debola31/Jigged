/**
 * The builder's storage preview.
 *
 * Untested until now — it was only ever exercised incidentally through
 * `VisualLocationBuilder.test.tsx`'s `findByText('Cabinet 1')`, so none of its summarisation
 * thresholds or kind branches were pinned. They are now, because the same drawing is about to
 * back the permanent board and a silent change to either would break §5.5's promise that what
 * you preview is what you live with.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import LocationBoardPreview from '@/components/inventory/locations/builder/LocationBoardPreview';
import { buildSpecFromLevels } from '@/utils/locationSpec';
import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';

const renderPreview = (nodes: LocationSpecNode[]) =>
  render(<LocationBoardPreview nodes={nodes} />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

const spec = (levels: LevelSpec[]) => buildSpecFromLevels(levels);

describe('LocationBoardPreview', () => {
  it('prompts for a count when there is nothing to draw', () => {
    renderPreview([]);
    expect(screen.getByText(/set a count to see your storage take shape/i)).toBeInTheDocument();
  });

  it('draws a unit with its name, code and sections', () => {
    renderPreview(spec([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'row', count: 2, namePattern: 'Row {n}' },
    ]));

    expect(screen.getByText('Cabinet 1')).toBeInTheDocument();
    expect(screen.getByText('C01')).toBeInTheDocument();
    expect(screen.getByText('Row 1')).toBeInTheDocument();
    expect(screen.getByText('Row 2')).toBeInTheDocument();
  });

  /**
   * A cell's child count is the only quantitative thing a preview can honestly show.
   *
   * Needs four levels to reach: a node only becomes a *cell* (rather than a section label) when
   * it sits inside a section's compartment grid, and it only carries a count when it has
   * children of its own. cabinet › row › side › bin puts "Left" in the grid with 2 bins inside.
   */
  it('annotates a cell with how many things are inside it', () => {
    renderPreview(spec([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'row', count: 1, namePattern: 'Row {n}' },
      { kind: 'side', names: ['Left', 'Right'] },
      { kind: 'bin', count: 2, namePattern: 'Bin {n}' },
    ]));
    // Name and count are adjacent JSX expressions, so match on combined text content.
    expect(
      screen.getByText((_, el) => el?.textContent === 'Left ·2' && el.tagName === 'SPAN'),
    ).toBeInTheDocument();
  });

  it('draws a flat set as one row of compartments rather than empty units', () => {
    renderPreview(spec([{ kind: 'bin', count: 3, namePattern: 'Bin {n}' }]));
    expect(screen.getByText('Bin 1')).toBeInTheDocument();
    expect(screen.getByText('Bin 3')).toBeInTheDocument();
  });

  // FILL_MAX = 8: beyond that the width can't be divided legibly, so cells wrap as chips.
  // Both shapes render every name up to CELL_LIMIT, so the assertion is that 9 still all show.
  it('keeps every cell visible past the even-fill threshold', () => {
    renderPreview(spec([
      { kind: 'shelving', count: 1, namePattern: 'Unit {n}' },
      { kind: 'bin', count: 9, namePattern: 'Bin {n}' },
    ]));
    for (const n of [1, 5, 9]) {
      expect(screen.getByText(new RegExp(`Bin 0?${n}\\b`))).toBeInTheDocument();
    }
  });

  // CELL_LIMIT = 20.
  it('summarises cells beyond the cell limit with a +N', () => {
    renderPreview(spec([
      { kind: 'shelving', count: 1, namePattern: 'Unit {n}' },
      { kind: 'bin', count: 25, namePattern: 'Bin {n}' },
    ]));
    expect(screen.getByText('+5')).toBeInTheDocument();
  });

  // SECTION_LIMIT = 16.
  it('summarises sections beyond the section limit', () => {
    renderPreview(spec([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'row', count: 20, namePattern: 'Row {n}' },
      { kind: 'side', names: ['Left', 'Right'] },
    ]));
    expect(screen.getByText('+4 more')).toBeInTheDocument();
  });

  // TOP_LIMIT = 24. A preview may truncate; the permanent board deliberately may not.
  it('summarises top-level units beyond the top limit', () => {
    renderPreview(spec([
      { kind: 'cabinet', count: 30, namePattern: 'Cabinet {n}' },
      { kind: 'row', count: 2, namePattern: 'Row {n}' },
    ]));
    expect(screen.getByText('+6 more')).toBeInTheDocument();
  });
});
