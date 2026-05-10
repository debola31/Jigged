import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import UnitOfMeasurementSelect from '@/components/parts/UnitOfMeasurementSelect';
import type { CompanyCustomUnit } from '@/types/units';

// Mock the access layer. Both calls return resolved promises by default;
// individual tests override to assert behavior on specific paths.
const mockGetCompanyCustomUnits = vi.fn();
const mockAddCompanyCustomUnit = vi.fn();

vi.mock('@/utils/unitsAccess', () => ({
  getCompanyCustomUnits: (...args: unknown[]) =>
    mockGetCompanyCustomUnits(...args),
  addCompanyCustomUnit: (...args: unknown[]) =>
    mockAddCompanyCustomUnit(...args),
}));

describe('UnitOfMeasurementSelect', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCompanyCustomUnits.mockResolvedValue([]);
  });

  it('fetches company custom units on mount', async () => {
    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalledWith('test-company-id');
    });
  });

  it('renders standard options grouped by category when opened', async () => {
    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    // Wait for initial load to complete
    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalled();
    });

    // Open the dropdown by clicking the input
    const input = screen.getByRole('combobox', {
      name: /unit of measurement/i,
    });
    await user.click(input);

    // Standard units should be present (verify a few canonical ones)
    await waitFor(() => {
      expect(screen.getByText('Pounds (lb)')).toBeInTheDocument();
    });
    expect(screen.getByText('Each (ea)')).toBeInTheDocument();
    expect(screen.getByText('Inches (in)')).toBeInTheDocument();

    // The "+ Add custom unit..." sentinel is always present
    expect(screen.getByText('Add custom unit...')).toBeInTheDocument();
  });

  it('includes company custom units under the Custom group', async () => {
    const customUnits: CompanyCustomUnit[] = [
      {
        id: 'cu-1',
        company_id: 'test-company-id',
        unit_name: 'billet',
      },
    ];
    mockGetCompanyCustomUnits.mockResolvedValue(customUnits);

    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalled();
    });

    const input = screen.getByRole('combobox', {
      name: /unit of measurement/i,
    });
    await user.click(input);

    await waitFor(() => {
      expect(screen.getByText('billet')).toBeInTheDocument();
    });
  });

  it('opens add-custom-unit modal when sentinel row is clicked', async () => {
    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalled();
    });

    const input = screen.getByRole('combobox', {
      name: /unit of measurement/i,
    });
    await user.click(input);

    const addRow = await screen.findByText('Add custom unit...');
    await user.click(addRow);

    // Modal opens with the unit name field
    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: /add custom unit/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/unit name/i)).toBeInTheDocument();
  });

  it('calls addCompanyCustomUnit and selects the new unit on save', async () => {
    const onChange = vi.fn();
    const newUnit: CompanyCustomUnit = {
      id: 'cu-new',
      company_id: 'test-company-id',
      unit_name: 'spool',
    };
    mockAddCompanyCustomUnit.mockResolvedValue(newUnit);
    // The component refetches after add; second call returns the new unit.
    mockGetCompanyCustomUnits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([newUnit]);

    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={onChange}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalledTimes(1);
    });

    // Open dropdown -> click "+ Add custom unit..."
    const input = screen.getByRole('combobox', {
      name: /unit of measurement/i,
    });
    await user.click(input);
    const addRow = await screen.findByText('Add custom unit...');
    await user.click(addRow);

    // Type name + save
    const nameInput = screen.getByLabelText(/unit name/i);
    await user.type(nameInput, 'spool');
    const saveButton = screen.getByRole('button', { name: /^save$/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockAddCompanyCustomUnit).toHaveBeenCalledWith(
        'test-company-id',
        'spool',
      );
    });

    // The new unit should be auto-selected via onChange
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('spool');
    });

    // The dropdown options should refresh to include the new custom unit
    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects empty unit name in the add modal', async () => {
    render(
      <UnitOfMeasurementSelect
        value={null}
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalled();
    });

    const input = screen.getByRole('combobox', {
      name: /unit of measurement/i,
    });
    await user.click(input);
    const addRow = await screen.findByText('Add custom unit...');
    await user.click(addRow);

    // Save button is disabled when the field is empty
    const saveButton = screen.getByRole('button', { name: /^save$/i });
    expect(saveButton).toBeDisabled();
    expect(mockAddCompanyCustomUnit).not.toHaveBeenCalled();
  });

  it('shows an unknown-value chip when value does not match standard or custom unit', async () => {
    render(
      <UnitOfMeasurementSelect
        value="legacy-weird-unit"
        onChange={() => undefined}
        companyId="test-company-id"
      />,
    );

    await waitFor(() => {
      expect(mockGetCompanyCustomUnits).toHaveBeenCalled();
    });

    // The unknown value should appear in the input (as the selected value).
    // The text appears via the displayed selection.
    expect(
      screen.getByDisplayValue('legacy-weird-unit'),
    ).toBeInTheDocument();
  });
});
