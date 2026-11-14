/**
 * /activity — the shop-wide feed, filtered by kind (plan §3.13 "Elsewhere"). Purchasing is one of
 * the kinds: a PO sent to a vendor, a delivery received against one. Archived POs are filtered in
 * the access layer (`fetchPurchasingActivity`); the page only asks for the kind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../test-utils';

vi.mock('@/utils/dashboardAccess', () => ({ getActivityStream: vi.fn(async () => []) }));

import ActivityPage from '@/app/dashboard/[companyId]/activity/page';
import { getActivityStream } from '@/utils/dashboardAccess';

beforeEach(() => vi.clearAllMocks());

describe('ActivityPage', () => {
  it('offers a Purchasing filter that asks for purchasing activity only', async () => {
    render(<ActivityPage />);
    await waitFor(() => expect(getActivityStream).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Purchasing' }));
    await waitFor(() =>
      expect(getActivityStream).toHaveBeenLastCalledWith('test-company-id', { types: ['purchasing'], limit: 30 }),
    );
  });
});
