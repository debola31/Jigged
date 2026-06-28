import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import VendorContactModal from '@/components/vendors/VendorContactModal';
import {
  createVendorContact,
  updateVendorContact,
} from '@/utils/vendorContactsAccess';
import type { VendorContact } from '@/types/vendorContact';

vi.mock('@/utils/vendorContactsAccess', () => ({
  createVendorContact: vi.fn(),
  updateVendorContact: vi.fn(),
}));

const contact = (id: string, name: string): VendorContact =>
  ({
    id,
    vendor_id: 'vend1',
    name,
    role: 'sales',
    role_label: null,
    email: null,
    phone: null,
    is_primary: false,
    created_at: '',
    updated_at: '',
  }) as unknown as VendorContact;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const nameField = () => screen.getByLabelText(/name/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  (createVendorContact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (updateVendorContact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('VendorContactModal — reopen shows fresh (re-seeded) state', () => {
  it('re-seeds the Name field from a DIFFERENT existing contact on reopen (no stale carry-over)', async () => {
    const base = { open: true, onClose: vi.fn(), vendorId: 'vend1', onSaved: vi.fn() };

    // Open editing contact A ("Alice").
    const { rerender } = render(
      wrap(<VendorContactModal {...base} existing={contact('a', 'Alice')} />),
    );
    await waitFor(() => expect(nameField().value).toBe('Alice'));

    // Close.
    rerender(
      wrap(
        <VendorContactModal {...base} open={false} existing={contact('a', 'Alice')} />,
      ),
    );

    // Reopen editing a DIFFERENT contact B ("Bob") — must show Bob, never stale Alice.
    rerender(wrap(<VendorContactModal {...base} existing={contact('b', 'Bob')} />));
    await waitFor(() => expect(nameField().value).toBe('Bob'));
    expect(nameField().value).not.toBe('Alice');
  });

  it('clears the Name field when reopened in add-mode after editing a contact', async () => {
    const base = { open: true, onClose: vi.fn(), vendorId: 'vend1', onSaved: vi.fn() };

    const { rerender } = render(
      wrap(<VendorContactModal {...base} existing={contact('a', 'Alice')} />),
    );
    await waitFor(() => expect(nameField().value).toBe('Alice'));

    rerender(
      wrap(
        <VendorContactModal {...base} open={false} existing={contact('a', 'Alice')} />,
      ),
    );
    // Reopen with no `existing` → "Add Contact" → empty form.
    rerender(wrap(<VendorContactModal {...base} existing={undefined} />));
    await waitFor(() => expect(nameField().value).toBe(''));
  });
});
