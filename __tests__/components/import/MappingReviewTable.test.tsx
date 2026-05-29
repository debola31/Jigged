import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import MappingReviewTable from '@/components/import/MappingReviewTable';
import type { ColumnMapping, FieldDefinition } from '@/components/import/types';

const fields: FieldDefinition[] = [
  { key: 'customer_code', label: 'Customer Code', required: true },
  { key: 'name', label: 'Company Name', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'phone', label: 'Phone', required: false },
];

function makeMapping(overrides: Partial<ColumnMapping> = {}): ColumnMapping {
  return {
    csv_column: 'CSV Column',
    db_field: 'name',
    confidence: 0.9,
    reasoning: 'Names match closely',
    needs_review: false,
    ...overrides,
  };
}

function renderTable(overrides: Partial<React.ComponentProps<typeof MappingReviewTable>> = {}) {
  const onMappingChange = vi.fn();
  const props: React.ComponentProps<typeof MappingReviewTable> = {
    mappings: [makeMapping()],
    fields,
    unmappedRequired: [],
    unmappedOptional: [],
    discardedColumns: [],
    onMappingChange,
    ...overrides,
  };
  return { onMappingChange, ...render(<MappingReviewTable {...props} />) };
}

describe('MappingReviewTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per mapping with csv_column + reasoning', () => {
    renderTable({
      mappings: [
        makeMapping({ csv_column: 'Code', db_field: 'customer_code', reasoning: 'Direct match' }),
        makeMapping({ csv_column: 'Name', db_field: 'name', reasoning: 'Names match' }),
      ],
    });

    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Direct match')).toBeInTheDocument();
    expect(screen.getByText('Names match')).toBeInTheDocument();
  });

  it('hides the needs-review alert when no mappings need review', () => {
    renderTable({ mappings: [makeMapping({ needs_review: false })] });
    expect(screen.queryByText(/needs? review/i)).not.toBeInTheDocument();
  });

  it('shows the needs-review alert with singular wording for one needs-review mapping', () => {
    renderTable({
      mappings: [
        makeMapping({ csv_column: 'Phn', db_field: 'phone', needs_review: true, confidence: 0.4 }),
      ],
    });
    // Plural-vs-singular: "1 column needs review (highlighted in yellow below)"
    expect(screen.getByText(/^1 column needs review/i)).toBeInTheDocument();
  });

  it('shows the needs-review alert with plural wording for multiple', () => {
    renderTable({
      mappings: [
        makeMapping({ csv_column: 'A', db_field: 'name', needs_review: true, confidence: 0.4 }),
        makeMapping({ csv_column: 'B', db_field: 'phone', needs_review: true, confidence: 0.4 }),
      ],
    });
    expect(screen.getByText(/^2 columns need review/i)).toBeInTheDocument();
  });

  it('ignores needs_review when db_field is null (would-skip mappings)', () => {
    renderTable({
      mappings: [makeMapping({ db_field: null, needs_review: true })],
    });
    // The "needs review" count gates on `db_field !== null`.
    expect(screen.queryByText(/needs? review/i)).not.toBeInTheDocument();
  });

  it('calls onMappingChange with the new db_field when the user changes the dropdown', async () => {
    const { onMappingChange } = renderTable({
      mappings: [
        makeMapping({ csv_column: 'CodeCol', db_field: 'name' }),
      ],
    });
    const user = userEvent.setup();
    // Open the Select; MUI renders as combobox role
    const select = screen.getByRole('combobox');
    await user.click(select);
    // The listbox is rendered as a portal — query against `document` rather
    // than the existing render tree.
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('Customer Code *'));

    expect(onMappingChange).toHaveBeenCalledWith('CodeCol', 'customer_code');
  });

  it('calls onMappingChange with null when "Skip" is selected', async () => {
    const { onMappingChange } = renderTable({
      mappings: [makeMapping({ csv_column: 'Extra', db_field: 'phone' })],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/skip \(don't import\)/i));

    expect(onMappingChange).toHaveBeenCalledWith('Extra', null);
  });

  it('opens the reassignment dialog when the user picks an already-assigned db_field', async () => {
    const { onMappingChange } = renderTable({
      mappings: [
        makeMapping({ csv_column: 'A', db_field: 'name' }),
        makeMapping({ csv_column: 'B', db_field: 'email' }),
      ],
    });
    const user = userEvent.setup();
    // Open the SECOND combobox and try to pick 'name' (already assigned to A)
    const combos = screen.getAllByRole('combobox');
    await user.click(combos[1]);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('Company Name *'));

    // ReassignmentDialog should open; onMappingChange should NOT fire yet
    // (it fires after the user confirms in the dialog).
    expect(onMappingChange).not.toHaveBeenCalled();
  });

  it('renders a ConfidenceChip in the table only when db_field is non-null', () => {
    const { container } = renderTable({
      mappings: [
        makeMapping({ csv_column: 'Has', db_field: 'name', confidence: 0.9 }),
        makeMapping({ csv_column: 'Skipped', db_field: null }),
      ],
    });
    // Two rows, one chip — chip lives inside the Confidence column.
    const chips = container.querySelectorAll('.MuiChip-root');
    expect(chips.length).toBe(1);
  });
});
