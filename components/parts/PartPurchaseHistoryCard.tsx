'use client';

/**
 * What is coming for a bought part (plan §3.8 "Purchase history card", §3.10 "Where on-order
 * appears"): on order — sent, open PO lines — and on draft — lines on POs not sent yet — kept
 * apart and in the part's stock unit, each with its PO.
 *
 * Read from `part_on_order` through `getOnOrderForParts`, the same numbers the buy list and the
 * job's Materials card show. A failed read says so with Try again — never "nothing on order",
 * which is the one answer a failure must not give. The last price paid per vendor is on each row of
 * the approved vendor list above ("Last PO price").
 */
import NextLink from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import type { PartOnOrder } from '@/types/vendorPo';

import { newVendorPoHref } from './ApprovedVendorsCard';

export interface PartPurchaseHistoryCardProps {
  companyId: string;
  partId: string;
  stockUnit: string | null;
  /** "New PO" starts with the part's preferred vendor when it has one. */
  preferredVendorId: string | null;
  /** Vendor names by id, from the approved list, to name each PO's vendor. */
  vendorNames: ReadonlyMap<string, string>;
  /** `null`: nothing on order or on draft. */
  onOrder: PartOnOrder | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

export default function PartPurchaseHistoryCard({
  companyId,
  partId,
  stockUnit,
  preferredVendorId,
  vendorNames,
  onOrder,
  loading,
  error,
  onRetry,
}: PartPurchaseHistoryCardProps) {
  const unit = unitLabel(onOrder?.stockUnit ?? stockUnit ?? '');
  const quantity = (n: number) => `${formatUnitQuantity(n)}${unit ? ` ${unit}` : ''}`;

  let body: React.ReactNode;
  if (error && !onOrder) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        Couldn&apos;t load what&apos;s on order.
      </Alert>
    );
  } else if (loading && !onOrder) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={24} />
      </Box>
    );
  } else if (!onOrder || (onOrder.onOrder <= 0 && onOrder.onDraft <= 0 && onOrder.refs.length === 0)) {
    body = (
      <Typography variant="body2" color="text.secondary">
        Nothing on order for this part.
      </Typography>
    );
  } else {
    const refs = [...onOrder.refs].sort((a, b) => {
      if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
      if (a.expectedOn === b.expectedOn) return a.poNumber.localeCompare(b.poNumber);
      if (a.expectedOn === null) return 1;
      if (b.expectedOn === null) return -1;
      return a.expectedOn < b.expectedOn ? -1 : 1;
    });
    body = (
      <>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 1.5 }}>
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            On order: {quantity(onOrder.onOrder)}
            {onOrder.nextExpectedOn ? (
              <Typography component="span" variant="body2" color="text.secondary">
                {' '}
                · next due {formatShortDate(onOrder.nextExpectedOn)}
              </Typography>
            ) : null}
          </Typography>
          {onOrder.onDraft > 0 && (
            <Typography variant="body1" color="text.secondary">
              On draft: {quantity(onOrder.onDraft)}
            </Typography>
          )}
        </Box>
        <Box component="ul" sx={{ m: 0, pl: 3 }}>
          {refs.map((ref) => {
            const vendor = vendorNames.get(ref.vendorId);
            return (
              <Box component="li" key={ref.lineId} sx={{ mb: 0.5 }}>
                <Typography variant="body2" component="span" sx={{ color: ref.isDraft ? 'text.secondary' : 'text.primary' }}>
                  <MuiLink component={NextLink} href={vendorPoPath(companyId, ref.vendorPurchaseOrderId)} underline="hover">
                    {ref.poNumber}
                  </MuiLink>
                  {vendor ? ` · ${vendor}` : ''}
                  {ref.isDraft
                    ? ` · Draft — not sent yet · ${quantity(ref.stockQuantity)}`
                    : ` · ${quantity(ref.stockQuantity)} still to come${ref.expectedOn ? ` · due ${formatShortDate(ref.expectedOn)}` : ''}`}
                </Typography>
              </Box>
            );
          })}
        </Box>
        {onOrder.unitMismatchLineCount > 0 && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            {onOrder.unitMismatchLineCount === 1
              ? "1 PO line is in a unit this part no longer uses, so it isn't counted here."
              : `${onOrder.unitMismatchLineCount} PO lines are in a unit this part no longer uses, so they aren't counted here.`}
          </Typography>
        )}
      </>
    );
  }

  return (
    <Card component="section" aria-label="Purchase orders">
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Purchase orders
          </Typography>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            component={NextLink}
            href={newVendorPoHref(companyId, partId, preferredVendorId)}
          >
            New PO
          </Button>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
          Only purchase orders in Jigged count as on order.
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}
