'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import StatusDot from '@/components/common/StatusDot';
import { formatDateOnly } from '@/lib/localDate';
import { formatVendorPoAmount, formatVendorPoUnitPrice } from '@/lib/purchasing/amount';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { VENDOR_PO_OVERDUE, vendorPoLineStateDisplay } from '@/lib/purchasing/vendorPoStatus';
import { isClosableLine } from '@/components/purchasing/CloseVendorPoLinesDialog';
import OutsideLineSlips from '@/components/purchasing/OutsideLineSlips';
import type { VendorPoDetail, VendorPoLine } from '@/types/vendorPo';

export interface VendorPoLinesTableProps {
  companyId: string;
  po: VendorPoDetail;
  /** An archived PO: nothing changes but the internal promised dates. */
  readOnly: boolean;
  /** Auto-save of one line's internal promised date — never the vendor-visible save. */
  onPromisedOnSave: (line: VendorPoLine, promisedOn: string | null) => Promise<void>;
  onCloseLine: (line: VendorPoLine) => void;
  onReopenLine: (line: VendorPoLine) => void;
  onOpenSlip: (slipId: string) => void;
  onReceiveOutside: (line: VendorPoLine) => void;
  /** An outside line's slip was unlinked or linked by hand, with the sentence to show. */
  onSlipLinkChanged: (message: string) => void;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function quantity(n: number | null | undefined, unit: string | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${formatUnitQuantity(n)}${unit ? ` ${unitLabel(unit)}` : ''}`;
}

/**
 * A line's promised date — the vendor's word, kept for us. INTERNAL: never printed, never pushed,
 * never a revision, so it saves itself (interaction-standards.md "Saving": auto-save on a single
 * internal field) and is allowed even on a closed or archived PO.
 */
function PromisedOnField({ line, onSave }: { line: VendorPoLine; onSave: VendorPoLinesTableProps['onPromisedOnSave'] }) {
  const [value, setValue] = useState(line.promisedOn ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const saved = useRef(line.promisedOn ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const save = async (next: string) => {
    if (next === saved.current) return;
    if (next !== '' && !DATE_ONLY.test(next)) return;
    setState('saving');
    try {
      await onSave(line, next === '' ? null : next);
      saved.current = next;
      setState('saved');
    } catch {
      setState('error');
    }
  };

  const schedule = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 600);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <TextField
        label="Promised"
        type="date"
        size="small"
        value={value}
        onChange={(e) => schedule(e.target.value)}
        onBlur={() => {
          if (timer.current) clearTimeout(timer.current);
          void save(value);
        }}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': `Promised date, line ${line.lineNumber}` } }}
        sx={{ width: (theme) => theme.spacing(21) }}
      />
      <SaveStatus state={state} />
    </Box>
  );
}

/**
 * The PO's lines with their progress, all of it DERIVED in SQL (vendor_purchase_order_line_status):
 * Ordered (with the stock equivalent the line froze), Received, Open, Due, and the PO price
 * (plan §3.13 "Lines table"). A part line counts progress in stock units, so it is exact.
 *
 * Outside lines are received on their vendor packing slips, which are listed under the line
 * ([`OutsideLineSlips`]) — a slip opens its own preview, where Void lives; "Sent · back · at vendor"
 * comes from those slips, never from a receipt on the PO; and the slips the line counts are
 * corrected by hand there (Unlink, Link a slip…), under the same gate as every other line action.
 */
export default function VendorPoLinesTable({
  companyId,
  po,
  readOnly,
  onPromisedOnSave,
  onCloseLine,
  onReopenLine,
  onOpenSlip,
  onReceiveOutside,
  onSlipLinkChanged,
}: VendorPoLinesTableProps) {
  const poClosed = po.header.closedAt !== null;
  const slipsFor = (lineId: string) => po.outsideSlips.filter((s) => s.vendorPurchaseOrderLineId === lineId);

  return (
    <TableContainer>
      <Table size="small" aria-label="Purchase order lines">
        <TableHead>
          <TableRow>
            <TableCell>Line</TableCell>
            <TableCell align="right">Ordered</TableCell>
            <TableCell align="right">Received</TableCell>
            <TableCell align="right">Open</TableCell>
            <TableCell>Due</TableCell>
            <TableCell align="right">Unit price</TableCell>
            <TableCell align="right">Amount</TableCell>
            <TableCell>State</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {po.lines.map((line) => {
            const state = vendorPoLineStateDisplay(line.status, {
              orderedQuantity: line.quantity,
              receivedQuantity: line.receivedQuantity,
            });
            const converted = line.lineKind === 'part' && line.stockUnit && line.stockFactor !== null && line.stockFactor !== 1;
            const isOutside = line.lineKind === 'outside_service';
            return (
              <TableRow key={line.id} sx={{ verticalAlign: 'top' }} data-testid={`po-line-${line.id}`}>
                <TableCell sx={{ minWidth: (theme) => theme.spacing(36) }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {line.lineNumber}.{' '}
                    {line.partId && line.lineKind === 'part' ? (
                      <MuiLink component={Link} href={`/dashboard/${companyId}/parts/${line.partId}`}>
                        {line.partName ?? line.description}
                      </MuiLink>
                    ) : (
                      line.description
                    )}
                  </Typography>
                  {line.lineKind === 'part' && line.partName && line.partName !== line.description && (
                    <Typography variant="body2" color="text.secondary">
                      {line.description}
                    </Typography>
                  )}
                  <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                    {line.vendorPartNumber && (
                      <Typography variant="caption" color="text.secondary">
                        Vendor part # {line.vendorPartNumber}
                      </Typography>
                    )}
                    {line.jobId && line.jobNumber && (
                      <Typography variant="caption" color="text.secondary">
                        For{' '}
                        <MuiLink component={Link} href={`/dashboard/${companyId}/jobs/${line.jobId}`}>
                          {line.jobNumber}
                        </MuiLink>
                        {line.operationLabel ? ` · ${line.operationLabel}` : ''}
                      </Typography>
                    )}
                    {line.workCenterName && (
                      <Typography variant="caption" color="text.secondary">
                        For {line.workCenterName}
                      </Typography>
                    )}
                    {line.certRequired && (
                      <Typography variant="caption" color="text.secondary">
                        Certs required
                      </Typography>
                    )}
                    {!line.expectsReceipt && (
                      <Typography variant="caption" color="text.secondary">
                        No delivery expected (a fee or freight)
                      </Typography>
                    )}
                  </Stack>
                  {isOutside && (
                    <OutsideLineSlips
                      po={po}
                      line={line}
                      slips={slipsFor(line.id)}
                      canCorrect={!readOnly && !poClosed}
                      onOpenSlip={onOpenSlip}
                      onChanged={onSlipLinkChanged}
                    />
                  )}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {quantity(line.quantity, line.unit)}
                  {converted && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      = {quantity(line.orderedStockQuantity, line.stockUnit)}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {quantity(line.receivedQuantity, line.unit)}
                  {converted && line.receivedStockQuantity !== null && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      = {quantity(line.receivedStockQuantity, line.stockUnit)}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {quantity(line.openQuantity, line.unit)}
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                    {line.needByOn ? `Need by ${formatDateOnly(line.needByOn)}` : 'No date'}
                  </Typography>
                  {isOutside && line.expectedOn && line.expectedOn !== line.needByOn && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Due back {formatDateOnly(line.expectedOn)}
                    </Typography>
                  )}
                  {line.isLate && (
                    <Typography variant="caption" sx={{ display: 'block', color: 'warning.light', fontWeight: 600 }}>
                      {VENDOR_PO_OVERDUE.label}
                    </Typography>
                  )}
                  {!isOutside && (
                    <Box sx={{ mt: 1 }}>
                      <PromisedOnField line={line} onSave={onPromisedOnSave} />
                    </Box>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {formatVendorPoUnitPrice(line.unitPrice)}
                  {line.unitPrice !== null && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      per {unitLabel(line.unit)}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {formatVendorPoAmount(line.amount)}
                </TableCell>
                <TableCell>
                  <StatusDot label={state.label} color={state.color} />
                  {!readOnly && !poClosed && (
                    <Stack spacing={0.5} sx={{ mt: 1, alignItems: 'flex-start' }}>
                      {isOutside && line.closedAt === null && (
                        <Button size="small" variant="outlined" onClick={() => onReceiveOutside(line)}>
                          Receive on {line.jobNumber ?? 'the job'}
                        </Button>
                      )}
                      {isClosableLine(line) && po.header.issuedAt !== null && (
                        <Button size="small" onClick={() => onCloseLine(line)}>
                          Close short
                        </Button>
                      )}
                      {line.closedAt !== null && (
                        <Button size="small" onClick={() => onReopenLine(line)}>
                          Reopen
                        </Button>
                      )}
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
