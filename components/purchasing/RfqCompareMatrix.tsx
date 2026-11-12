'use client';

/**
 * The RFQ comparison, and the award (plan §3.9; criterion Q3).
 *
 * Rows are line × quantity and columns are the invited vendors, priced per the RFQ line's own unit,
 * so every cell in a row compares like with like. The matrix is `rfq.comparison` exactly as the
 * access layer built it with the reader's date (lib/purchasing/rfqCompare.ts): "Lowest" is a WORD
 * on the cell — never colour alone, because these are read by men over fifty under shop lighting —
 * an expired quote is never Lowest, and a price tie goes to the shorter lead time.
 *
 * The award is a radio per LINE (pick a vendor at one of its quantities), then one
 * `award_vendor_rfq` call that makes one draft PO per vendor. "Save to price sheets" starts
 * unticked: an award is a decision about this order, and writing a vendor's price sheet is a
 * separate decision the person has to make on purpose.
 */
import { useMemo, useState } from 'react';
import NextLink from 'next/link';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import StatusChip from '@/components/common/StatusChip';
import { formatMoney, formatUnitPrice } from '@/lib/money';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { LOWEST_LABEL, planVendorRfqAward, type RfqCompareCell } from '@/lib/purchasing/rfqCompare';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import { awardVendorRfq } from '@/utils/vendorRfqAccess';
import type { AwardVendorRfqResult, VendorRfqDetail } from '@/types/vendorRfq';

export interface RfqCompareMatrixProps {
  companyId: string;
  rfq: VendorRfqDetail;
  /** The reader's local date — the same one the comparison was built with. */
  today: string;
  /** Closed or archived: the quotes still show, and nothing can be awarded. */
  readOnly?: boolean;
  /** After an award: the page refreshes. The matrix keeps the result to link the new drafts. */
  onAwarded: () => void;
}

function days(n: number | null): string | null {
  if (n === null) return null;
  return n === 1 ? '1 day' : `${n} days`;
}

/** What one vendor said for one line at one quantity. Words first; colour only reinforces them. */
function CellContent({ cell, unit }: { cell: RfqCompareCell; unit: string }) {
  if (cell.state === 'declined') {
    return (
      <Typography variant="body2" color="text.secondary">
        Declined
      </Typography>
    );
  }
  if (cell.state === 'no_bid') {
    return (
      <Typography variant="body2" color="text.secondary">
        No bid
      </Typography>
    );
  }
  if (cell.state === 'no_response' || cell.unitPrice === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        No reply yet
      </Typography>
    );
  }
  const lead = days(cell.leadTimeDays);
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {formatUnitPrice(cell.unitPrice)} / {unitLabel(unit)}
        </Typography>
        {cell.isLowest && <StatusChip color="success" label={LOWEST_LABEL} />}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div">
        {formatMoney(cell.amount)} total{lead ? ` · ${lead}` : ''}
      </Typography>
      {cell.state === 'expired' && cell.validUntil ? (
        <Typography variant="caption" component="div" sx={{ color: 'warning.light', fontWeight: 600 }}>
          Expired {formatShortDate(cell.validUntil)}
        </Typography>
      ) : (
        cell.validUntil && (
          <Typography variant="caption" color="text.secondary" component="div">
            Good to {formatShortDate(cell.validUntil)}
          </Typography>
        )
      )}
    </Box>
  );
}

