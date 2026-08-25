import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: the Team page reopens on the tab you left it on.
 *
 * This is the only layer where the behaviour exists. The selection lives in
 * `localStorage` under `jigged.team.activeTab.<companyId>` and is read in a lazy
 * `useState` initializer, so observing it means actually leaving the page and
 * coming back through the sidebar — which is the whole requirement, and exactly
 * what a component test cannot express. (The initializer is safe there because
 * AuthGuard and AdminGuard both render a spinner before the page's own render
 * ever runs; see docs/modules/invitation-system.md.)
 *
 * Deliberately asserts on `aria-selected` rather than on grid contents: the
 * shared e2e company need not have any operators, in which case the tab shows
 * an empty grid whose rows would make a flaky anchor. The tab's own selected
 * state is the thing under test.
 *
 * The Team page is admin-only (`AdminGuard`), and global-setup provisions the
 * e2e user as an admin, so both the sidebar item and the page content are
 * reachable.
 */
test('the Team page reopens on the tab you left it on', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

  // First visit with no stored preference falls back to Admins.
  await navigateTo(page, 'Team');
  await expect(page.getByRole('tab', { name: 'Admins' })).toHaveAttribute('aria-selected', 'true');

  // Choose a different tab.
  await page.getByRole('tab', { name: 'Operators' }).click();
  await expect(page.getByRole('tab', { name: 'Operators' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Leave the page entirely, through the sidebar — the bare /team path, with no
  // `?tab=` to carry the choice. Only the stored preference can bring it back.
  await navigateTo(page, 'Jobs');
  await expect(page).toHaveURL(/\/jobs/);

  await navigateTo(page, 'Team');
  await expect(page.getByRole('tab', { name: 'Operators' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'Admins' })).toHaveAttribute('aria-selected', 'false');
});

test('every tab shows Last Login, and no member row offers a recorded-time action', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  await navigateTo(page, 'Team');

  for (const name of ['Admins', 'Users', 'Operators']) {
    await page.getByRole('tab', { name }).click();
    await expect(page.getByRole('columnheader', { name: 'Last Login' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Joined' })).toHaveCount(0);
    // The per-person recorded-time door is gone from every tab, not scoped away.
    await expect(page.getByRole('button', { name: /recorded time/i })).toHaveCount(0);
  }
});
