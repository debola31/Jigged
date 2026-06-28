import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import MetricPickerModal from '@/components/dashboard/MetricPickerModal';
import type { MetricKey } from '@/utils/dashboardAccess';

// The modal imports the (pure) metric constants from @/utils/dashboardAccess,
// which transitively loads @/lib/supabase and instantiates a browser client at
// module-eval. Stub the client factory so the import is side-effect-free — the
// constants under test (PICKABLE_METRICS / PINNED_METRIC_SLOTS) are pure data
// and don't touch Supabase, so they stay real.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
  createClient: () => ({}),
  supabase: null,
}));

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

// Row for a metric label → its checkbox. Each metric label sits inside a
// ListItemButton that also wraps the checkbox.
const checkboxFor = (label: RegExp | string): HTMLInputElement => {
  const row = screen.getByText(label).closest('li') as HTMLElement;
  return within(row).getByRole('checkbox') as HTMLInputElement;
};

describe('MetricPickerModal — reopen re-seeds selection from currentKeys', () => {
  it('drops an in-modal-added metric when reopened with the SAME currentKeys (no stale selection)', async () => {
    const currentKeys: MetricKey[] = ['open_quotes'];
    const base = { open: true, onClose: vi.fn(), onSave: vi.fn() };

    const { rerender } = render(
      wrap(<MetricPickerModal {...base} currentKeys={currentKeys} />),
    );

    // Seeded: Open Quotes checked, Revenue not.
    await waitFor(() => expect(checkboxFor(/open quotes/i).checked).toBe(true));
    expect(checkboxFor(/revenue/i).checked).toBe(false);

    // Add Revenue in the modal → now 2 selected.
    await userEvent.click(screen.getByText(/revenue/i));
    await waitFor(() => expect(checkboxFor(/revenue/i).checked).toBe(true));

    // Close, then reopen with the SAME currentKeys — selection must re-seed from
    // currentKeys, so the just-added Revenue is no longer selected.
    rerender(wrap(<MetricPickerModal {...base} open={false} currentKeys={currentKeys} />));
    rerender(wrap(<MetricPickerModal {...base} currentKeys={currentKeys} />));

    await waitFor(() => expect(checkboxFor(/revenue/i).checked).toBe(false));
    // Open Quotes (the seed) is still selected — proves it re-seeded, not just emptied.
    expect(checkboxFor(/open quotes/i).checked).toBe(true);
  });
});
