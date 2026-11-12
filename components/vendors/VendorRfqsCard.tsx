'use client';

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

import StatusDot from '@/components/common/StatusDot';
import { useLoad } from '@/hooks/useLoad';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { VENDOR_RFQ_STATUS_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import { vendorRfqPath } from '@/lib/purchasingRoutes';
import { listVendorRfqs } from '@/utils/vendorRfqAccess';

export interface VendorRfqsCardProps {
  companyId: string;
  /** Matched against each RFQ's invited vendor names — what the RFQ list carries. */
  vendorName: string;
}

/** How many of this vendor's RFQs the card lists. */
const CARD_LIMIT = 10;

/**
 * The RFQs this vendor was asked on, newest first, each a link (plan §3.13 "Elsewhere").
 *
 * `listVendorRfqs` is the hub's RFQ list and carries each RFQ's invited vendors BY NAME, so the
 * card keeps the RFQs naming this vendor. A shop has few RFQs, so one read of the list is cheap.
 * The name is the invitation's copy, taken when the vendor was invited: an RFQ sent before the
 * vendor was renamed carries the old name and is not listed here. (A vendor filter in the access
 * layer would close that gap.)
 *
 * Loads on its own, so a failure costs this card a Retry and never the vendor page — and never
 * reads as "never asked".
 */
export default function VendorRfqsCard({ companyId, vendorName }: VendorRfqsCardProps) {
  const { data, loading, error, reload } = useLoad(() => listVendorRfqs(companyId, {}), [companyId]);
  const rows = error || !data ? null : data.rows.filter((r) => r.vendorNames.includes(vendorName));
  const shown = rows?.slice(0, CARD_LIMIT) ?? [];

  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
          RFQs
        </Typography>
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
            Couldn&apos;t load the RFQs.
          </Alert>
        ) : loading || rows === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No RFQs have gone to {vendorName}.
          </Typography>
        ) : (
          <>
            <List dense disablePadding>
              {shown.map((r) => {
                const status = VENDOR_RFQ_STATUS_CONFIG[r.status];
                return (
                  <ListItem key={r.id} disableGutters sx={{ display: 'block', py: 0.75 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                      <MuiLink component={NextLink} href={vendorRfqPath(companyId, r.id)} sx={{ fontWeight: 600 }}>
                        {r.rfqNumber}
                      </MuiLink>
                      <StatusDot label={status.label} color={status.color} />
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {[r.title, r.respondByOn ? `answers by ${formatShortDate(r.respondByOn)}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  </ListItem>
                );
              })}
            </List>
            {rows.length > shown.length && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {`Showing ${shown.length} of ${rows.length}.`}
              </Typography>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
