import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import PartIdentitySection from '@/components/parts/workspace/PartIdentitySection';
import type { Part } from '@/types/part';

// PartForm's validation moved into PartIdentitySection (the unified create
// gate + inline editor). These tests retarget the old PartForm coverage.
const mockCreatePart = vi.fn();
const mockUpdatePart = vi.fn();
const mockCheckPartNameExists = vi.fn();

vi.mock('@/utils/partsAccess', () => ({
  createPart: (...args: unknown[]) => mockCreatePart(...args),
  updatePart: (...args: unknown[]) => mockUpdatePart(...args),
  checkPartNameExists: (...args: unknown[]) => mockCheckPartNameExists(...args),
}));

// UnitOfMeasurementSelect → utils/unitsAccess; VendorAutocomplete →
// utils/vendorsAccess. Mock both so the real Supabase client isn't loaded.
vi.mock('@/utils/unitsAccess', () => ({
  getCompanyCustomUnits: vi.fn().mockResolvedValue([]),
  addCompanyCustomUnit: vi
    .fn()
    .mockResolvedValue({ id: 'cu-1', company_id: 'test-company-id', unit_name: 'mock-unit' }),
}));
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendors: vi.fn().mockResolvedValue([]),
}));

const mockPart = (over: Partial<Part> = {}): Part => ({
  id: 'p1',
  company_id: 'test-company-id',
  part_name: 'EXIST-001',
  description: 'Existing Part',
  source: 'made',
  is_stocked: false,
  primary_unit: 'each',
  quantity: 0,
  reorder_point: null,
  preferred_vendor_id: null,
  legacy_id: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...over,
});

describe('PartIdentitySection', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPartNameExists.mockResolvedValue(false);
  });

  describe('create mode', () => {
    it('requires a part name (submitting empty shows an error, no create)', async () => {
      render(<PartIdentitySection mode="create" companyId="test-company-id" onCreated={vi.fn()} />);

      // The Create button is disabled while empty; submit the form directly to
      // exercise validation (mirrors the old PartForm test).
      const form = document.querySelector('form');
      fireEvent.submit(form!);

      expect(await screen.findByText(/part name is required/i)).toBeInTheDocument();
      expect(mockCreatePart).not.toHaveBeenCalled();
    });

    it('creates the part and calls onCreated on success', async () => {
      const created = mockPart({ id: 'new-part-uuid', part_name: 'NEW-PART-001' });
      mockCreatePart.mockResolvedValue(created);
      const onCreated = vi.fn();

      render(
        <PartIdentitySection
          mode="create"
          companyId="test-company-id"
          initialDefaults={{ part_name: 'NEW-PART-001', primary_unit: 'each' }}
          onCreated={onCreated}
        />,
      );

      await user.click(screen.getByRole('button', { name: /create part/i }));

      await waitFor(() => {
        expect(mockCheckPartNameExists).toHaveBeenCalledWith(
          'test-company-id',
          'NEW-PART-001',
          undefined,
        );
      });
      await waitFor(() => {
        expect(mockCreatePart).toHaveBeenCalledWith(
          'test-company-id',
          expect.objectContaining({ part_name: 'NEW-PART-001' }),
        );
      });
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    });

    it('blocks a duplicate part name', async () => {
      mockCheckPartNameExists.mockResolvedValue(true);
      const onCreated = vi.fn();

      render(
        <PartIdentitySection
          mode="create"
          companyId="test-company-id"
          initialDefaults={{ part_name: 'DUPE-001', primary_unit: 'each' }}
          onCreated={onCreated}
        />,
      );

      await user.click(screen.getByRole('button', { name: /create part/i }));

      expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
      expect(mockCreatePart).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
    });
  });

  describe('existing mode', () => {
    it('pre-fills from the part and has no Create button', () => {
      render(<PartIdentitySection mode="existing" companyId="test-company-id" part={mockPart()} />);

      expect(screen.getByLabelText(/part name/i)).toHaveValue('EXIST-001');
      expect(screen.getByLabelText(/description/i)).toHaveValue('Existing Part');
      expect(screen.queryByRole('button', { name: /create part/i })).not.toBeInTheDocument();
    });

    it('auto-saves an edited field on blur via updatePart', async () => {
      mockUpdatePart.mockResolvedValue(mockPart({ part_name: 'EXIST-001-RENAMED' }));
      const onSaved = vi.fn();

      render(
        <PartIdentitySection
          mode="existing"
          companyId="test-company-id"
          part={mockPart()}
          onSaved={onSaved}
        />,
      );

      const nameInput = screen.getByLabelText(/part name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'EXIST-001-RENAMED');
      fireEvent.blur(nameInput);

      await waitFor(() => {
        expect(mockUpdatePart).toHaveBeenCalledWith(
          'p1',
          expect.objectContaining({ part_name: 'EXIST-001-RENAMED' }),
        );
      });
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });
  });
});
