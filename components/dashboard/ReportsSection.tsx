'use client';

import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { useLoad } from '@/hooks/useLoad';
import ReportPreviewDialog from '@/components/insights/ReportPreviewDialog';
import ReportRequestDialog from '@/components/insights/ReportRequestDialog';
import { listReports, type ReportSummary } from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

const EMPTY: ReportSummary[] = [];

interface ReportsSectionProps {
  companyId: string;
}

/**
 * The shop's one-page summaries: a button to ask for a new one, and the recent
 * ones, each re-drawn from its stored spec on open. Listed from the job rows
 * themselves (`kind = 'report'`), so nothing here is a second copy of anything.
 */
export default function ReportsSection({ companyId }: ReportsSectionProps) {
  const [version, setVersion] = useState(0);
  const [requestOpen, setRequestOpen] = useState(false);
  const [preview, setPreview] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, loading } = useLoad(
    async () => (companyId ? listReports(companyId) : EMPTY),
    [companyId, version],
    { onError: () => setError('Failed to load reports.') },
  );
  const reports = data ?? EMPTY;

  const handleGenerated = useCallback((summary: ReportSummary) => {
    setVersion((v) => v + 1);
    setRequestOpen(false);
    setPreview(summary);
  }, []);

  return (
    <Box sx={{ mb: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Reports
          </Typography>
          <DescriptionOutlinedIcon sx={{ fontSize: 20, color: 'primary.main' }} />
        </Box>
        <Button variant="contained" size="small" onClick={() => setRequestOpen(true)}>
          New report
        </Button>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && reports.length > 0 && (
        <List disablePadding>
          {reports.map((r) => {
            const spec = reportSpecOf(r.report);
            const when = new Date(r.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            return (
              <ListItemButton key={r.id} onClick={() => setPreview(r)} sx={{ borderRadius: 1 }}>
                <ListItemText
                  primary={spec?.title ?? 'Report'}
                  secondary={spec ? `${spec.period_label} · generated ${when}` : when}
                />
              </ListItemButton>
            );
          })}
        </List>
      )}

      {!loading && reports.length === 0 && (
        <Box sx={{ py: 4, px: 3, textAlign: 'center', borderRadius: 2, border: '1px dashed', borderColor: 'divider' }}>
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            Ask for a one-page summary of your shop — booked work, backlog, top customers — and it lands here.
          </Typography>
        </Box>
      )}

      <ReportRequestDialog
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        companyId={companyId}
        onGenerated={handleGenerated}
      />
      <ReportPreviewDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        companyId={companyId}
        summary={preview}
      />
    </Box>
  );
}
