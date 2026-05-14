import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, routerMocks, resetRouterMocks } from '../../test-utils';
import CustomerForm from '@/components/customers/CustomerForm';
import { EMPTY_CUSTOMER_FORM } from '@/types/customer';
import type { CustomerFormData, Customer } from '@/types/customer';

// Mock customerAccess utilities
const mockCreateCustomer = vi.fn();
const mockUpdateCustomer = vi.fn();
const mockSoftDeleteCustomer = vi.fn();
const mockCheckCustomerNameExists = vi.fn();

vi.mock('@/utils/customerAccess', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  updateCustomer: (...args: unknown[]) => mockUpdateCustomer(...args),
  softDeleteCustomer: (...args: unknown[]) => mockSoftDeleteCustomer(...args),
  checkCustomerNameExists: (...args: unknown[]) => mockCheckCustomerNameExists(...args),
}));

describe('CustomerForm', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    // Default: customer name doesn't exist (validation passes)
    mockCheckCustomerNameExists.mockResolvedValue(false);
  });

  describe('Validation', () => {
    it('shows error when name is empty on submit', async () => {
      render(
        <CustomerForm
          mode="create"
          initialData={EMPTY_CUSTOMER_FORM}
        />
      );

      // Verify the Company Name field exists and is empty
      const nameInput = screen.getByLabelText(/company name/i);
      expect(nameInput).toHaveValue('');

      // Submit the form directly using fireEvent to bypass HTML5 validation
      const form = document.querySelector('form');
      fireEvent.submit(form!);

      // Should show validation error in the helper text
      expect(await screen.findByText(/company name is required/i)).toBeInTheDocument();

      // Should not have called createCustomer
      expect(mockCreateCustomer).not.toHaveBeenCalled();
    });
  });

  describe('Create mode', () => {
    const validFormData: CustomerFormData = {
      ...EMPTY_CUSTOMER_FORM,
      name: 'New Test Company',
    };

    it('creates customer and redirects on success', async () => {
      const mockCustomer: Customer = {
        id: 'new-customer-uuid',
        company_id: 'test-company-id',
        name: 'New Test Company',
        website: null,
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      mockCreateCustomer.mockResolvedValue(mockCustomer);

      render(<CustomerForm mode="create" initialData={validFormData} />);

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Wait for form submission
      await waitFor(() => {
        expect(mockCheckCustomerNameExists).toHaveBeenCalledWith(
          'test-company-id',
          'New Test Company',
          undefined
        );
      });

      await waitFor(() => {
        expect(mockCreateCustomer).toHaveBeenCalledWith(
          'test-company-id',
          validFormData
        );
      });

      // Should redirect to customer detail page
      await waitFor(() => {
        expect(routerMocks.push).toHaveBeenCalledWith(
          '/dashboard/test-company-id/customers/new-customer-uuid'
        );
      });
    });

    it('shows error for duplicate customer name', async () => {
      // Customer name already exists
      mockCheckCustomerNameExists.mockResolvedValue(true);

      render(<CustomerForm mode="create" initialData={validFormData} />);

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Should show duplicate error
      await waitFor(() => {
        expect(screen.getByText(/a customer with this name already exists/i)).toBeInTheDocument();
      });

      // Should not have called createCustomer
      expect(mockCreateCustomer).not.toHaveBeenCalled();
    });
  });

  describe('Edit mode', () => {
    const existingCustomerData: CustomerFormData = {
      name: 'Existing Company',
      website: 'https://existing.com',
      contact_name: 'John Doe',
      contact_phone: '555-5678',
      contact_email: 'john@existing.com',
      addresses: [
        {
          id: 'addr-1',
          address_line1: '123 Main St',
          address_line2: 'Suite 100',
          city: 'Springfield',
          state: 'IL',
          postal_code: '62701',
          country: 'USA',
          is_billing: true,
          is_shipping: true,
        },
      ],
    };

    it('pre-fills form with existing customer data', () => {
      render(
        <CustomerForm
          mode="edit"
          initialData={existingCustomerData}
          customerId="existing-customer-uuid"
        />
      );

      // Check that top-level fields are pre-filled
      expect(screen.getByLabelText(/company name/i)).toHaveValue('Existing Company');
      expect(screen.getByLabelText(/contact name/i)).toHaveValue('John Doe');
      // Address fields live inside the Addresses card
      expect(screen.getByLabelText(/city/i)).toHaveValue('Springfield');

      // Delete button should be visible in edit mode
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });
});
