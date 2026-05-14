'use client';

import { useEffect, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import EmailIcon from '@mui/icons-material/Email';

import type { jsPDF } from 'jspdf';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';
import { generateQuotePdf, quotePdfFilename } from '@/utils/quotePdf';

interface QuotePdfPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  company: Company;
  /** Optional: when present, render an "Email" button that closes the
   *  preview and invokes this callback so the parent opens the email dialog. */
  onEmail?: () => void;
}

export default function QuotePdfPreviewDialog({
  open,
  onClose,
  quote,
  company,
  onEmail,
}: QuotePdfPreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<jsPDF | null>(null);

  useEffect(() => {
    if (!open) return;
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      setError(null);
      setPdfUrl(null);
      try {
        const doc = await generateQuotePdf(quote, company);
        if (cancelled) return;
        docRef.current = doc;
        const url = doc.output('bloburl') as unknown as string;
        revoked = url;
        setPdfUrl(url);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to generate PDF');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      docRef.current = null;
    };
  }, [open, quote, company]);

  const handleDownload = () => {
    const doc = docRef.current;
    if (!doc) return;
    doc.save(quotePdfFilename(quote));
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Preview — {quote.quote_number ?? 'Quote'}
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
            title={`Quote ${quote.quote_number ?? ''} preview`}
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {onEmail && (
          <Button
            startIcon={<EmailIcon />}
            onClick={() => {
              onClose();
              onEmail();
            }}
            disabled={!pdfUrl}
          >
            Email
          </Button>
        )}
        <Button
          variant="contained"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={!pdfUrl}
        >
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
}
