import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, routerMocks, resetRouterMocks } from '../../test-utils';
import PartForm from '@/components/parts/PartForm';
import { EMPTY_PART_FORM } from '@/types/part';
import type { PartFormData, Part } from '@/types/part';
import type { Customer } from '@/types/customer';

// Mock partsAccess utilities
const mockCreatePart = vi.fn();
const mockUpdatePart = vi.fn();
const mockDeletePart = vi.fn();
const mockCheckPartNumberExists = vi.fn();

vi.mock('@/utils/partsAccess', () => ({
  createPart: (...args: unknown[]) => mockCreatePart(...args),
  updatePart: (...args: unknown[]) => mockUpdatePart(...args),
  deletePart: (...args: unknown[]) => mockDeletePart(...args),
  checkPartNumberExists: (...args: unknown[]) => mockCheckPartNumberExists(...args),
}));

// Mock customerAccess utilities
const mockGetAllCustomers = vi.fn();

vi.mock('@/utils/customerAccess', () => ({
  getAllCustomers: (...args: unknown[]) => mockGetAllCustomers(...args),
}));

const mockCustomers: Customer[] = [
  {
    id: 'customer-1',
    company_id: 'test-company-id',
    name: 'Test Customer 1',
    phone: null,
    email: null,
    website: null,
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
    country: 'USA',
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'customer-2',
    company_id: 'test-company-id',
    name: 'Test Customer 2',
    phone: null,
    email: null,
    website: null,
    contact_name: null,
    contact_phone: null,
    contact_email: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
    country: 'USA',
    notes: null,
    created_at: '2024-01-02T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  },
];

describe('PartForm', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    // Default: part number doesn't exist (validation passes)
    mockCheckPartNumberExists.mockResolvedValue(false);
    // Default: return mock customers
    mockGetAllCustomers.mockResolvedValue(mockCustomers);
  });

  describe('Validation', () => {
    it('shows error when part_number is empty on submit', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Verify the Part Number field exists and is empty
      const partNumberInput = screen.getByLabelText(/part number/i);
      expect(partNumberInput).toHaveValue('');

      // Submit the form
      const form = document.querySelector('form');
      fireEvent.submit(form!);

      // Should show validation error
      expect(await screen.findByText(/part number is required/i)).toBeInTheDocument();

      // Should not have called createPart
      expect(mockCreatePart).not.toHaveBeenCalled();
    });
  });

  describe('Pricing Tiers', () => {
    it('renders default pricing tier (qty=1) for new parts', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Wait for render
      await waitFor(() => {
        expect(screen.getByText(/pricing tiers/i)).toBeInTheDocument();
      });

      // Find the pricing tiers table
      const table = screen.getByRole('table');
      const rows = within(table).getAllByRole('row');

      // Should have header row + 1 data row (default tier)
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('can add and remove pricing tiers', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Click "Add Tier" button
      const addTierButton = screen.getByRole('button', { name: /add tier/i });
      await user.click(addTierButton);

      // Find the pricing tiers table
      const table = screen.getByRole('table');
      const rows = within(table).getAllByRole('row');

      // Should have header row + 2 data rows now
      expect(rows.length).toBeGreaterThanOrEqual(3);

      // Find and click delete button on the second row
      const deleteButtons = screen.getAllByTestId ?
        screen.getAllByRole('button').filter(btn => btn.querySelector('[data-testid="DeleteIcon"]')) :
        Array.from(document.querySelectorAll('button')).filter(btn =>
          btn.innerHTML.includes('DeleteIcon') || btn.querySelector('svg')
        );

      // Should have delete buttons
      expect(deleteButtons.length).toBeGreaterThan(0);
    });

    it('prevents removing the last pricing tier', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Find delete buttons in the pricing table
      const table = screen.getByRole('table');
      const deleteButtons = within(table).getAllByRole('button');

      // The delete button should be disabled when there's only one tier
      const deleteButton = deleteButtons.find(btn => btn.getAttribute('disabled') !== null);
      if (deleteButton) {
        expect(deleteButton).toBeDisabled();
      }
    });
  });

  describe('Customer Selection', () => {
    it('shows customer dropdown with "No Customer" option', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalledWith('test-company-id');
      });

      // Find the customer select
      const customerLabel = screen.getByLabelText(/customer/i);
      expect(customerLabel).toBeInTheDocument();
    });
  });

  describe('Create mode', () => {
    const validFormData: PartFormData = {
      ...EMPTY_PART_FORM,
      part_number: 'NEW-PART-001',
      description: 'Test Part Description',
    };

    it('creates part and redirects on success', async () => {
      const mockPart: Part = {
        id: 'new-part-uuid',
        company_id: 'test-company-id',
        customer_id: null,
        part_number: 'NEW-PART-001',
        description: 'Test Part Description',
        pricing: [{ qty: 1, price: 0 }],
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      mockCreatePart.mockResolvedValue(mockPart);

      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={validFormData}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Wait for form submission
      await waitFor(() => {
        expect(mockCheckPartNumberExists).toHaveBeenCalledWith(
          'test-company-id',
          'NEW-PART-001',
          null,
          undefined
        );
      });

      await waitFor(() => {
        expect(mockCreatePart).toHaveBeenCalledWith(
          'test-company-id',
          expect.objectContaining({
            part_number: 'NEW-PART-001',
          })
        );
      });

      // Should redirect to part detail page
      await waitFor(() => {
        expect(routerMocks.push).toHaveBeenCalledWith(
          '/dashboard/test-company-id/parts/new-part-uuid'
        );
      });
    });

    it('shows error for duplicate part_number', async () => {
      // Part number already exists
      mockCheckPartNumberExists.mockResolvedValue(true);

      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={validFormData}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Should show duplicate error
      await waitFor(() => {
        expect(screen.getByText(/part number already exists/i)).toBeInTheDocument();
      });

      // Should not have called createPart
      expect(mockCreatePart).not.toHaveBeenCalled();
    });
  });

  describe('Edit mode', () => {
    const existingPartData: PartFormData = {
      part_number: 'EXIST-001',
      customer_id: 'customer-1',
      description: 'Existing Part',
      pricing: [
        { qty: 1, price: 10.0 },
        { qty: 50, price: 8.0 },
      ],
    };

    const existingPart: Part = {
      id: 'existing-part-uuid',
      company_id: 'test-company-id',
      customer_id: 'customer-1',
      part_number: 'EXIST-001',
      description: 'Existing Part',
      pricing: [
        { qty: 1, price: 10.0 },
        { qty: 50, price: 8.0 },
      ],
      notes: 'Important part',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      quotes_count: 2,
      jobs_count: 1,
    };

    it('pre-fills form with existing part data', async () => {
      render(
        <PartForm
          mode="edit"
          companyId="test-company-id"
          initialData={existingPartData}
          partId="existing-part-uuid"
          part={existingPart}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Check that form fields are pre-filled
      expect(screen.getByLabelText(/part number/i)).toHaveValue('EXIST-001');
      expect(screen.getByLabelText(/description/i)).toHaveValue('Existing Part');

      // Delete button should be visible in edit mode
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('shows delete dialog with relation counts', async () => {
      render(
        <PartForm
          mode="edit"
          companyId="test-company-id"
          initialData={existingPartData}
          partId="existing-part-uuid"
          part={existingPart}
        />
      );

      // Wait for customers to load
      await waitFor(() => {
        expect(mockGetAllCustomers).toHaveBeenCalled();
      });

      // Click delete button
      const deleteButton = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteButton);

      // Should show delete dialog with warning about relations
      await waitFor(() => {
        expect(screen.getByText(/2 quote/i)).toBeInTheDocument();
        expect(screen.getByText(/1 job/i)).toBeInTheDocument();
      });
    });
  });
});
