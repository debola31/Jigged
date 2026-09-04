'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import PrintIcon from '@mui/icons-material/Print';
import posthog from 'posthog-js';

import type { jsPDF } from 'jspdf';
import { getSupabase } from '@/lib/supabase';
import type { Company } from '@/utils/companyAccess';
import {
  generateOutsideShipmentPdf,
  outsideShipmentPdfFilename,
} from '@/utils/outsideShipmentPdf';
import {
  getOutsideShipmentById,
  getSentBeforeShipment,
  outstandingOn,
  voidOutsideShipment,
} from '@/utils/outsideShipmentsAccess';

export interface OutsideShipmentPreviewDialogProps {
  open: boolean;
  shipmentId: string | null;
  onClose: () => void;
  /**
   * Fired after the slip is voided so the caller can re-pull the operation.
   * When omitted the Void action is HIDDEN — read-only reprint surfaces (the
   * cross-job register) pass nothing.
   */
  onVoided?: () => void;
}

/**
 * Reprintable preview of one outside-processing slip.
 *
 * VOID LIVES HERE AND NOWHERE ELSE, which is what keeps a cross-job register
 * from becoming a second place to act on an operation — the liability that got
 * the outside-work tab deleted in Aug 2026. Voiding a slip is the document's own
 * lifecycle, and you can only do it once the document is on screen, exactly
 * where the customer packing slip puts it.
 *
 * Nothing is written by rendering, so re-opening is always safe.
 */
export default function OutsideShipmentPreviewDialog({
  open,
  shipmentId,
  onClose,
  onVoided,
}: OutsideShipmentPreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slipNumber, setSlipNumber] = useState<string>('');
  const [vendorName, setVendorName] = useState<string>('');
  const [voidedAt, setVoidedAt] = useState<string | null>(null);
  const [hasReceipt, setHasReceipt] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const docRef = useRef<jsPDF | null>(null);
  const filenameRef = useRef<string>('outside-processing.pdf');

  const canVoid = !!onVoided && !!shipmentId && !voidedAt;

  const handleVoidConfirm = useCallback(async () => {
    if (!shipmentId) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await voidOutsideShipment(shipmentId);
      posthog.capture('outside shipment voided', {
        surface: 'office',
        was_received: hasReceipt,
      });
      setConfirmVoid(false);
      onVoided?.();
      onClose();
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'Failed to void the slip.');
    } finally {
      setVoiding(false);
    }
  }, [shipmentId, hasReceipt, onVoided, onClose]);

  useEffect(() => {
    if (!open || !shipmentId) return;

    let revoked: string | null = null;
    let cancelled = false;

    (async () => {
      setError(null);
      setPdfUrl(null);
      setVoidedAt(null);
      setConfirmVoid(false);
      setVoidError(null);
      try {
        const supabase = getSupabase();
        const shipment = await getOutsideShipmentById(shipmentId);

        // Independent: the shop's letterhead, and what went out on the slips
        // issued BEFORE this one (which the Prev Sent column states).
        const [companyRes, sentBefore] = await Promise.all([
          supabase
            .from('companies')
            .select(
              'id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website, settings',
            )
            .eq('id', shipment.company_id)
            .single(),
          getSentBeforeShipment(shipment),
        ]);
        if (companyRes.error || !companyRes.data) {
          throw new Error(companyRes.error?.message ?? 'Failed to load company.');
        }

        const doc = await generateOutsideShipmentPdf({
          shipment,
          company: companyRes.data as unknown as Company,
          sentBefore,
          supabase,
        });
        if (cancelled) return;

        docRef.current = doc;
        filenameRef.current = outsideShipmentPdfFilename(shipment);
        const url = doc.output('bloburl') as unknown as string;
        revoked = url;
        setPdfUrl(url);
        setSlipNumber(shipment.slip_number);
        setVendorName(shipment.vendor_name);
        setVoidedAt(shipment.voided_at ?? null);
        setHasReceipt(outstandingOn(shipment) < Number(shipment.quantity));
      } catch (err) {
        if (cancelled) return;
        console.error('OutsideShipmentPreviewDialog render failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to generate the slip.');
      }
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      docRef.current = null;
    };
  }, [open, shipmentId]);

  const handleDownload = () => {
    docRef.current?.save(filenameRef.current);
  };

  const handlePrint = () => {
    if (!pdfUrl) return;
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.src = pdfUrl;
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        window.open(pdfUrl, '_blank');
      }
    };
    document.body.appendChild(iframe);
    // Not removed — Chrome cancels the print job if the frame goes away.
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Outside processing{slipNumber ? ` — ${slipNumber}` : ''}
        <IconButton
          aria-label="Close preview"
          onClick={onClose}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: 'background.default' }}>
        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        )}
        {!error && !pdfUrl && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <CircularProgress />
          </Box>
        )}
        {pdfUrl && (
          <Box
            component="iframe"
            src={pdfUrl}
            title={`Outside processing slip ${slipNumber} preview`}
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions>
        {canVoid && (
          <Button
            color="error"
            startIcon={<BlockIcon />}
            onClick={() => {
              setVoidError(null);
              setConfirmVoid(true);
            }}
            disabled={!pdfUrl}
          >
            Void
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
        <Button startIcon={<PrintIcon />} onClick={handlePrint} disabled={!pdfUrl}>
          Print
        </Button>
        <Button
          variant="contained"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={!pdfUrl}
        >
          Download
        </Button>
      </DialogActions>

      <Dialog open={confirmVoid} onClose={() => !voiding && setConfirmVoid(false)}>
        <DialogTitle>Void {slipNumber}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: voidError ? 2 : 0 }}>
            This un-sends the pieces on <strong>{slipNumber}</strong>
            {vendorName ? ` at ${vendorName}` : ''}
            {hasReceipt ? ', including anything already received against it' : ''}. The slip number
            stays on record as voided and is never reused — {vendorName || 'the vendor'} may still
            be holding the printed copy.
          </Typography>
          {voidError && <Alert severity="error">{voidError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmVoid(false)} disabled={voiding}>
            Keep slip
          </Button>
          <Button
            onClick={handleVoidConfirm}
            color="error"
            variant="contained"
            disabled={voiding}
            startIcon={voiding ? <CircularProgress size={16} color="inherit" /> : <BlockIcon />}
          >
            {voiding ? 'Voiding…' : 'Void slip'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
