'use client';

import { useState } from 'react';
import NextLink from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import StatusDot from '@/components/common/StatusDot';
import { useLoad } from '@/hooks/useLoad';
import { todayLocalISODate } from '@/lib/localDate';
import { formatMoney } from '@/lib/money';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import {
  VENDOR_PO_DEFAULT_LIST_STATUSES,
  VENDOR_PO_OVERDUE,
  vendorPoStatusDisplay,
} from '@/lib/purchasing/vendorPoStatus';
import { purchasingHubPath, vendorPoPath } from '@/lib/purchasingRoutes';
import { listVendorPosForVendor } from '@/utils/vendorPoAccess';

export interface VendorPurchaseOrdersCardProps {
  companyId: string;
  vendorId: string;
  vendorName: string;
}

/** How many open POs the card lists before pointing at the hub. */
const CARD_LIMIT = 10;

/**
 * This vendor's OPEN purchase orders — Draft, Sent, Partly received — newest first, each a link
 * (plan §3.13 "Elsewhere"). Read from `vendor_purchase_order_status` like the hub's list, so the
 * status, next due date, Overdue and open value here are the list's, computed once in SQL.
 *
 * Loads on its own, so a purchasing read that fails costs this card a Retry and never the vendor
 * page. A failure never reads as "no open POs" — that answer is how a second PO gets raised.
 */
export default function VendorPurchaseOrdersCard({ companyId, vendorId, vendorName }: VendorPurchaseOrdersCardProps) {
  const [today] = useState(todayLocalISODate);
  const { data, loading, error, reload } = useLoad(
    () => listVendorPosForVendor(vendorId, { today, statuses: VENDOR_PO_DEFAULT_LIST_STATUSES, limit: CARD_LIMIT }),
    [vendorId, today],
  );
  const result = error ? null : data;

  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Purchase orders
          </Typography>
          <Button
            size="small"
            startIcon={<AddIcon />}
            component={NextLink}
            href={`${vendorPoPath(companyId, 'new')}?vendor=${encodeURIComponent(vendorId)}`}
          >
            New PO
          </Button>
        </Box>
        <Divider sx={{ mb: 2 }} />

        {error ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void reload()}>
                Retry
              </Button>
            }
          >
            Couldn&apos;t load the purchase orders.
          </Alert>
        ) : loading || !result ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : result.rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No open purchase orders to {vendorName}.
          </Typography>
        ) : (
          <>
            <List dense disablePadding>
              {result.rows.map((po) => {
                const status = vendorPoStatusDisplay(po.status);
                return (
                  <ListItem key={po.id} disableGutters sx={{ display: 'block', py: 0.75 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                      <MuiLink component={NextLink} href={vendorPoPath(companyId, po.id)} sx={{ fontWeight: 600 }}>
                        {po.poNumber}
                      </MuiLink>
                      <StatusDot label={status.label} color={status.color} />
                      <Box sx={{ flex: 1 }} />
                      <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {`${formatMoney(po.openAmount)} open`}
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {`Ordered ${formatShortDate(po.orderedOn)}`}
                      {po.nextExpectedOn ? ` · next due ${formatShortDate(po.nextExpectedOn)}` : ''}
                      {po.isLate && (
                        <>
                          {' · '}
                          {/* Amber and in words: a late PO is behind, not broken. */}
                          <Box component="span" sx={{ color: 'warning.light', fontWeight: 600 }}>
                            {VENDOR_PO_OVERDUE.label}
                          </Box>
                        </>
                      )}
                    </Typography>
                  </ListItem>
                );
              })}
            </List>
            {result.truncated && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {`Showing ${result.rows.length} of ${result.total}. `}
                <MuiLink
                  component={NextLink}
                  href={`${purchasingHubPath(companyId, 'orders')}&vendor=${encodeURIComponent(vendorId)}`}
                >
                  See all
                </MuiLink>
              </Typography>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
