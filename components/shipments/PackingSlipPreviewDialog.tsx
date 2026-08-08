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

import type { jsPDF } from 'jspdf';
import { getSupabase } from '@/lib/supabase';
import type { Company } from '@/utils/companyAccess';
import {
  generatePackingSlipPdf,
  packingSlipPdfFilename,
  type PackingSlipPdfContext,
} from '@/utils/packingSlipPdf';
import {
  getShipmentById,
  getShippedBeforeShipment,
  voidShipment,
} from '@/utils/shipmentsAccess';

export interface PackingSlipPreviewDialogProps {
  open: boolean;
  shipmentId: string | null;
  onClose: () => void;
  /**
   * Fired after the slip is voided from this dialog so the caller can re-pull
   * the shipment list + job fulfillment status. When omitted, the void action
   * is hidden (read-only reprint surfaces don't offer it).
   */
  onVoided?: () => void;
}

/**
 * Idempotent packing-slip preview. Re-renders the PDF from the shipment
 * row on every open — used both as the post-create surface and as the
 * "Reprint" action on a shipment history row. Both call paths are
 * harmless to re-run; nothing is written by this dialog.
 */
export default function PackingSlipPreviewDialog({
  open,
  shipmentId,
  onClose,
  onVoided,
}: PackingSlipPreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [packingSlipNumber, setPackingSlipNumber] = useState<string>('');
  const [voidedAt, setVoidedAt] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const docRef = useRef<jsPDF | null>(null);
  const filenameRef = useRef<string>('packing-slip.pdf');

  const canVoid = !!onVoided && !!shipmentId && !voidedAt;

  const handleVoidConfirm = useCallback(async () => {
    if (!shipmentId) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await voidShipment(shipmentId);
      setConfirmVoid(false);
      onVoided?.();
      onClose();
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'Failed to void shipment.');
    } finally {
      setVoiding(false);
    }
  }, [shipmentId, onVoided, onClose]);

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
        const shipment = await getShipmentById(shipmentId);

        // Independent reads — the company profile and what shipped on
        // this job's earlier slips (which the Qty Remaining column nets out).
        const [companyRes, shippedBeforeByJobPart] = await Promise.all([
          supabase
            .from('companies')
            .select('id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website')
            .eq('id', shipment.company_id)
            .single(),
          getShippedBeforeShipment(shipment),
        ]);
        if (companyRes.error || !companyRes.data) {
          throw new Error(companyRes.error?.message ?? 'Failed to load company.');
        }

        const ctx: PackingSlipPdfContext = {
          shipment,
          company: companyRes.data as unknown as Company,
          shippedBeforeByJobPart,
          supabase,
        };

        const doc = await generatePackingSlipPdf(ctx);
        if (cancelled) return;
        docRef.current = doc;
        filenameRef.current = packingSlipPdfFilename(shipment);
        const url = doc.output('bloburl') as unknown as string;
        revoked = url;
        setPdfUrl(url);
        setPackingSlipNumber(shipment.packing_slip_number);
        setVoidedAt(shipment.voided_at ?? null);
      } catch (err) {
        if (cancelled) return;
        console.error('PackingSlipPreviewDialog render failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to generate packing slip PDF.');
      }
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      docRef.current = null;
    };
  }, [open, shipmentId]);

  const handleDownload = () => {
    const doc = docRef.current;
    if (!doc) return;
    doc.save(filenameRef.current);
  };

  const handlePrint = () => {
    if (!pdfUrl) return;
    // Print via iframe — opens the browser's print dialog directly.
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
        // Some browsers block programmatic print on cross-origin frames.
        // The fallback is to open the PDF in a new tab.
        window.open(pdfUrl, '_blank');
      }
    };
    document.body.appendChild(iframe);
    // Don't remove the iframe — Chrome cancels the print job if it goes away.
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Packing Slip{packingSlipNumber ? ` — ${packingSlipNumber}` : ''}
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
            title={`Packing slip ${packingSlipNumber} preview`}
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
        <Button
          startIcon={<PrintIcon />}
          onClick={handlePrint}
          disabled={!pdfUrl}
        >
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
        <DialogTitle>Void {packingSlipNumber}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: voidError ? 2 : 0 }}>
            This reverses the shipped quantities on <strong>{packingSlipNumber}</strong> and
            reopens the affected lines. The packing-slip number stays on record as voided — it
            is not reused.
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
