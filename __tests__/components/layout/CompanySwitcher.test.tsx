/**
 * The sidebar company switcher, and the one thing it used to get wrong.
 *
 * It pushed `/dashboard/{id}` for every company. Role is per-company — the same person can be an
 * admin at one shop and an operator at another — so switching into a company where you're an
 * operator landed you on a dashboard AuthGuard immediately bounced you out of. Nobody hit it while
 * multi-company membership was rare; invite acceptance no longer dead-ending for existing users is
 * what changes that.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import CompanySwitcher from '@/components/layout/CompanySwitcher';

let companiesStub: Array<{
  company_id: string;
  role: string;
  companies: { id: string; name: string };
}> = [];

vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({ companies: companiesStub, loading: false, error: null }),
}));

vi.mock('@/components/providers/DemoModeProvider', () => ({
  useDemoMode: () => ({ isDemoMode: false, realCompanyName: null }),
}));

vi.mock('@/components/branding', () => ({
  JiggedLogo: () => <div data-testid="logo" />,
}));

// `useParams` in test-utils hands back this id, so it is the "current" company.
const CURRENT = 'test-company-id';

function stage(list: Array<{ id: string; name: string; role: string }>) {
  companiesStub = list.map((c) => ({
    company_id: c.id,
    role: c.role,
    companies: { id: c.id, name: c.name },
  }));
}

beforeEach(() => {
  resetRouterMocks();
});

describe('CompanySwitcher', () => {
  it('sends you to the dashboard when you are an admin there', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'admin' },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));
    await user.click(await screen.findByRole('button', { name: /contour tool & machine/i }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co2'));
  });

  it('sends you to the shop floor when you are an operator there', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'operator' },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));
    await user.click(await screen.findByRole('button', { name: /contour tool & machine/i }));

    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/operator/co2'));
  });

  it('does nothing when you pick the company you are already in', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'admin' },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    // Unambiguous: MUI aria-hides the app root behind the open Drawer, so the trigger drops out of
    // the accessibility tree and the only match left is the row inside the drawer.
    await user.click(await screen.findByRole('button', { name: /vanguard precision works/i }));

    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('is inert with only one company', () => {
    stage([{ id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' }]);
    render(<CompanySwitcher />);

    expect(screen.getByRole('button', { name: /vanguard precision works/i })).toBeDisabled();
  });
});
