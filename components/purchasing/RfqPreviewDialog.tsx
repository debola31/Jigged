'use client';

/**
 * One vendor's copy of an RFQ, previewed: Print, Download, Email the contact, and "Mark as sent &
 * download" (plan §3.9, §3.13 "Preview dialog"; criterion Q1).
 *
 * The PDF is `generateRfqPdf` for THIS invitation, fed the vendor's part numbers from its own
 * approved-vendor rows (`listVendorParts`). Rendering writes nothing, so reopening is always safe.
 *
 * ACTIONS DO NOT DEPEND ON WHICH CONTROL OPENED IT. `onMarkedSent` is REQUIRED, and a read-only
 * copy (a closed or archived RFQ) says so with `readOnly` rather than by leaving the handler off —
 * the rule `__tests__/standards/documentPreviewActions.test.ts` holds every preview to, after the
 * packing slip shipped with one mount that could void and one that silently could not.
 */
import { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import PrintIcon from '@mui/icons-material/Print';
import type { jsPDF } from 'jspdf';

import ErrorAlert from '@/components/common/ErrorAlert';
import { getSupabase } from '@/lib/supabase';
import { todayLocalISODate } from '@/lib/localDate';
import { getCompany } from '@/utils/companyAccess';
import { listVendorParts } from '@/utils/partVendorsAccess';
import { generateRfqPdf, rfqEmailHref, rfqPdfFilename } from '@/utils/rfqPdf';
import { setVendorRfqInvitationState } from '@/utils/vendorRfqAccess';
import type { VendorRfqDetail } from '@/types/vendorRfq';

export interface RfqPreviewDialogProps {
  open: boolean;
  rfq: VendorRfqDetail;
  /** The invited vendor whose copy this is. */
  invitationId: string | null;
  onClose: () => void;
  /** After "Mark as sent" stamps the send: the page re-reads the RFQ. Required on every mount. */
  onMarkedSent: () => void;
  /** A closed or archived RFQ: print and download only. Explicit — never by omitting a handler. */
  readOnly?: boolean;
}

export default function RfqPreviewDialog({
  open,
  rfq,
  invitationId,
  onClose,
  onMarkedSent,
  readOnly = false,
}: RfqPreviewDialogProps) {
  const invitation = rfq.invitations.find((i) => i.id === invitationId) ?? null;
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<unknown>(null);
  const docRef = useRef<jsPDF | null>(null);

  // The copy is built once per opening, from the RFQ as it was then. A refresh after "Mark sent"
  // changes nothing printed, so it must not blank the preview and rebuild it.
  const rfqRef = useRef(rfq);
  useEffect(() => {
    rfqRef.current = rfq;
  });

  const vendorId = invitation?.vendorId ?? null;
  useEffect(() => {
    if (!open || !invitationId || !vendorId) return;
    let cancelled = false;
    let url: string | null = null;

    (async () => {
      setLoadError(null);
      setPdfUrl(null);
      try {
        const current = rfqRef.current;
        const [company, parts] = await Promise.all([
          getCompany(current.header.companyId),
          listVendorParts(vendorId, { today: todayLocalISODate() }),
        ]);
        if (!company) throw new Error("Couldn't load your shop's details for the letterhead. Try again.");
        const doc = await generateRfqPdf({
          rfq: current,
          invitationId,
          company,
          vendorPartNumbers: parts.map((p) => ({
            partId: p.partId,
            vendorId,
            vendorPartNumber: p.vendorPartNumber,
          })),
          supabase: getSupabase(),
        });
        if (cancelled) return;
        docRef.current = doc;
        url = doc.output('bloburl').toString();
        setPdfUrl(url);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't build the RFQ.");
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      docRef.current = null;
    };
  }, [open, invitationId, vendorId]);

  const filename = invitation ? rfqPdfFilename(rfq.header.rfqNumber, invitation.vendorName) : 'RFQ.pdf';
  const emailHref = invitation
    ? rfqEmailHref({
        rfqNumber: rfq.header.rfqNumber,
        title: rfq.header.title,
        respondByOn: rfq.header.respondByOn,
        shopName: rfq.header.shipToName,
        contact: invitation.vendorContact,
      })
    : null;
  const contactName = invitation?.vendorContact?.name?.trim() || invitation?.vendorName || '';
  const declined = invitation?.declinedAt != null;
  const canMarkSent = !readOnly && !!invitation && !declined;
  const isSent = invitation?.sentAt != null;

  const handleDownload = () => docRef.current?.save(filename);

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
    // Not removed: Chrome cancels the print job if the frame goes away.
  };

  const handleMarkSent = async (download: boolean) => {
    if (!invitation) return;
    setMarking(true);
    setMarkError(null);
    try {
      await setVendorRfqInvitationState(invitation.id, 'mark_sent');
      posthog.capture('vendor rfq sent', { is_resend: invitation.sentAt !== null });
      if (download) docRef.current?.save(filename);
      onMarkedSent();
    } catch (err) {
      setMarkError(err);
    } finally {
      setMarking(false);
    }
  };

  const ready = Boolean(pdfUrl) && !marking;

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        {rfq.header.rfqNumber}
        {invitation ? ` — ${invitation.vendorName}'s copy` : ''}
        <IconButton aria-label="Close preview" onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: 'background.default' }}>
        {!invitation && (
          <Alert severity="info" sx={{ m: 2 }}>
            That vendor isn&apos;t on this RFQ.
          </Alert>
        )}
        {loadError && (
          <Alert severity="error" sx={{ m: 2 }}>
            {loadError}
          </Alert>
        )}
        <ErrorAlert error={markError} entity="RFQ" onClose={() => setMarkError(null)} sx={{ m: 2 }} />
        {invitation && !loadError && !pdfUrl && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <CircularProgress />
          </Box>
        )}
        {pdfUrl && invitation && (
          <Box
            component="iframe"
            src={pdfUrl}
            title={`${rfq.header.rfqNumber} for ${invitation.vendorName} preview`}
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="outlined" startIcon={<PrintIcon />} onClick={handlePrint} disabled={!ready}>
          Print
        </Button>
        {emailHref && (
          <Button variant="outlined" startIcon={<MailOutlineIcon />} component="a" href={emailHref}>
            Email {contactName}
          </Button>
        )}
        {canMarkSent && isSent && (
          <Button variant="outlined" onClick={() => handleMarkSent(false)} disabled={marking}>
            Mark sent again
          </Button>
        )}
        <Button
          variant={canMarkSent && !isSent ? 'outlined' : 'contained'}
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={!ready}
        >
          Download
        </Button>
        {canMarkSent && !isSent && (
          <Button variant="contained" onClick={() => handleMarkSent(true)} disabled={!ready}>
            Mark as sent &amp; download
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
