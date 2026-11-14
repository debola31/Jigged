'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';

import { formatUnitQuantity } from '@/lib/purchasing/purchaseUnits';
import type { OpenOutsideOperation } from '@/types/vendorPo';

export interface OutsideOpPickerProps {
  /** This vendor's open outside steps; `null` while they load. */
  ops: OpenOutsideOperation[] | null;
  /** The read failed: said, with Retry — never shown as "nothing to send". */
  error: unknown;
  onRetry: () => void;
  vendorName: string | null;
  value: string | null;
  onChange: (op: OpenOutsideOperation | null) => void;
  /** Steps another line on THIS form already pays for. */
  takenHere?: readonly string[];
  disabled?: boolean;
}

/** "J-1042 · 1234-A · Anodize · 50 left to send". */
export function outsideOpLabel(op: OpenOutsideOperation): string {
  return `${op.jobNumber} · ${op.partName} · ${op.serviceName} · ${formatUnitQuantity(op.leftToSendQuantity)} left to send`;
}

/**
 * Which outside step an Outside service line pays for (plan §3.6): one of THIS vendor's unfinished
 * steps on a live job. A step another open PO line already pays for is shown and not pickable —
 * the database allows one open outside line per (step, vendor), and the caption says where it is.
 */
export default function OutsideOpPicker({
  ops,
  error,
  onRetry,
  vendorName,
  value,
  onChange,
  takenHere = [],
  disabled = false,
}: OutsideOpPickerProps) {
  if (error != null && !ops) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <TextField select label="Outside step" size="small" value="" disabled error helperText={"Couldn't load this vendor's outside steps."} sx={{ minWidth: (theme) => theme.spacing(40) }}>
          <MenuItem value="">—</MenuItem>
        </TextField>
        <Button size="small" onClick={onRetry}>
          Try again
        </Button>
      </Box>
    );
  }

  const list = ops ?? [];
  const helper =
    ops === null
      ? 'Loading this vendor’s outside steps…'
      : list.length === 0
        ? `${vendorName ?? 'This vendor'} has no outside steps waiting on an open job.`
        : 'Quantity starts at what is left to send; due back comes from the slips.';

  return (
    <TextField
      select
      label="Outside step"
      size="small"
      value={value ?? ''}
      disabled={disabled || ops === null}
      onChange={(e) => onChange(list.find((o) => o.jobOperationId === e.target.value) ?? null)}
      helperText={helper}
      sx={{ minWidth: (theme) => theme.spacing(40) }}
      fullWidth
    >
      <MenuItem value="" disabled>
        Choose the step
      </MenuItem>
      {list.map((op) => {
        const elsewhere = op.openLine !== null;
        const here = takenHere.includes(op.jobOperationId) && op.jobOperationId !== value;
        return (
          <MenuItem key={op.jobOperationId} value={op.jobOperationId} disabled={elsewhere || here}>
            {outsideOpLabel(op)}
            {elsewhere && op.openLine ? ` — on ${op.openLine.poNumber} line ${op.openLine.lineNumber}` : ''}
            {here ? ' — already on this PO' : ''}
          </MenuItem>
        );
      })}
    </TextField>
  );
}
