'use client';

import { Fragment, type ReactNode } from 'react';
import NextLink from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import MuiLink from '@mui/material/Link';
import Select from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { sumDecimal } from '@/lib/money';
import { formatVendorPoAmount, formatVendorPoUnitPrice } from '@/lib/purchasing/amount';
import { formatShortDate, type PriceDefault } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, stockEquivalentLabel, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { PART_VENDOR_STATUS_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import { vendorRfqPath } from '@/lib/purchasingRoutes';
import { isValidQuantityInput } from '@/lib/quantityInput';
import type { BuyListPricedGroup, BuyListPricedRow } from '@/types/buyList';

/** The "Buy from" option that opens the any-vendor picker. */
export const ANOTHER_VENDOR = '__another_vendor__';

/** One row as the list shows it: what the person typed, and the price and amount for THAT. */
export interface BuyListRowView {
  row: BuyListPricedRow;
  /** What the quantity field shows: the suggestion until someone types. */
  quantityText: string;
  /** The quantity to order, in purchase units; `null` while blank or not a quantity. */
  quantity: number | null;
  /** The default price for `quantity` (a break can change with it). */
  price: PriceDefault;
  amount: number | null;
  ticked: boolean;
}

export interface BuyListVendorGroupProps {
  companyId: string;
  group: BuyListPricedGroup;
  /** The group's rows as shown (already narrowed by any job filter), in need order. */
  rows: BuyListRowView[];
  /** This group's order is in flight. */
  busy: boolean;
  /** Another group's order is in flight: one write at a time. */
  disabled: boolean;
  /** The last refusal of this group's order. */
  error: unknown;
  onQuantityChange: (rowKey: string, text: string) => void;
  onTickChange: (rowKey: string, ticked: boolean) => void;
  /** A vendor id from the row's "Buy from", or ANOTHER_VENDOR. */
  onBuyFrom: (row: BuyListPricedRow, value: string) => void;
  onOrder: () => void;
}

const MAX_JOBS_NAMED = 3;

/** "Short 5 each" / "12 in under its reorder point" — in the stock unit, as stored. */
function gapLabel(row: BuyListPricedRow): string | null {
  const unit = row.stockUnit ? ` ${row.stockUnit}` : '';
  if (row.position < 0) return `Short ${formatUnitQuantity(-row.position)}${unit}`;
  if (row.reorderPoint === null) return null;
  const under = row.reorderPoint - row.position;
  return under > 0 ? `${formatUnitQuantity(under)}${unit} under its reorder point` : 'At its reorder point';
}

/** "20 needed · 15 on hand · 10 on order" — the figures the gap comes from, zero clauses dropped. */
function figuresLine(row: BuyListPricedRow): string {
  const out: string[] = [];
  if (row.demand > 0) out.push(`${formatUnitQuantity(row.demand)} needed`);
  out.push(`${formatUnitQuantity(row.onHand)} on hand`);
  if (row.onOrder > 0) out.push(`${formatUnitQuantity(row.onOrder)} on order`);
  if (row.onDraft > 0) out.push(`${formatUnitQuantity(row.onDraft)} on draft`);
  if (row.reorderPoint !== null) out.push(`reorder point ${formatUnitQuantity(row.reorderPoint)}`);
  return out.join(' · ');
}

/** Which jobs want it (links), soonest first; what cannot be compared is said, never dropped. */
function WhyLine({ row, companyId }: { row: BuyListPricedRow; companyId: string }) {
  const needing = row.jobs.filter((j) => j.need > 0);
  const named = needing.slice(0, MAX_JOBS_NAMED);
  const more = needing.length - named.length;
  return (
    <Typography variant="body2" color="text.secondary" component="div">
      {named.length > 0 && (
        <>
          {'For '}
          {named.map((j, i) => (
            <Fragment key={j.jobId}>
              {i > 0 && ', '}
              <MuiLink component={NextLink} href={`/dashboard/${companyId}/jobs/${j.jobId}`}>
                {j.jobNumber}
              </MuiLink>
              {j.dueDate ? ` (due ${formatShortDate(j.dueDate)})` : ''}
            </Fragment>
          ))}
          {more > 0 ? `, +${more} more` : ''}
        </>
      )}
      {row.reason === 'below_zero' && 'Stock is below zero'}
      {row.incomparableJobCount > 0 &&
        ` · ${row.incomparableJobCount} ${row.incomparableJobCount === 1 ? 'job draws' : 'jobs draw'} it in a unit that can't be compared`}
    </Typography>
  );
}

function RowLine({
  view,
  companyId,
  disabled,
  onQuantityChange,
  onTickChange,
  onBuyFrom,
}: {
  view: BuyListRowView;
  companyId: string;
  disabled: boolean;
  onQuantityChange: BuyListVendorGroupProps['onQuantityChange'];
  onTickChange: BuyListVendorGroupProps['onTickChange'];
  onBuyFrom: BuyListVendorGroupProps['onBuyFrom'];
}) {
  const { row, price } = view;
  const gap = gapLabel(row);
  const equivalent =
    view.quantity !== null && row.purchaseFactor !== 1 && row.stockUnit
      ? stockEquivalentLabel(view.quantity, {
          kind: 'converted',
          unit: row.purchaseUnit,
          stockUnit: row.stockUnit,
          factor: row.purchaseFactor,
          source: 'conversion',
        })
      : null;

  // "Buy from": the part's usable listed vendors, Approved first (the access layer's order), plus
  // the current vendor when it was picked from outside the list.
  const options: Array<{ vendorId: string; vendorName: string; detail: string }> = row.vendorPrices.map((v) => ({
    vendorId: v.vendorId,
    vendorName: v.vendorName,
    detail: `${v.status ? PART_VENDOR_STATUS_CONFIG[v.status].label : 'Not on its list'} · ${formatVendorPoUnitPrice(v.price.unitPrice)}`,
  }));
  if (row.vendor && !options.some((o) => o.vendorId === row.vendor?.vendorId)) {
    options.push({ vendorId: row.vendor.vendorId, vendorName: row.vendor.vendorName, detail: 'Not on its list' });
  }
  const vendorNames = new Map(options.map((o) => [o.vendorId, o.vendorName]));

  return (
    <TableRow sx={{ verticalAlign: 'top' }}>
      <TableCell padding="checkbox">
        <Checkbox
          checked={view.ticked}
          onChange={(e) => onTickChange(row.key, e.target.checked)}
          disabled={disabled}
          inputProps={{ 'aria-label': `Include ${row.partName}` }}
        />
      </TableCell>
      <TableCell sx={{ minWidth: 0 }}>
        <MuiLink
          component={NextLink}
          href={`/dashboard/${companyId}/parts/${row.partId}`}
          sx={{ fontWeight: 600, color: 'text.primary' }}
          underline="hover"
        >
          {row.partName}
        </MuiLink>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap', mt: 0.25 }}>
          {gap && (
            <Typography variant="body2" sx={{ color: 'warning.light', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {gap}
            </Typography>
          )}
          <WhyLine row={row} companyId={companyId} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}>
          {figuresLine(row)}
        </Typography>
      </TableCell>
      <TableCell>
        <TextField
          size="small"
          value={view.quantityText}
          onChange={(e) => {
            if (isValidQuantityInput(e.target.value)) onQuantityChange(row.key, e.target.value);
          }}
          disabled={disabled}
          error={view.ticked && view.quantity === null}
          helperText={equivalent ?? (row.purchaseUnitFallback ? `${row.vendor?.vendorName ?? 'The vendor'}'s unit can't be related — in ${unitLabel(row.purchaseUnit)}` : ' ')}
          sx={{ width: (t) => t.spacing(17) }}
          slotProps={{
            htmlInput: { 'aria-label': `Quantity of ${row.partName} to buy`, inputMode: 'decimal' },
            input: { endAdornment: <InputAdornment position="end">{unitLabel(row.purchaseUnit)}</InputAdornment> },
          }}
        />
      </TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        <Typography variant="body2">{formatVendorPoUnitPrice(price.unitPrice)}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {price.caption}
        </Typography>
        {price.warnings.map((w) => (
          <Typography key={w} variant="caption" sx={{ display: 'block', color: 'warning.light' }}>
            {w}
          </Typography>
        ))}
      </TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        <Typography variant="body2">{formatVendorPoAmount(view.amount)}</Typography>
      </TableCell>
      <TableCell>
        <Select
          size="small"
          value={row.vendor?.vendorId ?? ''}
          displayEmpty
          disabled={disabled}
          onChange={(e) => onBuyFrom(row, String(e.target.value))}
          inputProps={{ 'aria-label': `Buy ${row.partName} from` }}
          renderValue={(value) =>
            value ? (
              vendorNames.get(String(value)) ?? row.vendor?.vendorName ?? ''
            ) : (
              <Typography component="span" variant="body2" color="text.secondary">
                Choose a vendor
              </Typography>
            )
          }
          sx={{ minWidth: (t) => t.spacing(22) }}
        >
          {options.map((o) => (
            <MenuItem key={o.vendorId} value={o.vendorId}>
              <Box>
                <Typography variant="body2">{o.vendorName}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {o.detail}
                </Typography>
              </Box>
            </MenuItem>
          ))}
          <MenuItem value={ANOTHER_VENDOR}>Another vendor…</MenuItem>
        </Select>
      </TableCell>
    </TableRow>
  );
}

/**
 * One vendor's card on the Shortages list (plan §3.10): the parts to buy from them, each with its
 * suggested quantity (editable, kept through refreshes by the list), its default price and caption,
 * and "Buy from" — and ONE action for the group.
 *
 *   - a vendor with no draft PO      → "Create draft PO for Acme Steel"
 *   - a vendor with a live draft     → "Add to draft PO-1043" (never a second draft nobody merges)
 *   - "No vendor chosen"             → "Ask for prices (RFQ)", opening an RFQ with these parts
 *
 * The action sends only TICKED rows, and is held back — with the reason above it — while a ticked
 * row has no quantity. It is the only write here; the list itself only proposes.
 */
export default function BuyListVendorGroup({
  companyId,
  group,
  rows,
  busy,
  disabled,
  error,
  onQuantityChange,
  onTickChange,
  onBuyFrom,
  onOrder,
}: BuyListVendorGroupProps) {
  const title = group.vendorName ?? 'No vendor chosen';
  const ticked = rows.filter((v) => v.ticked);
  const missing = [
    ...(ticked.length === 0 ? ['Tick at least one part.'] : []),
    ...ticked.filter((v) => v.quantity === null).map((v) => `Enter how many ${v.row.partName} to buy.`),
  ];
  const total = sumDecimal(ticked.map((v) => v.amount).filter((a): a is number => a !== null));
  const anyUnpriced = ticked.some((v) => v.amount === null);
  // The RFQ form reads `part` (repeated) and `from=shortages`, which marks the RFQ as started here.
  const rfqHref = `${vendorRfqPath(companyId, 'new')}?${[
    ...ticked.map((v) => `part=${encodeURIComponent(v.row.partId)}`),
    'from=shortages',
  ].join('&')}`;

  let action: ReactNode;
  if (group.vendorId) {
    const label = group.draft ? `Add to draft ${group.draft.poNumber}` : `Create draft PO for ${title}`;
    action = (
      <Button variant="outlined" onClick={onOrder} disabled={busy || disabled || missing.length > 0}>
        {busy ? (group.draft ? 'Adding…' : 'Creating…') : label}
      </Button>
    );
  } else if (ticked.length > 0) {
    action = (
      <Button variant="outlined" component={NextLink} href={rfqHref}>
        Ask for prices (RFQ)
      </Button>
    );
  } else {
    action = (
      <Button variant="outlined" disabled>
        Ask for prices (RFQ)
      </Button>
    );
  }

  return (
    <Card component="section" aria-label={title}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
          <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
            {group.vendorId ? (
              <MuiLink component={NextLink} href={`/dashboard/${companyId}/vendors/${group.vendorId}`} color="inherit" underline="hover">
                {title}
              </MuiLink>
            ) : (
              title
            )}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {rows.length} {rows.length === 1 ? 'part' : 'parts'}
            {group.vendorId && ticked.length > 0 ? ` · ${formatVendorPoAmount(total)}${anyUnpriced ? ' + TBC' : ''}` : ''}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {action}
        </Box>
        {!group.vendorId && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Pick a vendor in Buy from to order, or ask vendors for prices first.
          </Typography>
        )}

        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Part</TableCell>
                <TableCell>Buy</TableCell>
                <TableCell align="right">Unit price</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell>Buy from</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((view) => (
                <RowLine
                  key={view.row.key}
                  view={view}
                  companyId={companyId}
                  disabled={busy || disabled}
                  onQuantityChange={onQuantityChange}
                  onTickChange={onTickChange}
                  onBuyFrom={onBuyFrom}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>

        {group.vendorId && <MissingFieldsNotice items={missing} title="Before you can order:" />}
        {Boolean(error) && <ErrorAlert error={error} entity="purchase order" sx={{ mt: 1 }} />}
      </CardContent>
    </Card>
  );
}
