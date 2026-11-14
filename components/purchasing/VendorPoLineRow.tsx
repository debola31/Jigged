'use client';

import Link from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import DeleteIconButton from '@/components/common/DeleteIconButton';
import JobTagPicker from '@/components/inventory/JobTagPicker';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import MachinePicker from '@/components/purchasing/MachinePicker';
import OutsideOpPicker from '@/components/purchasing/OutsideOpPicker';
import PriceSourceCaption from '@/components/purchasing/PriceSourceCaption';
import PurchaseUnitField from '@/components/purchasing/PurchaseUnitField';
import { formatVendorPoAmount } from '@/lib/purchasing/amount';
import { stockEquivalentLabel, resolvePurchaseUnit, unitLabel, type UnitConversionRow } from '@/lib/purchasing/purchaseUnits';
import type { PartVendorLineNotice } from '@/lib/purchasing/priceDefault';
import type { JobWithRelations } from '@/types/job';
import type { OpenOutsideOperation, VendorPoLine, VendorPoLineKind, VendorPoPriceSource } from '@/types/vendorPo';

/** One line as the form holds it. Saved lines carry `saved`; new ones do not. */
export interface FormLine {
  key: string;
  id: string | null;
  lineKind: VendorPoLineKind;
  part: PartSelectOption | null;
  jobOperationId: string | null;
  jobId: string | null;
  jobNumber: string | null;
  jobPartId: string | null;
  workCenterId: string | null;
  description: string;
  descriptionTouched: boolean;
  vendorPartNumber: string;
  vendorPartNumberTouched: boolean;
  quantity: string;
  unit: string;
  unitTouched: boolean;
  /** "Another unit…": stock units in one `unit`, as typed. */
  unitFactor: string;
  unitPrice: string;
  priceTouched: boolean;
  needByOn: string;
  certRequired: boolean;
  expectsReceipt: boolean;
  /** The line as last saved — its receipts, its fixed step. */
  saved: VendorPoLine | null;
}

/** What the form works out for one line each render: defaults, captions, problems. */
export interface LineView {
  unit: string;
  stockUnit: string | null;
  conversions: UnitConversionRow[];
  unitPrice: string;
  priceSource: VendorPoPriceSource | null;
  caption: string;
  warnings: string[];
  vendorPartNumber: string;
  description: string;
  notice: PartVendorLineNotice | null;
  op: OpenOutsideOperation | null;
  /** An Other line naming a job with outside work at this vendor (plan §3.6 "Leak guard"). */
  leak: OpenOutsideOperation | null;
  amount: number | null;
  quantityError: string | null;
  priceError: string | null;
  /** Sentences for the notice, without the "Line N:" lead. */
  problems: string[];
  /** A new or changed line on an edit (the ladder's amber). */
  changed: boolean;
}

export interface VendorPoLineRowProps {
  companyId: string;
  position: number;
  displayNumber: number;
  line: FormLine;
  view: LineView;
  vendorName: string | null;
  hasVendor: boolean;
  jobs: JobWithRelations[];
  jobsLoading: boolean;
  outsideOps: OpenOutsideOperation[] | null;
  outsideOpsError: unknown;
  onRetryOutsideOps: () => void;
  /** Steps other lines on this form already pay for. */
  takenOps: string[];
  onChange: (patch: Partial<FormLine>) => void;
  onPickOp: (op: OpenOutsideOperation | null) => void;
  onRemove: () => void;
  /** Replace this (new) Other line with an Outside service line for the step. */
  onUseOutsideLine: (op: OpenOutsideOperation) => void;
  disabled?: boolean;
}

const KIND_LABEL: Record<VendorPoLineKind, string> = {
  part: 'Part',
  outside_service: 'Outside service',
  other: 'Other',
};

/**
 * One line of the PO form: a bordered card, coloured on the row status ladder
 * (interaction-standards.md) — red when something blocks the save, amber when it is a new or changed
 * line on a saved PO, plain otherwise. Fields by kind:
 *
 *   - Part — the part, its description, the vendor's part number, quantity in a purchase unit, the
 *     price with where it came from, the due date, certs, an optional job, and the approved-vendor
 *     note (a quiet caption, amber for Conditional, blocked for Do not use).
 *   - Outside service — the routing step it pays for (fixed once saved), in pieces.
 *   - Other — a description, a free unit, an optional machine and job, and "no delivery" for a
 *     fee or freight.
 *
 * A line with receipts keeps its part and unit, and says why; it cannot be removed — close it short
 * on the PO page. Removing any other line is staged until Save, so it asks nothing.
 */
