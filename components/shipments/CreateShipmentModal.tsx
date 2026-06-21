'use client';

import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';

import ShipmentForm from '@/components/shipments/ShipmentForm';

export interface CreateShipmentModalProps {
  open: boolean;
  jobId: string;
  companyId: string;
  onClose: () => void;
  /**
   * Fired after the RPC commits. The `pdfError` slot is preserved so the
   * existing callers on the job detail page can keep their PDF-gen
   * post-step contract unchanged when ShipmentForm started routing
   * createShipment results through here.
   */
  onCreated: (result: {
    shipmentId: string;
    packingSlipNumber: string;
    pdfError?: Error | null;
  }) => void | Promise<void>;
}

/**
 * Job-detail entry point for shipment creation — the single way to create
 * a shipment now that a packing slip belongs to one job. Thin wrapper
 * around ShipmentForm running in `job` mode.
 */
export default function CreateShipmentModal({
  open,
  jobId,
  companyId,
  onClose,
  onCreated,
}: CreateShipmentModalProps) {
  if (!open) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Create Shipment</DialogTitle>
      <DialogContent dividers>
        <ShipmentForm
          source={{ kind: 'job', jobId }}
          companyId={companyId}
          onCreated={async (result) => {
            await onCreated({ ...result, pdfError: null });
          }}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
