'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import GridViewIcon from '@mui/icons-material/GridView';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import LocationsManager from '@/components/inventory/locations/LocationsManager';
import StorageInventoryTable from '@/components/inventory/StorageInventoryTable';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { useUserRole } from '@/hooks/useUserRole';

export default function InventoryLocationsPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const { setTitle } = usePageTitle();

  const unitId = searchParams.get('unit');
  const viewParam = searchParams.get('view');

  /*
   * Inventory is the default view, and Places is the one you ask for.
   *
   * That is the way round the shop uses them: what is on the shelves is a daily question, and
   * reshaping the storage layout is not.
   *
   * The `?unit=` exception keeps every board deep link working. Those links predate this tab and
   * name a storage unit to open — landing them on a table that ignores the parameter would break
   * them silently, which is worse than a redirect.
   */
  const view = viewParam ?? (unitId ? 'places' : 'inventory');

  const { features, loading: featuresLoading } = useCompanyFeatures();
  const { isAdmin } = useUserRole();

  /*
   * MONEY IS DOUBLY GATED, and withheld while the answer is still loading.
   *
   * The tenant flag AND the viewer being an admin, exactly as the dashboard scorecards do it. The
   * loading term is not defensive padding: a dollar total that renders and then disappears on a
   * screen someone else can see is worse than one that never appeared.
   *
   * Read ONCE here and passed down as a boolean. `useCompanyFeatures` has no shared cache, so a
   * second consumer inside the table would be a second `getCompany` on every page load.
   *
   * This is a display choice, not a security boundary — `part_pricing_tiers` is readable by any
   * member through PostgREST, and RLS is company-scoped, not column-scoped. Do not describe it to
   * a customer as "costs are admin-only".
   */
  const costEnabled = !featuresLoading && features.storage_inventory_cost && isAdmin;

  useEffect(() => {
    // Matches the sidebar item. Said "Inventory Locations" while the nav said "Storage",
    // and "locations" carries the industry's site/warehouse meaning we don't have.
    setTitle('Storage');
    return () => setTitle(null);
  }, [setTitle]);

  const switchTo = (next: 'inventory' | 'places') => {
    posthog.capture('storage view switched', { view: next });
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'places') params.set('view', 'places');
    else {
      params.set('view', 'inventory');
      // The board's selection is meaningless on the table, and leaving it would send you back to
      // Places on the next reload through the `?unit=` rule above.
      params.delete('unit');
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <Box>
      {/*
        The switcher lives HERE, not inside LocationsManager.
        Two reasons, both load-bearing. Its page bar deliberately holds only what belongs to
        neither column (see the four-arrangements note in that file), and a view switcher is
        page-scope rather than list- or shop-scope. And `PLACE_DRAWER_WIDTH` padding sits on that
        component's ROOT Box, so a sibling tab strip leaves the persistent drawer's reflow
        arithmetic untouched.

        It also means LocationsManager unmounts on the other tab, which kills a whole class of bug
        for free: none of its three drawers can be left open behind a view that does not have them.

        Rendered unconditionally, including for a shop with no storage at all, so the page does not
        change shape between shops.
      */}
      <Tabs
        value={view}
        onChange={(_, next: 'inventory' | 'places') => switchTo(next)}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab label="Inventory" value="inventory" icon={<Inventory2Icon />} iconPosition="start" />
        <Tab label="Places" value="places" icon={<GridViewIcon />} iconPosition="start" />
      </Tabs>

      {view === 'inventory' ? (
        <StorageInventoryTable
          companyId={companyId}
          costEnabled={costEnabled}
          // Walking from a part to one of its places crosses tabs: the board is where a place
          // opens, so this leaves Inventory rather than trying to show a bin grid inside a table.
          onOpenPlace={(locationId) => {
            const next = new URLSearchParams(searchParams.toString());
            next.set('view', 'places');
            next.set('unit', locationId);
            router.replace(`?${next.toString()}`, { scroll: false });
          }}
        />
      ) : (
        /* The "Back to Inventory" button is gone. Storage is a top-level sidebar item now, so
           there is nothing to go back *to* — and the page it pointed at no longer exists, so it
           would have bounced through a redirect to land on Parts. A back link out of a top-level
           destination is chrome pretending to be navigation. */
        <LocationsManager companyId={companyId} unitId={unitId ?? undefined} />
      )}
    </Box>
  );
}