export default function VendorPoLineRow({
  companyId,
  position,
  displayNumber,
  line,
  view,
  vendorName,
  hasVendor,
  jobs,
  jobsLoading,
  outsideOps,
  outsideOpsError,
  onRetryOutsideOps,
  takenOps,
  onChange,
  onPickOp,
  onRemove,
  onUseOutsideLine,
  disabled = false,
}: VendorPoLineRowProps) {
  const saved = line.saved;
  const received = saved?.hasLiveReceipts ?? false;
  const lockedReason = received ? "Received already — its part and unit can't change." : null;
  const removable = saved ? saved.removable : true;
  const broken = view.problems.length > 0;
  const qty = Number(line.quantity);
  const job = jobs.find((j) => j.id === line.jobId) ?? null;
  const basis = view.stockUnit ? resolvePurchaseUnit(view.unit, view.stockUnit, view.conversions) : null;
  const stockCaption = basis && Number.isFinite(qty) && line.quantity.trim() !== '' ? stockEquivalentLabel(qty, basis) : null;
  const leak = view.leak;

  const quantityField = (
    <TextField
      label="Quantity"
      size="small"
      value={line.quantity}
      onChange={(e) => onChange({ quantity: e.target.value })}
      error={Boolean(view.quantityError)}
      helperText={view.quantityError ?? stockCaption ?? ' '}
      disabled={disabled}
      sx={{ width: (theme) => theme.spacing(18) }}
      slotProps={{ htmlInput: { inputMode: 'decimal' } }}
    />
  );

  const priceField = (
    <Box sx={{ width: (theme) => theme.spacing(26) }}>
      <TextField
        label="Unit price"
        size="small"
        value={view.unitPrice}
        onChange={(e) => onChange({ unitPrice: e.target.value, priceTouched: true })}
        error={Boolean(view.priceError)}
        helperText={view.priceError ?? undefined}
        disabled={disabled}
        fullWidth
        slotProps={{ htmlInput: { inputMode: 'decimal' }, input: { startAdornment: <Box component="span" sx={{ mr: 0.5, color: 'text.secondary' }}>$</Box> } }}
      />
      <PriceSourceCaption caption={view.caption} warnings={view.warnings} />
    </Box>
  );

  const needByField = (
    <TextField
      label="Need by"
      type="date"
      size="small"
      value={line.needByOn}
      onChange={(e) => onChange({ needByOn: e.target.value })}
      disabled={disabled}
      slotProps={{ inputLabel: { shrink: true } }}
      sx={{ width: (theme) => theme.spacing(21) }}
    />
  );

  const certField = (
    <FormControlLabel
      control={<Checkbox size="small" checked={line.certRequired} onChange={(e) => onChange({ certRequired: e.target.checked })} disabled={disabled} />}
      label="Certs required"
    />
  );

  const jobField = (
    <Box sx={{ minWidth: (theme) => theme.spacing(28) }}>
      <JobTagPicker
        jobs={jobs}
        loading={jobsLoading}
        value={job}
        onChange={(j) => onChange({ jobId: j?.id ?? null, jobNumber: j?.job_number ?? null, jobPartId: null })}
        label="For job (optional)"
      />
    </Box>
  );

  return (
    <Paper
      variant="outlined"
      data-testid={`po-form-line-${position}`}
      sx={{
        p: 2,
        borderColor: broken ? 'error.main' : view.changed ? 'warning.main' : 'divider',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Typography sx={{ fontWeight: 600 }}>
          Line {displayNumber} · {KIND_LABEL[line.lineKind]}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {removable ? (
          <DeleteIconButton ariaLabel={`Remove line ${displayNumber}`} onClick={onRemove} disabled={disabled} />
        ) : (
          <Typography variant="caption" color="text.secondary">
            Has receipts — close it short on the PO page instead of removing it.
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {line.lineKind === 'part' && (
          <>
            <Box sx={{ flex: 2, minWidth: (theme) => theme.spacing(32) }}>
              <PartAutocomplete
                companyId={companyId}
                value={line.part}
                onChange={(p) =>
                  onChange({
                    part: p,
                    // A new part starts from its own defaults again.
                    unit: '',
                    unitTouched: false,
                    unitFactor: '',
                    priceTouched: false,
                    vendorPartNumberTouched: false,
                    descriptionTouched: false,
                  })
                }
                label="Part"
                disabled={disabled || received}
                helperText={lockedReason ?? (hasVendor ? undefined : 'Choose the vendor to see prices.')}
              />
            </Box>
            <TextField
              label="Description"
              size="small"
              value={view.description}
              onChange={(e) => onChange({ description: e.target.value, descriptionTouched: true })}
              disabled={disabled}
              sx={{ flex: 2, minWidth: (theme) => theme.spacing(28) }}
            />
            <TextField
              label="Vendor part #"
              size="small"
              value={view.vendorPartNumber}
              onChange={(e) => onChange({ vendorPartNumber: e.target.value, vendorPartNumberTouched: true })}
              disabled={disabled}
              sx={{ width: (theme) => theme.spacing(22) }}
            />
          </>
        )}

        {line.lineKind === 'outside_service' &&
          (saved ? (
            <Typography variant="body2" sx={{ flexBasis: '100%' }}>
              Pays for {saved.description}
            </Typography>
          ) : (
            <Box sx={{ flexBasis: '100%' }}>
              <OutsideOpPicker
                ops={hasVendor ? outsideOps : []}
                error={outsideOpsError}
                onRetry={onRetryOutsideOps}
                vendorName={vendorName}
                value={line.jobOperationId}
                onChange={onPickOp}
                takenHere={takenOps}
                disabled={disabled || !hasVendor}
              />
              {view.op && (
                <Typography variant="body2" sx={{ mt: 1 }}>
                  Pays for {view.description}
                </Typography>
              )}
            </Box>
          ))}

        {line.lineKind === 'other' && (
          <TextField
            label="Description"
            size="small"
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value, descriptionTouched: true })}
            disabled={disabled}
            required
            sx={{ flex: 2, minWidth: (theme) => theme.spacing(32) }}
          />
        )}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start', mt: 2 }}>
        {quantityField}
        {line.lineKind === 'part' && (
          <PurchaseUnitField
            stockUnit={view.stockUnit}
            conversions={view.conversions}
            value={view.unit}
            factor={line.unitFactor}
            onChange={(next) => onChange({ unit: next.unit, unitFactor: next.factor, unitTouched: true })}
            disabled={disabled || received}
            disabledReason={lockedReason}
          />
        )}
        {line.lineKind === 'outside_service' && (
          <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>
            {view.unit ? `${unitLabel(view.unit)} (pieces of the part)` : 'pieces'}
          </Typography>
        )}
        {line.lineKind === 'other' && (
          <TextField
            label="Unit"
            size="small"
            value={line.unit}
            onChange={(e) => onChange({ unit: e.target.value, unitTouched: true })}
            disabled={disabled}
            sx={{ width: (theme) => theme.spacing(14) }}
            slotProps={{ htmlInput: { maxLength: 40 } }}
          />
        )}
        {priceField}
        {needByField}
        <Box sx={{ alignSelf: 'center', ml: 'auto', textAlign: 'right' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Amount
          </Typography>
          <Typography sx={{ fontWeight: 600 }}>{formatVendorPoAmount(view.amount)}</Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mt: 1 }}>
        {line.lineKind !== 'outside_service' && jobField}
        {line.lineKind === 'other' && (
          <Box sx={{ minWidth: (theme) => theme.spacing(28) }}>
            <MachinePicker companyId={companyId} value={line.workCenterId} onChange={(id) => onChange({ workCenterId: id })} disabled={disabled} />
          </Box>
        )}
        {certField}
        {line.lineKind === 'other' && (
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={!line.expectsReceipt}
                onChange={(e) => onChange({ expectsReceipt: !e.target.checked })}
                disabled={disabled || (saved?.hasLiveReceipts ?? false)}
              />
            }
            label="No delivery (a fee or freight)"
          />
        )}
      </Box>

      {view.notice && (
        <Box sx={{ mt: 1 }}>
          {view.notice.tone === 'quiet' ? (
            <Typography variant="body2" color="text.secondary">
              {view.notice.text}{' '}
              {view.notice.action === 'add_to_list' && line.part && (
                <MuiLink component={Link} href={`/dashboard/${companyId}/parts/${line.part.id}?tab=buying`} target="_blank" rel="noopener">
                  Add to list
                </MuiLink>
              )}
            </Typography>
          ) : (
            <Typography variant="body2" sx={{ color: view.notice.tone === 'blocked' ? 'error.light' : 'warning.light', fontWeight: 600 }}>
              {view.notice.text}
            </Typography>
          )}
        </Box>
      )}

      {leak && (
        <Alert
          severity="warning"
          sx={{ mt: 1.5 }}
          action={
            !saved ? (
              <Button color="inherit" size="small" onClick={() => onUseOutsideLine(leak)}>
                Use an outside line
              </Button>
            ) : undefined
          }
        >
          {leak.jobNumber} has outside work at {vendorName ?? 'this vendor'} ({leak.serviceName}). Use an Outside service line
          so it follows the vendor slips — an Other line would be received twice.
        </Alert>
      )}
    </Paper>
  );
}
