'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined';

import { useLoad } from '@/hooks/useLoad';
import { formatUnitQuantity, unitLabel, unitNameKey } from '@/lib/purchasing/purchaseUnits';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import LoadFailedState from '@/components/common/LoadFailedState';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import StatusDot from '@/components/common/StatusDot';
import { listVendorPoReceipts } from '@/utils/vendorPoAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import type { VendorPoReceiptListRow } from '@/types/vendorPo';
import type { Vendor } from '@/types/vendor';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function localMidnight(isoDate: string, addDays = 0): string | null {
  const m = DATE_ONLY.exec(isoDate);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays).toISOString();
}

/**
 * A From–To pair of calendar days as the instants the receipts read takes: from the From day's
 * LOCAL midnight, up to (not including) the local midnight after the To day — so "Nov 1 to Nov 30"
 * is the whole of November on the bookkeeper's clock, not UTC's. A blank end is no bound.
 */
export function dayRangeToInstants(from: string, to: string): { receivedFrom: string | null; receivedBefore: string | null } {
  return { receivedFrom: localMidnight(from), receivedBefore: localMidnight(to, 1) };
}

function formatReceivedAt(instant: string): string {
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export interface VendorPoReceiptsListProps {
  companyId: string;
}

/**
 * The Receipts tab of the Purchasing hub — what arrived against POs, for the bookkeeper's month
 * end (plan §3.7). It is the "received, not yet billed" list QuickBooks item receipts used to be:
 * by date range, vendor, PO and the vendor's packing-slip number, newest first.
 *
 * Read-only. A receipt is corrected by voiding it on its PO's page, where the stock consequence is
 * spelled out; a second place to void would be a second place to get that wrong.
 */
export default function VendorPoReceiptsList({ companyId }: VendorPoReceiptsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [from, setFrom] = useState(() => searchParams.get('from') ?? '');
  const [to, setTo] = useState(() => searchParams.get('to') ?? '');
  const [vendorId, setVendorId] = useState(() => searchParams.get('vendor') ?? '');
  const [poId, setPoId] = useState<string | null>(() => searchParams.get('po'));
  const [slip, setSlip] = useState(() => searchParams.get('slip') ?? '');
  const [slipDebounced, setSlipDebounced] = useState(() => searchParams.get('slip') ?? '');
  const [includeVoided, setIncludeVoided] = useState(() => searchParams.get('voided') === 'true');
  const [vendors, setVendors] = useState<Vendor[]>([]);

  useEffect(() => {
    let cancelled = false;
    getAllVendors(companyId)
      .then((rows) => {
        if (!cancelled) setVendors(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const writeUrl = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const slipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (slipTimer.current) clearTimeout(slipTimer.current);
  }, []);
  const handleSlip = (value: string) => {
    setSlip(value);
    if (slipTimer.current) clearTimeout(slipTimer.current);
    slipTimer.current = setTimeout(() => {
      setSlipDebounced(value);
      writeUrl('slip', value.trim() || null);
    }, 300);
  };

  const { data, loading, error, reload } = useLoad(() => {
    const range = dayRangeToInstants(from, to);
    return listVendorPoReceipts(companyId, {
      ...range,
      vendorId: vendorId || null,
      vendorPurchaseOrderId: poId,
      packingSlip: slipDebounced.trim() || null,
      includeVoided,
    });
  }, [companyId, from, to, vendorId, poId, slipDebounced, includeVoided]);

  const rows: VendorPoReceiptListRow[] = data?.rows ?? [];
  const hasFilters = Boolean(from || to || vendorId || poId || slipDebounced.trim() || includeVoided);
  const poLabel = poId ? (rows.find((r) => r.vendorPurchaseOrderId === poId)?.poNumber ?? 'One PO') : null;

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          label="Received from"
          type="date"
          size="small"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            writeUrl('from', e.target.value || null);
          }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Received to"
          type="date"
          size="small"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            writeUrl('to', e.target.value || null);
          }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Box sx={{ minWidth: 220 }}>
          <SearchableSelect
            options={vendors.map((v): SelectOption => ({ id: v.id, label: v.name }))}
            value={vendorId}
            onChange={(value) => {
              setVendorId(value);
              writeUrl('vendor', value || null);
            }}
            label="Vendor"
            allowNone
            noneLabel="All vendors"
            size="small"
          />
        </Box>
        <TextField
          label="Packing slip #"
          size="small"
          value={slip}
          onChange={(e) => handleSlip(e.target.value)}
          sx={{ width: { xs: '100%', sm: 180 } }}
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={includeVoided}
              onChange={(e) => {
                setIncludeVoided(e.target.checked);
                writeUrl('voided', e.target.checked ? 'true' : null);
              }}
              size="small"
              sx={{ color: 'text.secondary', '&.Mui-checked': { color: 'primary.light' } }}
            />
          }
          label="Show voided"
          sx={{ ml: 0 }}
        />
        {poLabel && (
          <Chip
            label={poLabel}
            variant="outlined"
            onDelete={() => {
              setPoId(null);
              writeUrl('po', null);
            }}
          />
        )}
      </Box>

      {data?.truncated && !error && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Showing the newest {rows.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')} receipts.
          Narrow the dates or pick a vendor to see the rest.
        </Alert>
      )}

      <Card elevation={2}>
        {error != null && !loading ? (
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <LoadFailedState error={error} entity="receipts" onRetry={() => void reload()} />
          </CardContent>
        ) : loading && !data ? (
          <CardContent sx={{ p: 6, display: 'flex', justifyContent: 'center' }}>
            <CircularProgress />
          </CardContent>
        ) : rows.length === 0 ? (
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <MoveToInboxOutlinedIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              {hasFilters ? 'No receipts match these filters.' : 'No receipts yet'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {hasFilters
                ? 'Try a wider date range, or another vendor.'
                : 'Deliveries recorded against a purchase order show here.'}
            </Typography>
          </CardContent>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Receipts">
              <TableHead>
                <TableRow>
                  <TableCell>Received</TableCell>
                  <TableCell>PO #</TableCell>
                  <TableCell>Vendor</TableCell>
                  <TableCell>Line</TableCell>
                  <TableCell align="right">Quantity</TableCell>
                  <TableCell>Place</TableCell>
                  <TableCell>Heat</TableCell>
                  <TableCell>Packing slip</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => {
                  const showStock =
                    r.stockQuantity !== null && r.stockUnit !== null && unitNameKey(r.unit) !== unitNameKey(r.stockUnit);
                  return (
                    <TableRow key={r.id} sx={{ opacity: r.voidedAt ? 0.6 : 1 }}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, whiteSpace: 'nowrap' }}>
                          {formatReceivedAt(r.receivedAt)}
                          {r.voidedAt && <StatusDot label="Voided" color="default" />}
                        </Box>
                      </TableCell>
                      <TableCell>
                        <MuiLink component={Link} href={vendorPoPath(companyId, r.vendorPurchaseOrderId)} sx={{ fontWeight: 600 }}>
                          {r.poNumber}
                        </MuiLink>
                      </TableCell>
                      <TableCell>{r.vendorName}</TableCell>
                      <TableCell>
                        Line {r.lineNumber ?? '—'} · {r.partName ?? r.description ?? '—'}
                      </TableCell>
                      <TableCell align="right">
                        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                          {formatUnitQuantity(r.quantity)} {unitLabel(r.unit)}
                        </Box>
                        {showStock && r.stockQuantity !== null && r.stockUnit !== null && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            = {formatUnitQuantity(r.stockQuantity)} {unitLabel(r.stockUnit)}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{r.locationName ?? '—'}</TableCell>
                      <TableCell>{r.heatNumber ?? '—'}</TableCell>
                      <TableCell>{r.vendorPackingSlip ?? '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>
    </Box>
  );
}
