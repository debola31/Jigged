'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import WhatshotIcon from '@mui/icons-material/Whatshot';

import {
  getOutsideOpsForCompany,
  markOperationSent,
  markOperationReceived,
} from '@/utils/operatorAccess';
import type { OutsideOperation } from '@/types/operator';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
  return new Date(value).toLocaleDateString();
}

function OutsideOpRow({
  op,
  companyId,
  busy,
  onSend,
  onReceive,
}: {
  op: OutsideOperation;
  companyId: string;
  busy: boolean;
  onSend: (op: OutsideOperation) => void;
  onReceive: (op: OutsideOperation) => void;
}) {
  const router = useRouter();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5, flexWrap: 'wrap' }}>
      <Box
        sx={{ flex: 1, minWidth: 240, cursor: 'pointer' }}
        onClick={() => router.push(`/dashboard/${companyId}/jobs/${op.job_id}`)}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body1" fontWeight={600}>
            {op.job_number}
          </Typography>
          {op.is_hot && <Chip size="small" color="error" icon={<WhatshotIcon />} label="HOT" />}
          <Typography variant="body2" color="text.secondary">
            {op.part_name || 'Part'}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {op.operation_name}
          {' → '}
          <Box component="span" sx={{ color: 'warning.main', fontWeight: 600 }}>
            {op.vendor_name || 'vendor'}
          </Box>
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {op.status === 'sent'
            ? `Sent ${formatDate(op.sent_at)}${op.sent_by_name ? ` by ${op.sent_by_name}` : ''}`
            : `Due ${formatDate(op.due_date)}`}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        {op.status === 'pending' && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            startIcon={<LocalShippingIcon />}
            disabled={busy}
            onClick={() => onSend(op)}
          >
            Mark Sent Out
          </Button>
        )}
        <Button
          size="small"
          variant="contained"
          color="success"
          startIcon={<Inventory2Icon />}
          disabled={busy}
          onClick={() => onReceive(op)}
        >
          Mark Received
        </Button>
      </Box>
    </Box>
  );
}

function QueueSection({
  title,
  icon,
  items,
  emptyText,
  companyId,
  busyId,
  onSend,
  onReceive,
}: {
  title: string;
  icon: React.ReactNode;
  items: OutsideOperation[];
  emptyText: string;
  companyId: string;
  busyId: string | null;
  onSend: (op: OutsideOperation) => void;
  onReceive: (op: OutsideOperation) => void;
}) {
  return (
    <Card elevation={2} sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          {icon}
          <Typography variant="h6" fontWeight={600}>
            {title} ({items.length})
          </Typography>
        </Box>
        <Divider sx={{ mb: 1 }} />
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1.5 }}>
            {emptyText}
          </Typography>
        ) : (
          items.map((op, i) => (
            <Box key={op.id}>
              {i > 0 && <Divider />}
              <OutsideOpRow
                op={op}
                companyId={companyId}
                busy={busyId === op.id}
                onSend={onSend}
                onReceive={onReceive}
              />
            </Box>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The company-wide "Outside work" queue — a purely informational worklist for
 * whoever ships parts out to vendors. Two sections: "Not sent" (parts still in
 * the shop, awaiting send) and "At vendor" (out for outside processing). No
 * readiness/predecessor logic — this surface informs, it does not gate. Backs
 * the "Outside work" tab on the Jobs list; replaces the hand-highlighted
 * traveler / paper slip the shipping lead used to work from.
 */
export default function OutsideWorkPanel({ companyId }: { companyId: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'info' | 'error';
  }>({ open: false, message: '', severity: 'success' });

  const { data, loading, reload } = useLoad(
    () => getOutsideOpsForCompany(companyId),
    [companyId],
  );
  const ops = data ?? [];
  const notSent = ops.filter((o) => o.status === 'pending');
  const atVendor = ops.filter((o) => o.status === 'sent');

  const runAction = async (
    op: OutsideOperation,
    action: (id: string) => Promise<unknown>,
    okMessage: string,
  ) => {
    setBusyId(op.id);
    try {
      await action(op.id);
      setSnackbar({ open: true, message: okMessage, severity: 'success' });
      await reload();
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Action failed',
        severity: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleSend = (op: OutsideOperation) => runAction(op, markOperationSent, 'Marked sent out.');
  const handleReceive = (op: OutsideOperation) =>
    runAction(op, markOperationReceived, 'Marked received.');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <QueueSection
        title="Not sent"
        icon={<LocalShippingIcon color="warning" />}
        items={notSent}
        emptyText="Nothing waiting to go out."
        companyId={companyId}
        busyId={busyId}
        onSend={handleSend}
        onReceive={handleReceive}
      />
      <QueueSection
        title="At vendor"
        icon={<Inventory2Icon color="warning" />}
        items={atVendor}
        emptyText="Nothing is out at a vendor right now."
        companyId={companyId}
        busyId={busyId}
        onSend={handleSend}
        onReceive={handleReceive}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((p) => ({ ...p, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar((p) => ({ ...p, open: false }))}
          severity={snackbar.severity}
          variant="filled"
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
