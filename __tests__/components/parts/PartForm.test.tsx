import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, routerMocks, resetRouterMocks } from '../../test-utils';
import PartForm from '@/components/parts/PartForm';
import { EMPTY_PART_FORM } from '@/types/part';
import type { PartFormData, Part } from '@/types/part';

// Mock partsAccess utilities
const mockCreatePart = vi.fn();
const mockUpdatePart = vi.fn();
const mockDeletePart = vi.fn();
const mockCheckPartNameExists = vi.fn();

vi.mock('@/utils/partsAccess', () => ({
  createPart: (...args: unknown[]) => mockCreatePart(...args),
  updatePart: (...args: unknown[]) => mockUpdatePart(...args),
  deletePart: (...args: unknown[]) => mockDeletePart(...args),
  checkPartNameExists: (...args: unknown[]) => mockCheckPartNameExists(...args),
}));

vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendors: vi.fn().mockResolvedValue([]),
}));

// PartForm transitively imports UnitOfMeasurementSelect which calls into
// utils/unitsAccess. Mock here too so the real Supabase client isn't loaded.
vi.mock('@/utils/unitsAccess', () => ({
  getCompanyCustomUnits: vi.fn().mockResolvedValue([]),
  addCompanyCustomUnit: vi.fn().mockResolvedValue({
    id: 'cu-1',
    company_id: 'test-company-id',
    unit_name: 'mock-unit',
  }),
}));

describe('PartForm', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    // Default: part name doesn't exist (validation passes)
    mockCheckPartNameExists.mockResolvedValue(false);
  });

  describe('Validation', () => {
    it('shows error when part_name is empty on submit', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      // Verify the Part Name field exists and is empty
      const partNameInput = screen.getByLabelText(/part name/i);
      expect(partNameInput).toHaveValue('');

      // Submit the form
      const form = document.querySelector('form');
      fireEvent.submit(form!);

      // Should show validation error
      expect(await screen.findByText(/part name is required/i)).toBeInTheDocument();

      // Should not have called createPart
      expect(mockCreatePart).not.toHaveBeenCalled();
    });
  });

  describe('Create mode', () => {
    const validFormData: PartFormData = {
      ...EMPTY_PART_FORM,
      part_name: 'NEW-PART-001',
      description: 'Test Part Description',
      // primary_unit is required for every part (DB CHECK parts_requires_unit).
      primary_unit: 'each',
    };

    it('creates part and redirects on success', async () => {
      const mockPart: Part = {
        id: 'new-part-uuid',
        company_id: 'test-company-id',
        part_name: 'NEW-PART-001',
        description: 'Test Part Description',
        source: 'made',
        is_stocked: false,
        primary_unit: null,
        quantity: 0,
        reorder_point: null,
        preferred_vendor_id: null,
        legacy_id: null,
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

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Wait for form submission
      await waitFor(() => {
        expect(mockCheckPartNameExists).toHaveBeenCalledWith(
          'test-company-id',
          'NEW-PART-001',
          undefined
        );
      });

      await waitFor(() => {
        expect(mockCreatePart).toHaveBeenCalledWith(
          'test-company-id',
          expect.objectContaining({
            part_name: 'NEW-PART-001',
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

    it('shows error for duplicate part_name', async () => {
      // Part name already exists
      mockCheckPartNameExists.mockResolvedValue(true);

      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={validFormData}
        />
      );

      // Click save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      // Should show duplicate error
      await waitFor(() => {
        expect(screen.getByText(/part name already exists/i)).toBeInTheDocument();
      });

      // Should not have called createPart
      expect(mockCreatePart).not.toHaveBeenCalled();
    });
  });

  describe('Edit mode', () => {
    const existingPartData: PartFormData = {
      ...EMPTY_PART_FORM,
      part_name: 'EXIST-001',
      description: 'Existing Part',
    };

    const existingPart: Part = {
      id: 'existing-part-uuid',
      company_id: 'test-company-id',
      part_name: 'EXIST-001',
      description: 'Existing Part',
      source: 'made',
      is_stocked: false,
      primary_unit: null,
      quantity: 0,
      reorder_point: null,
      preferred_vendor_id: null,
      legacy_id: null,
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

      // Check that form fields are pre-filled
      expect(screen.getByLabelText(/part name/i)).toHaveValue('EXIST-001');
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
