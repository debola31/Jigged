import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import CustomerFormModal from '@/components/customers/CustomerFormModal';

// CustomerForm (rendered inside the modal) pulls these in.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ companyId: 'co1' }),
}));
vi.mock('@/utils/customerAccess', () => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
  checkCustomerNameExists: vi.fn(),
}));

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const nameField = () => screen.getByLabelText(/company name/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerFormModal — reopen remounts a fresh CustomerForm (formKey bump)', () => {
  it('clears a typed Company Name when the modal is closed and reopened (no stale value)', async () => {
    const base = { open: true, onClose: vi.fn(), onCreated: vi.fn(), companyId: 'co1' };

    const { rerender } = render(wrap(<CustomerFormModal {...base} />));

    // Form renders fresh and empty.
    await waitFor(() => expect(nameField()).toBeInTheDocument());
    expect(nameField().value).toBe('');

    // Type a name into the embedded form.
    await userEvent.type(nameField(), 'Leftover Co');
    expect(nameField().value).toBe('Leftover Co');

    // Close, then reopen — onEnter bumps formKey, remounting CustomerForm fresh.
    rerender(wrap(<CustomerFormModal {...base} open={false} />));
    rerender(wrap(<CustomerFormModal {...base} open />));

    await waitFor(() => expect(nameField().value).toBe(''));
  });
});
