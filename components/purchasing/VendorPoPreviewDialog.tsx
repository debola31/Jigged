'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import PrintIcon from '@mui/icons-material/Print';
import SendIcon from '@mui/icons-material/Send';

import type { jsPDF } from 'jspdf';
import ErrorAlert from '@/components/common/ErrorAlert';
import { getSupabase } from '@/lib/supabase';
import { todayLocalISODate } from '@/lib/localDate';
import { getCompany, type Company } from '@/utils/companyAccess';
import { getVendorPo, markVendorPoSent } from '@/utils/vendorPoAccess';
import { generateVendorPoPdf, vendorPoPdfFilename } from '@/utils/vendorPoPdf';
import type { VendorPoDetail } from '@/types/vendorPo';

export interface VendorPoPreviewDialogProps {
  open: boolean;
  companyId: string;
  poId: string | null;
  onClose: () => void;
  /**
   * Fired after "Mark as sent & download" stamps the send, so the page re-reads the PO.
   * REQUIRED, and enforced at every mount by __tests__/standards/documentPreviewActions.test.ts:
   * a document must offer the same actions wherever it is opened.
   */
  onMarkedSent: () => void;
}

/** Revoking needs the browser's object-URL API; jsdom (and some embedded views) lack it. */
function revoke(url: string | null) {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

/**
 * The full-screen preview of a purchase order (plan §3.13 "Preview dialog"), shaped like the
 * outside-processing slip's: the document on screen, then Print, Download and an email link.
 *
 * "MARK AS SENT & DOWNLOAD" is the main action while the current revision has not gone out. It
 * stamps the send FIRST, reads the PO again and re-renders from that read, and only then saves the
 * file — so the copy a shop emails can never carry the DRAFT band a never-sent PO prints. A plain
 * Download stays beside it for a copy kept on file.
 *
 * A mailto link cannot attach a file, so the email action opens the message and the dialog says
 * which file to attach. Nothing is sent by the server (plan §2 "Sending").
 *
 * Nothing is written by rendering, so re-opening is always safe.
 */
export default function VendorPoPreviewDialog({ open, companyId, poId, onClose, onMarkedSent }: VendorPoPreviewDialogProps) {
  const [po, setPo] = useState<VendorPoDetail | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const docRef = useRef<jsPDF | null>(null);
  const urlRef = useRef<string | null>(null);
  // The letterhead company: kept in state for what renders (the email subject), and read back in
  // the send handler, which re-renders the PDF from it.
  const [company, setCompany] = useState<Company | null>(null);

  /** Render one read of the PO into the frame, replacing (and releasing) the previous render. */
  const renderPo = useCallback(async (detail: VendorPoDetail, company: Company) => {
    const doc = await generateVendorPoPdf({ po: detail, company, supabase: getSupabase() });
    const url = doc.output('bloburl').toString();
    revoke(urlRef.current);
    urlRef.current = url;
    docRef.current = doc;
    setPo(detail);
    setPdfUrl(url);
    return doc;
  }, []);

  useEffect(() => {
    if (!open || !poId) return;
    let cancelled = false;
    (async () => {
      setLoadError(null);
      setSendError(null);
      setPdfUrl(null);
      try {
        const [detail, company] = await Promise.all([getVendorPo(poId, { today: todayLocalISODate() }), getCompany(companyId)]);
        if (cancelled) return;
        if (!detail) throw new Error('That purchase order is not available.');
        if (!company) throw new Error('Failed to load your company details for the letterhead.');
        setCompany(company);
        await renderPo(detail, company);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to build the purchase order.');
      }
    })();
    return () => {
      cancelled = true;
      revoke(urlRef.current);
      urlRef.current = null;
      docRef.current = null;
    };
  }, [open, poId, companyId, renderPo]);

  const header = po?.header ?? null;
  const filename = header ? vendorPoPdfFilename(header.poNumber, header.revision) : 'purchase-order.pdf';
  const contact = header?.vendorContact ?? null;
  const currentRevisionSent = header !== null && header.sentRevision !== null && header.revision === header.sentRevision;
  const canMarkSent =
    po !== null &&
    header !== null &&
    !header.isArchived &&
    po.summary.status !== 'closed' &&
    po.lines.length > 0 &&
    !currentRevisionSent;

  const subject = header
    ? `Purchase order ${header.poNumber}${header.revision > 0 ? ` Rev ${header.revision}` : ''} from ${company?.name ?? 'us'}`
    : '';
  const mailBody = header
    ? `Hello${contact?.name ? ` ${contact.name}` : ''},\n\nPlease find our purchase order ${header.poNumber} attached (${filename}).\n\nThank you.`
    : '';
  const mailto = `mailto:${contact?.email ?? ''}?${new URLSearchParams({ subject, body: mailBody }).toString().replace(/\+/g, '%20')}`;

  const handleDownload = () => {
    docRef.current?.save(filename);
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

  const handleMarkSentAndDownload = async () => {
    if (!po || !poId || !company) return;
    setSending(true);
    setSendError(null);
    const wasSentBefore = po.header.sentRevision !== null;
    const hadEmail = Boolean(po.header.vendorContact?.email);
    try {
      const today = todayLocalISODate();
      await markVendorPoSent(poId, today);
      posthog.capture('vendor po sent', {
        is_resend: wasSentBefore,
        with_download: true,
        has_contact_email: hadEmail,
      });
      // Re-read and re-render from what the database now holds, THEN save that.
      const fresh = await getVendorPo(poId, { today });
      if (!fresh) throw new Error('The purchase order was marked sent, but it could not be read back. Reload the page.');
      const doc = await renderPo(fresh, company);
      doc.save(vendorPoPdfFilename(fresh.header.poNumber, fresh.header.revision));
      onMarkedSent();
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Purchase order{header ? ` — ${header.poNumber}${header.revision > 0 ? ` Rev ${header.revision}` : ''}` : ''}
        <IconButton aria-label="Close preview" onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
        {loadError && (
          <Alert severity="error" sx={{ m: 2 }}>
            {loadError}
          </Alert>
        )}
        {sendError != null && (
          <Box sx={{ m: 2 }}>
            <ErrorAlert error={sendError} entity="purchase order" onClose={() => setSendError(null)} />
          </Box>
        )}
        {header && !currentRevisionSent && !header.isArchived && (
          <Alert severity="info" sx={{ m: 2, mb: 0 }}>
            {header.sentRevision === null
              ? `${header.poNumber} hasn't been sent, so the preview says DRAFT. Mark as sent & download gives you the copy for ${header.vendorName}.`
              : `Rev ${header.revision} hasn't gone to ${header.vendorName}. Mark it sent when you send this copy.`}
          </Alert>
        )}
        {!loadError && !pdfUrl && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {pdfUrl && (
          <Box
            component="iframe"
            src={pdfUrl}
            title={`Purchase order ${header?.poNumber ?? ''} preview`}
            sx={{ width: '100%', flex: 1, minHeight: (theme) => theme.spacing(60), border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {header && (
          <Typography variant="body2" color="text.secondary" sx={{ mr: 'auto', pl: 1 }}>
            Email can&apos;t attach the file for you — attach {filename} from your downloads.
          </Typography>
        )}
        <Button onClick={onClose}>Close</Button>
        <Button startIcon={<PrintIcon />} onClick={handlePrint} disabled={!pdfUrl}>
          Print
        </Button>
        <Button
          component="a"
          href={mailto}
          startIcon={<EmailOutlinedIcon />}
          disabled={!header}
          variant="outlined"
        >
          {contact?.email ? `Email ${contact.name || contact.email}` : 'Email the vendor'}
        </Button>
        <Button
          variant={canMarkSent ? 'outlined' : 'contained'}
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={!pdfUrl}
        >
          Download
        </Button>
        {canMarkSent && (
          <Button
            variant="contained"
            startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
            onClick={() => void handleMarkSentAndDownload()}
            disabled={!pdfUrl || sending}
          >
            {sending ? 'Marking sent…' : 'Mark as sent & download'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
