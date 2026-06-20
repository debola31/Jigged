'use client';

import { useEffect, useRef, useState } from 'react';
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
import PrintIcon from '@mui/icons-material/Print';
import { QRCodeCanvas } from 'qrcode.react';

import type { jsPDF } from 'jspdf';
import { getSupabase } from '@/lib/supabase';
import type { Company } from '@/utils/companyAccess';
import { getJobPartTraveler } from '@/utils/operatorAccess';
import { getBomForPart } from '@/utils/bomAccess';
import {
  generateJobTravelerPdf,
  jobTravelerPdfFilename,
} from '@/utils/jobTravelerPdf';

export interface JobTravelerPreviewDialogProps {
  open: boolean;
  jobPartId: string | null;
  jobId: string;
  companyId: string;
  partName?: string | null;
  onClose: () => void;
}

/**
 * Per-part job-traveler preview. Re-renders the PDF from the job_part on
 * every open. The traveler carries the part's QR code, which deep-links the
 * operator to /operator/{companyId}/login?job={jobId}&part={jobPartId} and,
 * post-login, straight to that part's operator traveler.
 *
 * The QR is rendered through a hidden QRCodeCanvas (mounted below) and read
 * as a PNG data URL — same technique as the old JobQRCode component, so no
 * extra dependency is needed.
 */
export default function JobTravelerPreviewDialog({
  open,
  jobPartId,
  jobId,
  companyId,
  partName,
  onClose,
}: JobTravelerPreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<jsPDF | null>(null);
  const filenameRef = useRef<string>('job-traveler.pdf');
  const qrRef = useRef<HTMLDivElement>(null);

  // The URL the printed QR encodes. Known from props before any fetch, so
  // the hidden canvas is already mounted by the time the effect runs.
  const qrUrl =
    open && jobPartId && typeof window !== 'undefined'
      ? `${window.location.origin}/operator/${companyId}/login?job=${jobId}&part=${jobPartId}`
      : '';

  useEffect(() => {
    if (!open || !jobPartId) return;

    let revoked: string | null = null;
    let cancelled = false;

    (async () => {
      setError(null);
      setPdfUrl(null);
      try {
        const traveler = await getJobPartTraveler(jobPartId, companyId);
        if (!traveler) throw new Error('Traveler not found.');

        // Bill of materials sourced live from the part's BOM (parts_bom).
        const bom = await getBomForPart(traveler.part_id);

        const supabase = getSupabase();
        const { data: companyRow, error: companyErr } = await supabase
          .from('companies')
          .select('id, name, logo_url, address_line1, address_line2, city, state, postal_code, country, phone, email, website')
          .eq('id', companyId)
          .single();
        if (companyErr || !companyRow) {
          throw new Error(companyErr?.message ?? 'Failed to load company.');
        }

        const qrCanvas = qrRef.current?.querySelector('canvas') ?? null;
        const qrDataUrl = qrCanvas ? qrCanvas.toDataURL('image/png') : '';

        const doc = await generateJobTravelerPdf({
          traveler,
          company: companyRow as unknown as Company,
          bom,
          qrDataUrl,
          supabase,
        });
        if (cancelled) return;
        docRef.current = doc;
        filenameRef.current = jobTravelerPdfFilename(traveler.job_number, traveler.part_name);
        const url = doc.output('bloburl') as unknown as string;
        revoked = url;
        setPdfUrl(url);
      } catch (err) {
        if (cancelled) return;
        console.error('JobTravelerPreviewDialog render failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to generate job traveler PDF.');
      }
    })();

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      docRef.current = null;
    };
  }, [open, jobPartId, jobId, companyId]);

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
        window.open(pdfUrl, '_blank');
      }
    };
    document.body.appendChild(iframe);
    // Don't remove the iframe — Chrome cancels the print job if it goes away.
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Job Traveler{partName ? ` — ${partName}` : ''}
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
            title="Job traveler preview"
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions>
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

      {/* Hidden QR canvas — read as a PNG data URL for the PDF. */}
      <Box ref={qrRef} sx={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        {qrUrl && (
          <QRCodeCanvas value={qrUrl} size={240} level="H" includeMargin bgColor="#ffffff" fgColor="#000000" />
        )}
      </Box>
    </Dialog>
  );
}
