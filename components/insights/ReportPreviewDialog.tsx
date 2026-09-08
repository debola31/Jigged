'use client';

import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
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
import type { jsPDF } from 'jspdf';
import { getSupabase } from '@/lib/supabase';
import { getCompany } from '@/utils/companyAccess';
import type { ReportSummary } from '@/utils/insightsAccess';
import { generateReportPdf, reportPdfFilename } from '@/utils/reportPdf';
import { reportSpecOf, type ReportSpec } from '@/utils/reportSpec';

interface ReportPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  summary: ReportSummary | null;
}

/**
 * The one-page PDF, rendered in the browser from the stored spec -- the same
 * preview-then-download shape as a quote or a packing slip. Nothing is uploaded:
 * the spec on the job row is the durable record, and the page is re-drawn from
 * it every time.
 */
export default function ReportPreviewDialog({ open, onClose, companyId, summary }: ReportPreviewDialogProps) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<jsPDF | null>(null);
  const specRef = useRef<ReportSpec | null>(null);
  const generatedAtRef = useRef<Date>(new Date());

  useEffect(() => {
    if (!open || !summary) return;
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      setError(null);
      setPdfUrl(null);
      try {
        const spec = reportSpecOf(summary.report);
        if (!spec) throw new Error("This report can't be displayed — it was made by an older version.");
        const company = await getCompany(companyId);
        if (!company) throw new Error('Company details could not be loaded.');
        generatedAtRef.current = new Date();
        const doc = await generateReportPdf(spec, company, generatedAtRef.current, getSupabase());
        if (cancelled) return;
        docRef.current = doc;
        specRef.current = spec;
        const url = doc.output('bloburl') as unknown as string;
        revoked = url;
        setPdfUrl(url);
      } catch (err) {
        if (!cancelled) {
          Sentry.captureException(err);
          setError(err instanceof Error ? err.message : 'Failed to generate the PDF');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
      docRef.current = null;
      specRef.current = null;
    };
  }, [open, summary, companyId]);

  const handleDownload = () => {
    const doc = docRef.current;
    const spec = specRef.current;
    if (!doc || !spec) return;
    doc.save(reportPdfFilename(spec, generatedAtRef.current));
    // Shape only: how big a page earned a download, never its title or figures.
    posthog.capture('report exported', {
      block_count: spec.blocks.length,
      chart_count: spec.blocks.filter((b) => b.type === 'chart').length,
    });
  };

  const title = summary ? reportSpecOf(summary.report)?.title ?? 'Report' : 'Report';

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        Preview — {title}
        <IconButton aria-label="Close preview" onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }}>
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
            title={`${title} preview`}
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleDownload} disabled={!pdfUrl}>
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
}
