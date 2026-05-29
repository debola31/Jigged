import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ConflictDialog from '@/components/import/ConflictDialog';

interface TestConflict {
  row_number: number;
  customer_code?: string;
  name?: string;
  existing_value?: string;
}

interface TestError {
  row_number: number;
  message?: string;
  field?: string;
}

const conflictColumns = [
  { key: 'customer_code' as const, label: 'Code' },
  { key: 'name' as const, label: 'Name' },
];

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConflictDialog<TestConflict, TestError>>> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const props = {
    open: true,
    conflicts: [] as TestConflict[],
    validationErrors: [] as TestError[],
    validRowsCount: 0,
    totalRows: 0,
    onCancel,
    onConfirm,
    entityName: 'Customers',
    conflictColumns,
    getConflictLabel: (c: TestConflict) => `Duplicate code ${c.customer_code}`,
    getErrorMessage: (e: TestError) => e.message ?? 'Unknown error',
    ...overrides,
  } as React.ComponentProps<typeof ConflictDialog<TestConflict, TestError>>;
  return { onCancel, onConfirm, ...render(<ConflictDialog {...props} />) };
}

// Capture the genuine createElement ONCE so the spy below doesn't recurse on
// itself (which would otherwise blow the stack across tests).
const realCreateElement = document.createElement.bind(document);

describe('ConflictDialog', () => {
  // Mock the browser download primitives once for the whole suite.
  const createObjectURL = vi.fn(() => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  const linkClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    // Hook only the anchor path used by downloadCsv. Everything else uses
    // the real createElement.
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'a') {
        el.click = linkClick;
      }
      return el;
    }) as typeof document.createElement);
  });

  it('renders the headline counts (can-import / will-skip / total)', () => {
    renderDialog({
      conflicts: [{ row_number: 2, customer_code: 'DUP' }],
      validationErrors: [{ row_number: 3, message: 'Missing name' }],
      validRowsCount: 8,
      totalRows: 10,
    });

    // Headline counts render as h4. Anchor on that selector to avoid
    // matching row numbers in the conflict / error tables.
    const headlineNumbers = document.querySelectorAll('.MuiTypography-h4');
    const values = Array.from(headlineNumbers).map((el) => el.textContent);
    expect(values).toEqual(['8', '2', '10']);
  });

  it('de-duplicates the skipped count when a row appears in both lists', () => {
    renderDialog({
      conflicts: [{ row_number: 5, customer_code: 'DUP' }],
      validationErrors: [{ row_number: 5, message: 'Missing name' }],
      validRowsCount: 1,
      totalRows: 2,
    });

    // Row 5 in both lists → skipped count should be 1 (de-duped), not 2.
    const headlineNumbers = document.querySelectorAll('.MuiTypography-h4');
    const values = Array.from(headlineNumbers).map((el) => el.textContent);
    // [valid, skipped, total]
    expect(values).toEqual(['1', '1', '2']);
  });

  it('disables the import button when validRowsCount is 0', () => {
    renderDialog({ validRowsCount: 0, totalRows: 3 });
    const btn = screen.getByRole('button', { name: /import 0 customers/i });
    expect(btn).toBeDisabled();
  });

  it('enables the import button and labels it with the count', () => {
    renderDialog({ validRowsCount: 7 });
    const btn = screen.getByRole('button', { name: /import 7 customers/i });
    expect(btn).toBeEnabled();
  });

  it('calls onConfirm when the import button is clicked', async () => {
    const { onConfirm } = renderDialog({ validRowsCount: 3 });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /import 3 customers/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel Import is clicked', async () => {
    const { onCancel } = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /cancel import/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the conflicts table with row + custom columns', () => {
    renderDialog({
      conflicts: [
        { row_number: 2, customer_code: 'ACME', name: 'Acme Corp', existing_value: 'ACME01' },
      ],
      validRowsCount: 0,
      totalRows: 1,
    });
    expect(screen.getByText(/conflicting rows \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('ACME')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Duplicate code ACME')).toBeInTheDocument();
    expect(screen.getByText('ACME01')).toBeInTheDocument();
  });

  it('renders the validation errors table with error messages', () => {
    renderDialog({
      validationErrors: [
        { row_number: 5, message: 'name is required' },
        { row_number: 9, message: 'email format invalid' },
      ],
      validRowsCount: 0,
      totalRows: 2,
    });
    expect(screen.getByText(/validation errors \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText('name is required')).toBeInTheDocument();
    expect(screen.getByText('email format invalid')).toBeInTheDocument();
  });

  it('downloads a CSV when "Download CSV" for conflicts is clicked', async () => {
    renderDialog({
      conflicts: [{ row_number: 2, customer_code: 'ACME', existing_value: 'ACME01' }],
      validRowsCount: 0,
      totalRows: 1,
    });
    const user = userEvent.setup();
    const buttons = screen.getAllByRole('button', { name: /download csv/i });
    await user.click(buttons[0]);
    expect(createObjectURL).toHaveBeenCalled();
    expect(linkClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('hides the conflicts table when there are no conflicts', () => {
    renderDialog({
      conflicts: [],
      validationErrors: [{ row_number: 1, message: 'bad' }],
      validRowsCount: 0,
      totalRows: 1,
    });
    expect(screen.queryByText(/conflicting rows/i)).not.toBeInTheDocument();
    expect(screen.getByText(/validation errors/i)).toBeInTheDocument();
  });

  it('hides the validation-errors table when there are no errors', () => {
    renderDialog({
      conflicts: [{ row_number: 1, customer_code: 'X' }],
      validRowsCount: 0,
      totalRows: 1,
    });
    expect(screen.getByText(/conflicting rows/i)).toBeInTheDocument();
    expect(screen.queryByText(/validation errors/i)).not.toBeInTheDocument();
  });
});