export default function RfqCompareMatrix({ companyId, rfq, today, readOnly = false, onAwarded }: RfqCompareMatrixProps) {
  const { comparison } = rfq;
  // lineId → the response chosen for it.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saveToPriceSheets, setSaveToPriceSheets] = useState(false);
  const [awarding, setAwarding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AwardVendorRfqResult | null>(null);

  /** The awarded response per line, with who won it. */
  const awarded = useMemo(() => {
    const out = new Map<string, { vendorName: string; quantity: number }>();
    for (const r of rfq.responses) {
      if (!r.awardedAt) continue;
      const vendor = rfq.invitations.find((i) => i.id === r.invitationId);
      out.set(r.lineId, { vendorName: vendor?.vendorName ?? '', quantity: r.quantity });
    }
    return out;
  }, [rfq.responses, rfq.invitations]);

  const planArgs = useMemo(
    () => ({
      lines: rfq.lines.map((l) => ({
        lineId: l.id,
        lineNumber: l.lineNumber,
        label: l.partName ?? l.description,
        unit: l.unit,
        quantities: l.quantities,
      })),
      vendors: rfq.invitations.map((i) => ({
        invitationId: i.id,
        vendorId: i.vendorId,
        vendorName: i.vendorName,
        declined: i.declinedAt !== null,
      })),
      responses: rfq.responses.map((r) => ({
        responseId: r.id,
        invitationId: r.invitationId,
        lineId: r.lineId,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        noBid: r.noBid,
        leadTimeDays: r.leadTimeDays,
        validUntil: r.validUntil,
        awarded: r.awardedAt !== null,
      })),
      today,
    }),
    [rfq.lines, rfq.invitations, rfq.responses, today],
  );

  const selected = useMemo(() => Object.values(picked), [picked]);
  const plan = useMemo(() => planVendorRfqAward(selected, planArgs), [selected, planArgs]);
  const canAward = !readOnly && selected.length > 0 && plan.problems.length === 0 && !awarding;
  const anyAwardable = !readOnly && rfq.lines.some((l) => !awarded.has(l.id));

  const handleAward = async () => {
    if (!canAward) return;
    setAwarding(true);
    setError(null);
    try {
      const res = await awardVendorRfq(rfq.header.id, selected, { saveToPriceSheets, today });
      posthog.capture('vendor rfq awarded', {
        po_count: res.purchaseOrders.length,
        split_award: res.purchaseOrders.length > 1,
        saved_to_price_sheets: saveToPriceSheets,
      });
      setResult(res);
      setPicked({});
      onAwarded();
    } catch (err) {
      setError(err);
    } finally {
      setAwarding(false);
    }
  };

  if (comparison.rows.length === 0 || comparison.vendors.length === 0) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
            Compare quotes
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {comparison.vendors.length === 0
              ? 'Ask at least one vendor to quote, and their prices will line up here.'
              : 'Add a line to compare prices on.'}
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Compare quotes
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Prices are per each line&apos;s unit. An expired quote is never marked Lowest; on a tie, the shorter lead time
          wins.
          {anyAwardable ? ' Pick one quote for each line you want to order, then create the draft POs.' : ''}
        </Typography>

        {result && result.purchaseOrders.length > 0 && (
          <Alert severity="success" sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
              {result.purchaseOrders.length === 1 ? 'Created 1 draft PO:' : `Created ${result.purchaseOrders.length} draft POs:`}
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {result.purchaseOrders.map((po) => (
                <Box component="li" key={po.id}>
                  <MuiLink component={NextLink} href={vendorPoPath(companyId, po.id)} underline="hover">
                    {po.poNumber}
                  </MuiLink>{' '}
                  for {po.vendorName}
                </Box>
              ))}
            </Box>
            {result.savedPartVendorIds.length > 0 && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                The awarded prices were saved to the vendors&apos; price sheets.
              </Typography>
            )}
          </Alert>
        )}

        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Line and quantity</TableCell>
                {comparison.vendors.map((v) => (
                  <TableCell key={v.invitationId} sx={{ fontWeight: 600, minWidth: 180 }}>
                    {v.vendorName}
                    {v.declined ? (
                      <Typography variant="caption" color="text.secondary" component="div">
                        Declined
                      </Typography>
                    ) : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {comparison.rows.map((row, index) => {
                const firstOfLine = index === 0 || comparison.rows[index - 1].lineId !== row.lineId;
                const won = awarded.get(row.lineId);
                return (
                  <TableRow
                    key={`${row.lineId}:${row.quantity}`}
                    sx={firstOfLine && index > 0 ? { '& > *': { borderTop: 1, borderTopColor: 'divider' } } : undefined}
                  >
                    <TableCell component="th" scope="row" sx={{ verticalAlign: 'top' }}>
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: firstOfLine ? 600 : 400, color: firstOfLine ? 'text.primary' : 'text.secondary' }}
                      >
                        Line {row.lineNumber} · {row.label}
                      </Typography>
                      <Typography variant="body2">
                        {formatUnitQuantity(row.quantity)} {unitLabel(row.unit)}
                      </Typography>
                      {won && firstOfLine && (
                        <Typography variant="caption" color="text.secondary" component="div">
                          Awarded to {won.vendorName} at {formatUnitQuantity(won.quantity)} {unitLabel(row.unit)}
                        </Typography>
                      )}
                    </TableCell>
                    {row.cells.map((c) => {
                      const awardable =
                        !readOnly &&
                        !won &&
                        c.responseId !== null &&
                        (c.state === 'priced' || c.state === 'expired');
                      return (
                        <TableCell key={c.invitationId} sx={{ verticalAlign: 'top' }}>
                          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
                            {awardable && c.responseId && (
                              <Radio
                                size="small"
                                name={`award-${row.lineId}`}
                                checked={picked[row.lineId] === c.responseId}
                                onChange={() => {
                                  const id = c.responseId;
                                  if (id) setPicked((prev) => ({ ...prev, [row.lineId]: id }));
                                }}
                                slotProps={{
                                  input: {
                                    'aria-label': `Award line ${row.lineNumber} at ${formatUnitQuantity(row.quantity)} ${unitLabel(row.unit)} to ${c.vendorName}`,
                                  },
                                }}
                                sx={{ mt: -0.75 }}
                              />
                            )}
                            <CellContent cell={c} unit={row.unit} />
                          </Box>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>

        {anyAwardable && (
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Checkbox checked={saveToPriceSheets} onChange={(e) => setSaveToPriceSheets(e.target.checked)} />
              }
              label="Also save the awarded prices to each vendor's price sheets for these parts"
            />
            <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 4, mb: 1 }}>
              It adds the vendor to a part&apos;s approved vendors if it isn&apos;t there yet. Lines without a part are
              left out.
            </Typography>

            {plan.warnings.length > 0 && (
              <Alert severity="warning" sx={{ mb: 1 }}>
                {plan.warnings.map((w) => (
                  <Typography key={w} variant="body2">
                    {w}
                  </Typography>
                ))}
              </Alert>
            )}
            <ErrorAlert error={error} entity="RFQ" onClose={() => setError(null)} sx={{ mb: 1 }} />
            <MissingFieldsNotice items={selected.length > 0 ? plan.problems : []} title="Before you can award:" />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1, flexWrap: 'wrap' }}>
              {selected.length > 0 && (
                <Button onClick={() => setPicked({})} disabled={awarding}>
                  Clear choices
                </Button>
              )}
              <Button variant="contained" onClick={handleAward} disabled={!canAward}>
                {awarding ? 'Creating…' : `Create draft POs (${plan.poCount})`}
              </Button>
            </Box>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
