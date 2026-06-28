import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import CustomerContactModal from '@/components/customers/CustomerContactModal';
import {
  createCustomerContact,
  updateCustomerContact,
} from '@/utils/customerContactsAccess';
import type { CustomerContact } from '@/types/customerContact';

vi.mock('@/utils/customerContactsAccess', () => ({
  createCustomerContact: vi.fn(),
  updateCustomerContact: vi.fn(),
}));

const contact = (id: string, name: string): CustomerContact =>
  ({
    id,
    customer_id: 'cust1',
    name,
    role: 'buyer',
    role_label: null,
    email: null,
    phone: null,
    is_primary: false,
    created_at: '',
    updated_at: '',
  }) as unknown as CustomerContact;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const nameField = () => screen.getByLabelText(/name/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  (createCustomerContact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (updateCustomerContact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('CustomerContactModal — reopen shows fresh (re-seeded) state', () => {
  it('re-seeds the Name field from a DIFFERENT existing contact on reopen (no stale carry-over)', async () => {
    const base = { open: true, onClose: vi.fn(), customerId: 'cust1', onSaved: vi.fn() };

    // Open editing contact A ("Alice").
    const { rerender } = render(
      wrap(<CustomerContactModal {...base} existing={contact('a', 'Alice')} />),
    );
    await waitFor(() => expect(nameField().value).toBe('Alice'));

    // Close.
    rerender(
      wrap(
        <CustomerContactModal {...base} open={false} existing={contact('a', 'Alice')} />,
      ),
    );

    // Reopen editing a DIFFERENT contact B ("Bob") — must show Bob, never stale Alice.
    rerender(wrap(<CustomerContactModal {...base} existing={contact('b', 'Bob')} />));
    await waitFor(() => expect(nameField().value).toBe('Bob'));
    expect(nameField().value).not.toBe('Alice');
  });

  it('clears the Name field when reopened in add-mode after editing a contact', async () => {
    const base = { open: true, onClose: vi.fn(), customerId: 'cust1', onSaved: vi.fn() };

    const { rerender } = render(
      wrap(<CustomerContactModal {...base} existing={contact('a', 'Alice')} />),
    );
    await waitFor(() => expect(nameField().value).toBe('Alice'));

    rerender(
      wrap(
        <CustomerContactModal {...base} open={false} existing={contact('a', 'Alice')} />,
      ),
    );
    // Reopen with no `existing` → "Add Contact" → empty form.
    rerender(wrap(<CustomerContactModal {...base} existing={undefined} />));
    await waitFor(() => expect(nameField().value).toBe(''));
  });
});
