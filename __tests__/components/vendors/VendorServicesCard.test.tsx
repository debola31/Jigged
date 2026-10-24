import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import VendorServicesCard from '@/components/vendors/VendorServicesCard';
import type { VendorService } from '@/types/vendorService';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/utils/vendorServicesAccess', () => ({
  createVendorService: vi.fn(),
  updateVendorService: vi.fn(),
  deleteVendorService: vi.fn(),
  restoreVendorService: vi.fn(),
  checkVendorServiceNameExists: vi.fn(),
}));

const service = (id: string, name: string): VendorService =>
  ({
    id,
    company_id: 'co1',
    vendor_id: 'vend1',
    name,
    description: null,
    unit_price: null,
    created_at: '',
    updated_at: '',
  }) as VendorService;

const renderCard = (services: VendorService[]) =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <VendorServicesCard
        companyId="co1"
        vendorId="vend1"
        vendorName="C&B Cutter Grinding"
        services={services}
        onChanged={vi.fn()}
      />
    </ThemeProvider>,
  );

describe('VendorServicesCard', () => {
  // The first service on a vendor used to render the add row twice: once in
  // the list branch and once more below it for the empty case.
  it('renders exactly one add row for a vendor with no services', () => {
    renderCard([]);
    fireEvent.click(screen.getByRole('button', { name: /add service/i }));
    expect(screen.getAllByPlaceholderText('Anodize')).toHaveLength(1);
  });

  it('renders exactly one add row for a vendor that already has services', () => {
    renderCard([service('s1', 'Anodize')]);
    fireEvent.click(screen.getByRole('button', { name: /add service/i }));
    expect(screen.getAllByPlaceholderText('Anodize')).toHaveLength(1);
  });
});
