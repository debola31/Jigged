'use client';

import { useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import CertAfterBatchPanel, { type LandedLot } from '@/components/inventory/CertAfterBatchPanel';
import HeatNumberField from '@/components/inventory/HeatNumberField';
import MillCertField from '@/components/inventory/MillCertField';
import LocationPicker, { type LocationPickerOption } from '@/components/inventory/locations/LocationPicker';
import { certificateUploadProperties } from '@/components/inventory/certificateTelemetry';
import DeleteIconButton from '@/components/common/DeleteIconButton';
import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { useLoad } from '@/hooks/useLoad';
import { todayLocalISODate } from '@/lib/localDate';
import {
  HEAT_STARTS_TRACKING_CAPTION,
  defaultReceiptLocationId,
  planVendorPoReceipt,
  prefillVendorPoReceiptRows,
  receiptOutstanding,
  type ReceiptLine,
  type ReceiptQuantityUnit,
  type ReceiptRow,
} from '@/lib/purchasing/poReceipt';
import {
  formatUnitQuantity,
  toPurchaseQuantity,
  toStockQuantity,
  unitLabel,
  type PurchaseUnitBasis,
} from '@/lib/purchasing/purchaseUnits';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import { getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';
import { uploadLotCertificate } from '@/utils/lotCertificatesAccess';
import { getPart } from '@/utils/partsAccess';
import {
  getRecentNoPoReceipts,
  markVendorPoSent,
  newVendorPoReceiptGroupId,
  receiveVendorPo,
} from '@/utils/vendorPoAccess';
import type { PartLocationBalanceWithLocation } from '@/types/inventoryLocations';
import type { NoPoStockAddition, VendorPoDetail, VendorPoLine, VendorPoReceiveResult } from '@/types/vendorPo';

export interface ReceiveVendorPoDialogProps {
  open: boolean;
  companyId: string;
  po: VendorPoDetail;
  onClose: () => void;
  /** After anything was written (the delivery, or the send a draft needed): the page refreshes. */
  onReceived: () => void;
  /**
   * "Receive on J-1042": outside work comes back on its vendor packing slip, through the job's own
   * receive dialog. The page closes this one and opens that one — never one dialog on another.
   */
  onReceiveOutside: (line: VendorPoLine) => void;
}

/**
 * Receive a delivery against a purchase order — the office's receiving bench (plan §3.7).
 *
 * ONE ATOMIC, IDEMPOTENT WRITE. The delivery's group id is minted once when the dialog opens and
 * sent on every retry of it, so a lost reply, a double click or a second tab replays the first
 * result instead of adding the stock twice. A fresh id is minted only after a success.
 *
 * Rows start with what is outstanding on each open part and other line ("= 432 in into stock");
 * a cleared row is skipped; "+ another heat or place" splits a line. A part's place defaults to
 * where it already holds the most, else where this PO last put it, and is required. Quantities go
 * to the database exactly as typed, in the unit typed — the database converts with the line's
 * frozen factor (lib/purchasing/poReceipt.ts).
 *
 * CERTIFICATES UPLOAD AFTER THE WRITE, against the lots it says landed. A failed upload never
 * un-records stock: the recovery panel appears for that lot alone, and Done is always enabled.
 *
 * Outside lines are listed read-only and hand off to their slip ("Receive on J-1042"). A draft asks
 * once — "Mark it sent today and receive?" — because the database refuses to receive on a draft.
 */
export default function ReceiveVendorPoDialog(props: ReceiveVendorPoDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      maxWidth="md"
      fullWidth
      aria-labelledby="receive-vendor-po-title"
    >
      <DialogTitle id="receive-vendor-po-title">Receive against {props.po.header.poNumber}</DialogTitle>
      {props.open && <ReceiveBody {...props} onBusyChange={setBusy} />}
    </Dialog>
  );
}

interface PartInfo {
  /** `null` when the part could not be read: say nothing rather than guess. */
  lotTracked: boolean | null;
  partName: string;
  balances: PartLocationBalanceWithLocation[];
  recentNoPo: NoPoStockAddition[];
}

/** One part's facts. Each read is a convenience and fails on its own, never the dialog. */
async function loadPartInfo(partId: string, fallbackName: string): Promise<[string, PartInfo]> {
  const [part, balances, recent] = await Promise.allSettled([
    getPart(partId),
    getBalancesForPart(partId),
    getRecentNoPoReceipts(partId, 14),
  ]);
  const value = part.status === 'fulfilled' ? part.value : null;
  return [
    partId,
    {
      lotTracked: value ? Boolean(value.lot_tracked) : null,
      partName: value?.part_name ?? fallbackName,
      balances: balances.status === 'fulfilled' ? balances.value : [],
      recentNoPo: recent.status === 'fulfilled' ? recent.value : [],
    },
  ];
}

/** The line's FROZEN conversion — what the database will use — never the part's current one. */
function lineBasis(line: VendorPoLine): PurchaseUnitBasis | null {
  if (line.lineKind !== 'part' || !line.stockUnit || line.stockFactor === null) return null;
  if (line.stockFactor === 1) return { kind: 'same', unit: line.unit, stockUnit: line.stockUnit, factor: 1 };
  return { kind: 'converted', unit: line.unit, stockUnit: line.stockUnit, factor: line.stockFactor, source: 'conversion' };
}

function toReceiptLine(line: VendorPoLine, poClosed: boolean): ReceiptLine {
  return {
    lineId: line.id,
    lineNumber: line.lineNumber,
    lineKind: line.lineKind,
    orderedQuantity: line.quantity,
    unit: line.unit,
    stockUnit: line.stockUnit,
    stockFactor: line.stockFactor,
    receivedStockQuantity: line.receivedStockQuantity ?? 0,
    receivedQuantity: line.receivedQuantity,
    closed: poClosed || line.closedAt !== null,
    jobNumber: line.jobNumber,
  };
}

function shortDate(instant: string): string {
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

interface Outcome {
  result: VendorPoReceiveResult;
  failedLots: LandedLot[];
}

function ReceiveBody({
  companyId,
  po,
  onClose,
  onReceived,
  onReceiveOutside,
  onBusyChange,
}: ReceiveVendorPoDialogProps & { onBusyChange: (busy: boolean) => void }) {
  const header = po.header;
  const [today] = useState(() => todayLocalISODate());
  // Minted ONCE for this opening; kept for every retry; replaced only after a success.
  const [groupId, setGroupId] = useState(() => newVendorPoReceiptGroupId());

  const poClosed = header.closedAt !== null || po.summary.status === 'closed';
  const receivable = useMemo(
    () => po.lines.filter((l) => l.lineKind !== 'outside_service' && l.expectsReceipt && l.closedAt === null && !poClosed),
    [po.lines, poClosed],
  );
  const outsideLines = po.lines.filter((l) => l.lineKind === 'outside_service' && l.closedAt === null);
  const receiptLines = useMemo(() => receivable.map((l) => toReceiptLine(l, poClosed)), [receivable, poClosed]);
  const lineById = useMemo(() => new Map(receivable.map((l) => [l.id, l])), [receivable]);

  const [rows, setRows] = useState<ReceiptRow[]>(() => prefillVendorPoReceiptRows(receiptLines));
  // The lines this delivery started with: a fully received line gets no row and is not shown.
  const [shownLineIds] = useState(() => [...new Set(rows.map((r) => r.lineId))]);
  // Rows whose place the person chose (or cleared) themselves: the default never overrides them.
  const [placeTouched, setPlaceTouched] = useState<Set<string>>(() => new Set());
  const [certs, setCerts] = useState<Record<string, File | null>>({});
  const [closeRemaining, setCloseRemaining] = useState<Set<string>>(() => new Set());
  const [receivedOn, setReceivedOn] = useState(today);
  const [packingSlip, setPackingSlip] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDraft, setConfirmDraft] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const rowSeq = useRef(0);
  // Whether THIS opening marked the PO sent — kept across a failed receive and its retry.
  const markedSentHere = useRef(false);
  const [markedSent, setMarkedSent] = useState(false);

  const isDraft = header.issuedAt === null && !markedSent;

  const partLines = receivable.filter((l) => l.lineKind === 'part' && l.partId);
  const partIds = [...new Set(partLines.map((l) => l.partId as string))];
  const partKey = partIds.join(',');
  const locationsLoad = useLoad(() => getLocations(companyId), [companyId]);
  const partInfoLoad = useLoad(
    async () =>
      new Map(
        await Promise.all(
          partIds.map((id) => loadPartInfo(id, partLines.find((l) => l.partId === id)?.partName ?? 'This part')),
        ),
      ),
    [partKey],
  );
  const partInfo = partInfoLoad.data;

  /** Where a row goes by default: the largest holding, else where this PO last put the part. */
  const defaultPlace = (line: VendorPoLine): string | null => {
    if (!line.partId) return null;
    const info = partInfo?.get(line.partId);
    const holdings = (info?.balances ?? [])
      .filter((b) => b.kind !== 'system')
      .map((b) => ({ locationId: b.location_id, quantity: Number(b.quantity) }));
    const last = po.receipts.find((r) => r.partId === line.partId && r.voidedAt === null && r.locationId)?.locationId ?? null;
    return defaultReceiptLocationId({ holdings, lastReceiptLocationId: last });
  };

  // The rows as they will be planned: an untouched part row takes its default place.
  const effectiveRows: ReceiptRow[] = rows.map((row) => {
    const line = lineById.get(row.lineId);
    if (!line || line.lineKind !== 'part' || row.locationId || placeTouched.has(row.rowKey)) return row;
    return { ...row, locationId: defaultPlace(line) };
  });
  const plan = planVendorPoReceipt(receiptLines, effectiveRows, { closeRemainingLineIds: closeRemaining });
  const problemFor = (rowKey: string, field: 'quantity' | 'location') =>
    plan.problems.find((p) => p.rowKey === rowKey && p.field === field)?.message ?? null;
  const notice = [
    ...new Set(
      plan.problems.map((p) => {
        const row = rows.find((r) => r.rowKey === p.rowKey);
        const number = row ? lineById.get(row.lineId)?.lineNumber : undefined;
        return number !== undefined ? `Line ${number}: ${p.message}` : p.message;
      }),
    ),
  ];

  const updateRow = (rowKey: string, patch: Partial<ReceiptRow>) =>
    setRows((current) => current.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));

  const addRow = (line: VendorPoLine) => {
    rowSeq.current += 1;
    setRows((current) => {
      const at = current.map((r) => r.lineId).lastIndexOf(line.id);
      const row: ReceiptRow = {
        rowKey: `${line.id}:${rowSeq.current}`,
        lineId: line.id,
        quantity: '',
        quantityUnit: 'purchase',
        locationId: null,
        heatNumber: '',
        lotId: null,
        notes: '',
      };
      return [...current.slice(0, at + 1), row, ...current.slice(at + 1)];
    });
  };

  const removeRow = (rowKey: string) => setRows((current) => current.filter((r) => r.rowKey !== rowKey));

  /** Switch a row between the purchase and the stock unit, keeping the same amount. */
  const switchUnit = (row: ReceiptRow, line: VendorPoLine, next: ReceiptQuantityUnit) => {
    if (next === row.quantityUnit || !line.stockFactor) return;
    const n = Number(row.quantity);
    let quantity = row.quantity;
    if (row.quantity.trim() !== '' && Number.isFinite(n)) {
      quantity = String(next === 'stock' ? toStockQuantity(n, line.stockFactor) : toPurchaseQuantity(n, line.stockFactor));
    }
    updateRow(row.rowKey, { quantityUnit: next, quantity });
  };

  const receivedAt = (): string | null => {
    if (!receivedOn || receivedOn === today) return null; // now, by the server's clock
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(receivedOn);
    // Midday on the chosen day, so no timezone can move it to the day before.
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toISOString() : null;
  };

  const record = async () => {
    if (!plan.ok) return;
    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    let wrote = false;
    try {
      if (header.issuedAt === null && !markedSentHere.current) {
        await markVendorPoSent(header.id, today);
        markedSentHere.current = true;
        setMarkedSent(true);
        wrote = true;
      }
      const result = await receiveVendorPo(header.id, {
        receiptGroupId: groupId,
        entries: plan.entries,
        receivedAt: receivedAt(),
        vendorPackingSlip: packingSlip,
        notes: note,
      });
      wrote = true;

      // Entry i is the i-th row that carried a quantity: the plan drops cleared rows and keeps order.
      const submitted = effectiveRows.filter((r) => r.quantity.trim() !== '');
      const linesReceived = new Set(plan.entries.map((e) => e.line_id));
      const perLine = new Map<string, number>();
      for (const e of plan.entries) perLine.set(e.line_id, (perLine.get(e.line_id) ?? 0) + 1);
      const stagedCerts = submitted.filter((r) => certs[r.rowKey]);
      posthog.capture('vendor po received', {
        line_count: linesReceived.size,
        entry_count: plan.entries.length,
        split_line_count: [...perLine.values()].filter((n) => n > 1).length,
        closed_remaining_count: new Set(plan.entries.filter((e) => e.close_remaining).map((e) => e.line_id)).size,
        over_received: plan.lines.some((l) => l.overQuantity > 0),
        has_heat: plan.entries.some((e) => Boolean(e.heat_number)),
        has_packing_slip: packingSlip.trim() !== '',
        cert_count: stagedCerts.length,
        marked_sent_first: markedSentHere.current,
        is_complete: result.status === 'received',
      });

      // Certificates, AFTER the write, against the lots it says landed.
      const failedLots: LandedLot[] = [];
      for (const [index, row] of submitted.entries()) {
        const file = certs[row.rowKey];
        if (!file) continue;
        const landed = result.landedLots.find((l) => l.entryIndex === index);
        if (!landed) continue;
        const line = lineById.get(row.lineId);
        const lot: LandedLot = {
          lotId: landed.lotId,
          partName: line?.partName ?? line?.description ?? 'Part',
          heatLabel: landed.heatNumber ? `Heat ${landed.heatNumber}` : null,
        };
        try {
          await uploadLotCertificate(companyId, landed.lotId, file);
          const fileProps = certificateUploadProperties(file);
          posthog.capture('lot certificate uploaded', {
            surface: 'office_po_receipt',
            at_receipt: true,
            file_kind: fileProps.file_kind,
            size_bucket: fileProps.size_bucket,
            is_replacement: false,
          });
        } catch {
          posthog.capture('lot certificate upload failed', {
            surface: 'office_po_receipt',
            reason: 'failed',
            attempt: 1,
          });
          failedLots.push(lot);
        }
      }

      setGroupId(newVendorPoReceiptGroupId());
      setOutcome({ result, failedLots });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
      onBusyChange(false);
      if (wrote) onReceived();
    }
  };

  const handleRecord = () => {
    if (!plan.ok) return;
    if (isDraft) setConfirmDraft(true);
    else void record();
  };

  // ---------------------------------------------------------------------------------------------
  // After the write: what landed, and the certs that still need a home
  // ---------------------------------------------------------------------------------------------
  if (outcome) {
    const { result, failedLots } = outcome;
    return (
      <>
        <DialogContent dividers>
          <Alert severity="success" sx={{ mb: 2 }}>
            Recorded against {header.poNumber}.
            {result.status === 'received' ? ` ${header.poNumber} is fully received.` : ''}
          </Alert>
          <Stack spacing={0.5} sx={{ mb: failedLots.length ? 2 : 0 }}>
            {result.receipts.map((r) => (
              <Typography key={r.receiptId} variant="body2">
                Line {r.lineNumber ?? '—'}: {formatUnitQuantity(r.quantity)} {unitLabel(r.unit)}
                {r.locationName ? ` into ${r.locationName}` : ''}
                {r.heatNumber ? ` · heat ${r.heatNumber}` : ''}
                {r.overReceived ? ' · more than ordered' : ''}
              </Typography>
            ))}
            {result.closedLineIds.map((id) => (
              <Typography key={id} variant="body2" color="text.secondary">
                Line {po.lines.find((l) => l.id === id)?.lineNumber ?? '—'} closed — nothing more expected.
              </Typography>
            ))}
          </Stack>
          {failedLots.length > 0 && (
            <CertAfterBatchPanel companyId={companyId} lots={failedLots} surface="office_po_receipt" onDone={onClose} />
          )}
        </DialogContent>
        {failedLots.length === 0 && (
          <DialogActions>
            <Button variant="contained" onClick={onClose} autoFocus>
              Done
            </Button>
          </DialogActions>
        )}
      </>
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The form
  // ---------------------------------------------------------------------------------------------
  const locations = locationsLoad.data;
  const shownLines = shownLineIds.map((id) => lineById.get(id)).filter((l): l is VendorPoLine => Boolean(l));
  const needsPlaces = shownLines.some((l) => l.lineKind === 'part');

  return (
    <>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 2fr' }, gap: 2 }}>
            <TextField
              label="Received on"
              type="date"
              size="small"
              value={receivedOn}
              onChange={(e) => setReceivedOn(e.target.value)}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today } }}
            />
            <TextField
              label="Vendor packing slip #"
              size="small"
              value={packingSlip}
              onChange={(e) => setPackingSlip(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 64 } }}
            />
            <TextField
              label="Note"
              size="small"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 2000 } }}
            />
          </Box>

          {isDraft && (
            <Alert severity="info">
              {header.poNumber} was never marked as sent. Recording this delivery marks it sent today.
            </Alert>
          )}

          {partIds.map((id) => {
            const info = partInfo?.get(id);
            if (!info || info.recentNoPo.length === 0) return null;
            return (
              <Alert key={id} severity="info">
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {info.partName}: stock was added without a PO lately — was that this delivery?
                </Typography>
                {info.recentNoPo.slice(0, 3).map((a) => (
                  <Typography key={a.transactionId} variant="body2">
                    {formatUnitQuantity(a.quantity)} {unitLabel(a.unit)}
                    {a.locationName ? ` into ${a.locationName}` : ''} on {shortDate(a.createdAt)}
                  </Typography>
                ))}
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                  Receiving it here adds it again.
                </Typography>
              </Alert>
            );
          })}

          {needsPlaces && locationsLoad.error != null && !locations && (
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <LoadFailedState error={locationsLoad.error} entity="your storage places" onRetry={() => void locationsLoad.reload()} />
            </Box>
          )}

          {shownLines.length === 0 && outsideLines.length === 0 && (
            <Typography color="text.secondary">Nothing is left to receive on {header.poNumber}.</Typography>
          )}

          {shownLines.map((line) => {
            const lineRows = rows.filter((r) => r.lineId === line.id);
            const summary = plan.lines.find((s) => s.lineId === line.id);
            const outstanding = receiptOutstanding(toReceiptLine(line, poClosed));
            const basis = lineBasis(line);
            const info = line.partId ? partInfo?.get(line.partId) : undefined;
            const options: LocationPickerOption[] =
              line.lineKind === 'part' && locations ? stockDestinationOptions(locations, { balances: info?.balances ?? [] }) : [];
            return (
              <Paper key={line.id} variant="outlined" sx={{ p: 2 }} data-testid={`receive-line-${line.id}`}>
                <Typography sx={{ fontWeight: 600 }}>
                  Line {line.lineNumber} · {line.description}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Ordered {formatUnitQuantity(line.quantity)} {unitLabel(line.unit)} · {formatUnitQuantity(outstanding.quantity)}{' '}
                  {unitLabel(line.unit)} to come
                </Typography>

                <Stack spacing={1.5}>
                  {lineRows.map((row, i) => {
                    const effective = effectiveRows.find((r) => r.rowKey === row.rowKey) ?? row;
                    const qty = Number(row.quantity);
                    const typed = row.quantity.trim() !== '' && Number.isFinite(qty);
                    let caption: string | null = null;
                    if (typed && basis?.kind === 'converted') {
                      caption =
                        row.quantityUnit === 'purchase'
                          ? `= ${formatUnitQuantity(toStockQuantity(qty, basis.factor))} ${unitLabel(basis.stockUnit)} into stock`
                          : `= ${formatUnitQuantity(toPurchaseQuantity(qty, basis.factor))} ${unitLabel(basis.unit)}`;
                    }
                    const heat = row.heatNumber ?? '';
                    const certBlocked = info?.lotTracked === false && heat.trim() === '';
                    const value = options.find((o) => o.id === effective.locationId) ?? null;
                    return (
                      <Box key={row.rowKey} sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <TextField
                          label="Quantity received"
                          size="small"
                          value={row.quantity}
                          onChange={(e) => updateRow(row.rowKey, { quantity: e.target.value })}
                          error={Boolean(problemFor(row.rowKey, 'quantity'))}
                          helperText={problemFor(row.rowKey, 'quantity') ?? caption ?? ' '}
                          sx={{ width: (theme) => theme.spacing(22) }}
                          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                        />
                        {basis?.kind === 'converted' && (
                          <TextField
                            select
                            label="Unit"
                            size="small"
                            value={row.quantityUnit}
                            onChange={(e) => switchUnit(row, line, e.target.value === 'stock' ? 'stock' : 'purchase')}
                            sx={{ width: (theme) => theme.spacing(14) }}
                          >
                            <MenuItem value="purchase">{unitLabel(basis.unit)}</MenuItem>
                            <MenuItem value="stock">{unitLabel(basis.stockUnit)}</MenuItem>
                          </TextField>
                        )}
                        {line.lineKind === 'part' && (
                          <>
                            <Box sx={{ flex: 1, minWidth: (theme) => theme.spacing(28) }}>
                              <LocationPicker
                                label="Where it goes"
                                options={options}
                                value={value}
                                onChange={(o) => {
                                  setPlaceTouched((s) => new Set(s).add(row.rowKey));
                                  updateRow(row.rowKey, { locationId: o?.id ?? null });
                                }}
                                unit={line.stockUnit ? unitLabel(line.stockUnit) : undefined}
                                required
                                size="small"
                                error={Boolean(problemFor(row.rowKey, 'location'))}
                                helperText={problemFor(row.rowKey, 'location') ?? undefined}
                              />
                            </Box>
                            <Box sx={{ width: (theme) => theme.spacing(26) }}>
                              <HeatNumberField
                                value={heat}
                                onChange={(v) => updateRow(row.rowKey, { heatNumber: v })}
                                size="small"
                              />
                              {info?.lotTracked === false && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                  {HEAT_STARTS_TRACKING_CAPTION}
                                </Typography>
                              )}
                            </Box>
                            <Box sx={{ width: (theme) => theme.spacing(30) }}>
                              <MillCertField
                                value={certs[row.rowKey] ?? null}
                                onChange={(f) => setCerts((c) => ({ ...c, [row.rowKey]: f }))}
                                disabled={certBlocked}
                              />
                              {certBlocked && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                  Enter the heat number to attach its mill cert.
                                </Typography>
                              )}
                            </Box>
                          </>
                        )}
                        {i > 0 && (
                          <DeleteIconButton ariaLabel={`Remove this row from line ${line.lineNumber}`} onClick={() => removeRow(row.rowKey)} />
                        )}
                      </Box>
                    );
                  })}
                </Stack>

                {line.lineKind === 'part' && (
                  <Button size="small" startIcon={<AddIcon />} onClick={() => addRow(line)} sx={{ mt: 1 }}>
                    Another heat or place
                  </Button>
                )}

                {summary?.overCaption && (
                  <Typography variant="body2" sx={{ color: 'warning.light', fontWeight: 600, mt: 1 }}>
                    {summary.overCaption}
                  </Typography>
                )}
                {summary?.shortCaption && (
                  <FormControlLabel
                    sx={{ mt: 0.5 }}
                    control={
                      <Checkbox
                        size="small"
                        checked={closeRemaining.has(line.id)}
                        onChange={(e) =>
                          setCloseRemaining((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(line.id);
                            else next.delete(line.id);
                            return next;
                          })
                        }
                      />
                    }
                    label={summary.shortCaption}
                  />
                )}
              </Paper>
            );
          })}

          {outsideLines.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Outside work comes back on its vendor packing slip
              </Typography>
              <Stack spacing={1}>
                {outsideLines.map((line) => (
                  <Paper
                    key={line.id}
                    variant="outlined"
                    sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
                    data-testid={`receive-outside-${line.id}`}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        Line {line.lineNumber} · {line.description}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatUnitQuantity(line.atVendorQuantity ?? 0)} at the vendor · {formatUnitQuantity(line.receivedQuantity)} back
                      </Typography>
                    </Box>
                    <Button variant="outlined" onClick={() => onReceiveOutside(line)}>
                      Receive on {line.jobNumber ?? 'the job'}
                    </Button>
                  </Paper>
                ))}
              </Stack>
            </Box>
          )}

          {error != null && <ErrorAlert error={error} entity="receipt" onClose={() => setError(null)} />}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
        {shownLines.length > 0 && <MissingFieldsNotice items={notice} />}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {shownLines.length > 0 && (
            <Button
              variant="contained"
              onClick={handleRecord}
              disabled={!plan.ok || submitting}
              startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {submitting ? 'Recording…' : 'Record receipt'}
            </Button>
          )}
        </Box>
      </DialogActions>

      <Dialog open={confirmDraft} onClose={() => setConfirmDraft(false)} aria-labelledby="receive-draft-confirm-title">
        <DialogTitle id="receive-draft-confirm-title">Mark it sent today and receive?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {header.poNumber} was never marked as sent to {header.vendorName}. A delivery can only be recorded against a
            sent PO, so this marks it sent today and then records what arrived.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDraft(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmDraft(false);
              void record();
            }}
          >
            Mark sent and receive
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
