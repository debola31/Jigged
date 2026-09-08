/**
 * The sidebar company switcher: the one thing it used to get wrong, and the rule that lets a shop's
 * logo stand in for its name.
 *
 * It pushed `/dashboard/{id}` for every company. Role is per-company — the same person can be an
 * admin at one shop and an operator at another — so switching into a company where you're an
 * operator landed you on a dashboard AuthGuard immediately bounced you out of. Nobody hit it while
 * multi-company membership was rare; invite acceptance no longer dead-ending for existing users is
 * what changes that.
 *
 * The logo cases mock the STORAGE helper rather than `useCompanyLogos`, so the rule under test —
 * a logo replaces the name only when `settings.logo_includes_name` says it carries one — runs for
 * real. Note the routing tests below still find rows by the company name: with the name suppressed
 * that name comes from the logo's `alt`, which is the point. A row must never lose its label.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  routerMocks,
  resetRouterMocks,
} from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import CompanySwitcher from '@/components/layout/CompanySwitcher';

let companiesStub: Array<{
  company_id: string;
  role: string;
  companies: {
    id: string;
    name: string;
    logo_url?: string | null;
    settings?: Record<string, unknown> | null;
  };
}> = [];

vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({ companies: companiesStub, loading: false, error: null }),
}));

// One signed URL per stored path, so a test can assert which artwork a row drew.
const getSignedUrls = vi.fn(async (paths: string[]) =>
  new Map(paths.map((path) => [path, `https://signed.test/${path}`])),
);

vi.mock('@/utils/storageHelpers', () => ({
  getSignedUrls: (...args: [string[], number?, string?]) => getSignedUrls(...args),
  LOGOS_BUCKET: 'logos',
}));

vi.mock('@/components/providers/DemoModeProvider', () => ({
  useDemoMode: () => ({ isDemoMode: false, realCompanyName: null }),
}));

vi.mock('@/components/branding', () => ({
  JiggedLogo: () => <div data-testid="logo" />,
}));

// `useParams` in test-utils hands back this id, so it is the "current" company.
const CURRENT = 'test-company-id';

function stage(
  list: Array<{
    id: string;
    name: string;
    role: string;
    logoPath?: string;
    logoIncludesName?: boolean;
  }>,
) {
  companiesStub = list.map((c) => ({
    company_id: c.id,
    role: c.role,
    companies: {
      id: c.id,
      name: c.name,
      logo_url: c.logoPath ?? null,
      settings: c.logoIncludesName ? { logo_includes_name: true } : null,
    },
  }));
}

beforeEach(() => {
  resetRouterMocks();
  getSignedUrls.mockClear();
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

describe('CompanySwitcher logos', () => {
  it('shows the wordmark INSTEAD of the name when the logo carries it', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      {
        id: 'co2',
        name: 'Contour Tool & Machine',
        role: 'admin',
        logoPath: 'co2/company/logo_ab12_contour.png',
        logoIncludesName: true,
      },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    const logo = await screen.findByRole('img', { name: 'Contour Tool & Machine' });
    expect(logo).toHaveAttribute('src', 'https://signed.test/co2/company/logo_ab12_contour.png');

    // The name is the logo's alt text and nothing else — printing it again is the whole thing this
    // rule exists to avoid. `getByText` doesn't match alt attributes, so this is the real check.
    expect(screen.queryByText('Contour Tool & Machine')).toBeNull();
  });

  it('keeps the name when the logo does not contain it', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      {
        id: 'co2',
        name: 'Contour Tool & Machine',
        role: 'admin',
        logoPath: 'co2/company/logo_ab12_emblem.png',
        logoIncludesName: false,
      },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    expect(await screen.findByText('Contour Tool & Machine')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Contour Tool & Machine' })).toBeNull();
    // A logo that can't name the shop is never fetched — there is nothing it could be drawn into.
    expect(getSignedUrls).not.toHaveBeenCalled();
  });

  it('keeps the name when there is no logo at all', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      { id: 'co2', name: 'Contour Tool & Machine', role: 'admin' },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    expect(await screen.findByText('Contour Tool & Machine')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Contour Tool & Machine' })).toBeNull();
  });

  it('falls back to the name when the logo fails to load', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      {
        id: 'co2',
        name: 'Contour Tool & Machine',
        role: 'admin',
        logoPath: 'co2/company/logo_ab12_contour.png',
        logoIncludesName: true,
      },
    ]);
    render(<CompanySwitcher />);

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    const logo = await screen.findByRole('img', { name: 'Contour Tool & Machine' });
    // Signed URLs expire and the bucket is private, so this is normal use, not an exotic failure.
    fireEvent.error(logo);

    expect(await screen.findByText('Contour Tool & Machine')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Contour Tool & Machine' })).toBeNull();
  });

  it('mints every visible logo in ONE request, against the logos bucket', async () => {
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      {
        id: 'co2',
        name: 'Contour Tool & Machine',
        role: 'admin',
        logoPath: 'co2/company/logo_ab12_contour.png',
        logoIncludesName: true,
      },
      {
        id: 'co3',
        name: 'L & L Machine & Tool',
        role: 'admin',
        logoPath: 'co3/company/logo_cd34_ll.png',
        logoIncludesName: true,
      },
    ]);
    render(<CompanySwitcher />);

    // Both paths in a single call — a round trip per workspace is the thing being avoided.
    await waitFor(() => expect(getSignedUrls).toHaveBeenCalledTimes(1));
    expect(getSignedUrls).toHaveBeenCalledWith(
      ['co2/company/logo_ab12_contour.png', 'co3/company/logo_cd34_ll.png'],
      expect.any(Number),
      'logos',
    );
  });

  it('re-mints when the drawer opens, so an all-day tab outlives the URL expiry', async () => {
    const user = userEvent.setup();
    stage([
      { id: CURRENT, name: 'Vanguard Precision Works', role: 'admin' },
      {
        id: 'co2',
        name: 'Contour Tool & Machine',
        role: 'admin',
        logoPath: 'co2/company/logo_ab12_contour.png',
        logoIncludesName: true,
      },
    ]);
    render(<CompanySwitcher />);

    await waitFor(() => expect(getSignedUrls).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /vanguard precision works/i }));

    await waitFor(() => expect(getSignedUrls).toHaveBeenCalledTimes(2));
  });
});
