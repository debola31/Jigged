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
const mockCheckPartNumberExists = vi.fn();

vi.mock('@/utils/partsAccess', () => ({
  createPart: (...args: unknown[]) => mockCreatePart(...args),
  updatePart: (...args: unknown[]) => mockUpdatePart(...args),
  deletePart: (...args: unknown[]) => mockDeletePart(...args),
  checkPartNumberExists: (...args: unknown[]) => mockCheckPartNumberExists(...args),
}));

vi.mock('@/utils/partCategoriesAccess', () => ({
  getPartCategoriesForSelect: vi.fn().mockResolvedValue([]),
}));

describe('PartForm', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    // Default: part number doesn't exist (validation passes)
    mockCheckPartNumberExists.mockResolvedValue(false);
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

  describe('Cost Information', () => {
    it('renders cost information card', async () => {
      render(
        <PartForm
          mode="create"
          companyId="test-company-id"
          initialData={EMPTY_PART_FORM}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/cost information/i)).toBeInTheDocument();
      });

      // Manual cost field should exist
      expect(screen.getByLabelText(/manual cost/i)).toBeInTheDocument();
    });

    it('shows cost source chip in edit mode', async () => {
      const partWithRouting: Part = {
        id: 'part-1',
        company_id: 'test-company-id',
        part_number: 'P001',
        description: null,
        category_id: null,
        manual_cost: 50,
        cost_source: 'routing',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        routing: { id: 'r-1' },
      };

      render(
        <PartForm
          mode="edit"
          companyId="test-company-id"
          initialData={{
            part_number: 'P001',
            description: '',
            category_id: '',
            manual_cost: '50',
            cost_source: 'routing',
          }}
          partId="part-1"
          part={partWithRouting}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/from routing/i)).toBeInTheDocument();
      });
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
        part_number: 'NEW-PART-001',
        description: 'Test Part Description',
        category_id: null,
        manual_cost: null,
        cost_source: null,
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
        expect(mockCheckPartNumberExists).toHaveBeenCalledWith(
          'test-company-id',
          'NEW-PART-001',
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
      description: 'Existing Part',
      category_id: '',
      manual_cost: '10.00',
      cost_source: 'manual',
    };

    const existingPart: Part = {
      id: 'existing-part-uuid',
      company_id: 'test-company-id',
      part_number: 'EXIST-001',
      description: 'Existing Part',
      category_id: null,
      manual_cost: 10.0,
      cost_source: 'manual',
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
