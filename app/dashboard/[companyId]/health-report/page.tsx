'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import MultiFileDropzone from '@/components/health-report/MultiFileDropzone';
import HealthReportView from '@/components/health-report/HealthReportView';
import { API_BASE_URL } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import type { HealthReport, HealthReportResponse, UploadedFilePayload } from '@/types/health-report';

type Stage = 'upload' | 'analyzing' | 'review';

export default function HealthReportPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  const [stage, setStage] = useState<Stage>('upload');
  const [files, setFiles] = useState<UploadedFilePayload[]>([]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setError(null);
    setStage('analyzing');
    try {
      const supabase = getSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Your session has expired. Please sign in again.');
      }

      const res = await fetch(`${API_BASE_URL}/api/health-report/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ company_id: companyId, files }),
      });

      if (!res.ok) {
        let detail = `Analysis failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : detail;
        } catch {
          /* keep default */
        }
        throw new Error(detail);
      }

      const data: HealthReportResponse = await res.json();
      setReport(data.report);
      setStage('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setStage('upload');
    }
  }

  function reset() {
    setFiles([]);
    setReport(null);
    setError(null);
    setStage('upload');
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Data Health Check
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Upload your existing ERP CSV exports to see what&apos;s in them and what to clean up
          before we bring your data into Jigged. This is read-only — nothing is imported or saved.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {stage === 'analyzing' && (
        <AIAnalysisLoading description="Reading your files, detecting the source system, and checking data quality…" />
      )}

      {stage === 'upload' && (
        <Box>
          <MultiFileDropzone files={files} onChange={setFiles} />
          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              size="large"
              startIcon={<AutoAwesomeIcon />}
              disabled={files.length === 0}
              onClick={analyze}
            >
              Analyze {files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'}` : ''}
            </Button>
          </Box>
        </Box>
      )}

      {stage === 'review' && report && (
        <Box>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={reset}>
              Start over
            </Button>
          </Box>
          <HealthReportView report={report} />
        </Box>
      )}
    </Box>
  );
}
