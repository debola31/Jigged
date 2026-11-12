'use client';

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined';
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined';
import RequestQuoteOutlinedIcon from '@mui/icons-material/RequestQuoteOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';

import { PURCHASING_VIEWS, type PurchasingView } from '@/lib/purchasingRoutes';
import VendorPoList from '@/components/purchasing/VendorPoList';
import VendorPoReceiptsList from '@/components/purchasing/VendorPoReceiptsList';
import { BuyList } from '@/components/purchasing/BuyList';
import { RfqList } from '@/components/purchasing/RfqList';
import PurchasingSettingsDialog from '@/components/purchasing/PurchasingSettingsDialog';

function parseView(value: string | null): PurchasingView {
  return value !== null && (PURCHASING_VIEWS as readonly string[]).includes(value) ? (value as PurchasingView) : 'orders';
}

/**
 * The Purchasing hub — one sidebar row, four views of one section (plan §3.1, §3.13).
 *
 * Tabs, not a toggle: each one swaps the panel for a different list (design-system.md "Tabs vs.
 * segmented toggles"). The view lives in `?view=` and changes with `router.replace`, so a reload,
 * a shared link and Back all land on the tab the person was looking at, and an unknown value falls
 * back to Orders rather than to an empty page.
 *
 * Switching tabs drops the last tab's own filters (the URL becomes just `?view=…`): the Orders
 * list's vendor filter has no meaning on the Receipts tab, and carrying it across would filter a
 * list by a control that is not on screen.
 *
 * The settings button is here, not in Settings, because numbering and terms are any office user's
 * business (plan §2 "Where things live"); the QuickBooks item mapping stays in Settings, for admins.
 */
export default function PurchasingHubPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const view = parseView(searchParams.get('view'));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const switchTo = (next: PurchasingView) => {
    router.replace(`?view=${next}`, { scroll: false });
  };

  return (
    <Box>
      {/* `mt: -2` and the border on the wrapper, matching Storage and Team — the layout leaves room
          above a page's first element that a tab strip does not want. */}
      <Box
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          mb: 2,
          mt: -2,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Tabs
          value={view}
          onChange={(_, next: PurchasingView) => switchTo(next)}
          variant="scrollable"
          allowScrollButtonsMobile
          sx={{ flex: 1, minWidth: 0 }}
        >
          <Tab label="Orders" value="orders" icon={<DescriptionOutlinedIcon />} iconPosition="start" />
          <Tab label="Receipts" value="receipts" icon={<MoveToInboxOutlinedIcon />} iconPosition="start" />
          <Tab label="To buy" value="to-buy" icon={<ShoppingCartOutlinedIcon />} iconPosition="start" />
          <Tab label="RFQs" value="rfqs" icon={<RequestQuoteOutlinedIcon />} iconPosition="start" />
        </Tabs>
        <Button
          variant="outlined"
          startIcon={<SettingsOutlinedIcon />}
          onClick={() => setSettingsOpen(true)}
          sx={{ mb: 1 }}
        >
          Purchasing settings
        </Button>
      </Box>

      {view === 'orders' && <VendorPoList companyId={companyId} />}
      {view === 'receipts' && <VendorPoReceiptsList companyId={companyId} />}
      {view === 'to-buy' && <BuyList companyId={companyId} />}
      {view === 'rfqs' && <RfqList companyId={companyId} />}

      <PurchasingSettingsDialog open={settingsOpen} companyId={companyId} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}
