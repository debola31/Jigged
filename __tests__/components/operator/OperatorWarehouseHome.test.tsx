import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorWarehouseHomePage from '@/app/operator/[companyId]/inventory/page';
import { getLocations } from '@/utils/inventoryLocationsAccess';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocations: vi.fn(),
}));

const loc = (over: { id: string; name: string; parent_id?: string | null; code?: string | null }) => ({
  id: over.id,
  company_id: 'co1',
  parent_id: over.parent_id ?? null,
  name: over.name,
  kind: 'cabinet',
  code: over.code ?? null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
});

const renderPage = () =>
  render(<OperatorWarehouseHomePage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

beforeEach(() => vi.clearAllMocks());

describe('OperatorWarehouseHomePage', () => {
  it('lists only top-level locations and drills into the bin view', async () => {
    (getLocations as ReturnType<typeof vi.fn>).mockResolvedValue([
      loc({ id: 'cab1', name: 'Cabinet 1', code: 'C01' }),
      loc({ id: 'bin1', name: 'Bin 1', parent_id: 'cab1' }), // child — must NOT appear at root
    ]);
    renderPage();

    expect(await screen.findByText('Cabinet 1')).toBeInTheDocument();
    expect(screen.queryByText('Bin 1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Cabinet 1'));
    expect(mockPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/cab1');
  });

  it('shows an empty state when no locations exist', async () => {
    (getLocations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No storage locations yet/i)).toBeInTheDocument();
  });
});
