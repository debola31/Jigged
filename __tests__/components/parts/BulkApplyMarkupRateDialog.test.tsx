import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import BulkApplyMarkupRateDialog from '@/components/parts/BulkApplyMarkupRateDialog';
import { getAllMarkupRates } from '@/utils/markupRatesAccess';
import type { MarkupRate } from '@/types/markupRates';

vi.mock('@/utils/markupRatesAccess', () => ({
  getAllMarkupRates: vi.fn(),
  bulkApplyMarkupRate: vi.fn(),
}));

const rate = (id: string, name: string, isDefault: boolean): MarkupRate =>
  ({ id, name, is_default: isDefault, breakpoints: [] }) as unknown as MarkupRate;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const props = {
  companyId: 'co1',
  partIds: ['p1', 'p2'],
  onClose: vi.fn(),
  onApplied: vi.fn(),
};

const checkedRow = () =>
  screen.getByTestId('RadioButtonCheckedIcon').closest('.MuiListItemButton-root');

beforeEach(() => {
  vi.clearAllMocks();
  (getAllMarkupRates as ReturnType<typeof vi.fn>).mockResolvedValue([
    rate('r1', 'Standard', false),
    rate('r2', 'Premium', true),
  ]);
});

describe('BulkApplyMarkupRateDialog — load + auto-select on (re)open', () => {
  it('reloads rates and re-selects the default each time it reopens', async () => {
    const { rerender } = render(wrap(<BulkApplyMarkupRateDialog open {...props} />));

    // onEnter loads rates and auto-selects the default one.
    await waitFor(() => expect(getAllMarkupRates).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkedRow()).toHaveTextContent('Premium (default)'));

    // Pick the non-default rate.
    await userEvent.click(screen.getByText('Standard'));
    expect(checkedRow()).toHaveTextContent('Standard');

    // Close, then reopen — the selection must reset to the default, never the
    // stale pick from the previous open.
    rerender(wrap(<BulkApplyMarkupRateDialog open={false} {...props} />));
    rerender(wrap(<BulkApplyMarkupRateDialog open {...props} />));

    await waitFor(() => expect(getAllMarkupRates).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkedRow()).toHaveTextContent('Premium (default)'));
  });
});
