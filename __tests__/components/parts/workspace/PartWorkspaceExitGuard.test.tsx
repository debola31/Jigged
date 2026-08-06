import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import PartWorkspace from '@/components/parts/workspace/PartWorkspace';
import type { Part } from '@/types/part';

// NOTE: deliberately NOT using `__tests__/test-utils`. Its shared render helper
// mocks next/navigation with a fixed params stub that has no `partId`, so
// PartWorkspace would bail at its `if (!partId) return null` guard and render
// nothing. This test needs its own route params, so it wraps in the theme
// itself — the same thing the sibling WorkspaceTab test does.
const render = (ui: React.ReactElement) =>
  rtlRender(<ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>);

const mockReplace = vi.fn();
const mockGetPartWithRelations = vi.fn();
const mockGetPartUnitConversions = vi.fn();
const mockGetPartNamesByIds = vi.fn();
const mockGetPartCostExplain = vi.fn();

// PartWorkspace pulls in the other tab panels, several of which reach the
// Supabase client at module scope. This test never exercises them, so a stub
// keeps the import graph from demanding real credentials.
vi.mock('@/lib/supabase', () => {
  const stub = () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ data: [], error: null }) }),
  });
  return { getSupabase: stub, supabase: stub() };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ partId: 'p1', companyId: 'c1' }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/dashboard/c1/parts/p1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/utils/partsAccess', () => ({
  getPartWithRelations: (...a: unknown[]) => mockGetPartWithRelations(...a),
  getPartUnitConversions: (...a: unknown[]) => mockGetPartUnitConversions(...a),
  getPartNamesByIds: (...a: unknown[]) => mockGetPartNamesByIds(...a),
  getPartCostExplain: (...a: unknown[]) => mockGetPartCostExplain(...a),
  deletePart: vi.fn(),
}));
vi.mock('@/components/layout/PageTitleProvider', () => ({
  usePageTitle: () => ({ setTitle: vi.fn() }),
}));
vi.mock('@/components/parts/PartTransactionModal', () => ({ default: () => null }));

// Stand in for the real workspace panels: exposes a button that reports dirty
// state up exactly the way PartPricing does, so this test exercises the guard
// rather than the pricing card (which has its own suite).
vi.mock('@/components/parts/workspace/tabs/WorkspaceTab', () => ({
  default: ({ onDirtyChange }: { onDirtyChange?: (k: string, d: boolean) => void }) => (
    <button type="button" onClick={() => onDirtyChange?.('pricing', true)}>
      stage-an-edit
    </button>
  ),
}));

const part = {
  id: 'p1',
  company_id: 'c1',
  part_name: 'BRACKET-001',
  source: 'made',
  primary_unit: 'each',
  is_stocked: false,
  created_at: '2026-01-01T00:00:00Z',
} as unknown as Part;

describe('PartWorkspace — unsaved-changes exit guard', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPartWithRelations.mockResolvedValue(part);
    mockGetPartUnitConversions.mockResolvedValue([]);
    mockGetPartNamesByIds.mockResolvedValue({});
    mockGetPartCostExplain.mockResolvedValue({
      is_priceable: true,
      missing_markups: [],
      missing_op_rates: [],
      missing_leaves: [],
    });
  });

  const switchToUsageTab = async () => {
    await user.click(await screen.findByRole('tab', { name: /Usage/i }));
  };

  it('switches tabs freely when nothing is staged', async () => {
    render(<PartWorkspace mode="existing" />);
    await screen.findByRole('button', { name: /stage-an-edit/i });

    await switchToUsageTab();

    expect(mockReplace).toHaveBeenCalled();
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
  });

  it('blocks the tab switch and asks first when an edit is staged', async () => {
    // Tabs are conditionally rendered, so leaving unmounts the panel holding
    // the staged edit. Without this guard the edit disappears silently.
    render(<PartWorkspace mode="existing" />);
    await user.click(await screen.findByRole('button', { name: /stage-an-edit/i }));

    await switchToUsageTab();

    expect(await screen.findByText(/You have unsaved changes/i)).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('stays put on "Keep editing"', async () => {
    render(<PartWorkspace mode="existing" />);
    await user.click(await screen.findByRole('button', { name: /stage-an-edit/i }));
    await switchToUsageTab();
    await screen.findByText(/You have unsaved changes/i);

    await user.click(screen.getByRole('button', { name: /Keep editing/i }));

    await waitFor(() => expect(screen.queryByText(/You have unsaved changes/i)).toBeNull());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('proceeds to the requested tab on "Discard changes"', async () => {
    render(<PartWorkspace mode="existing" />);
    await user.click(await screen.findByRole('button', { name: /stage-an-edit/i }));
    await switchToUsageTab();
    await screen.findByText(/You have unsaved changes/i);

    await user.click(screen.getByRole('button', { name: /Discard changes/i }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(String(mockReplace.mock.calls[0][0])).toContain('tab=usage');
  });
});
