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
import type {
  FindingsResponse,
  HealthReport,
  StructureResponse,
  UploadedFilePayload,
} from '@/types/health-report';

type Stage = 'upload' | 'analyzing' | 'review';

const SAMPLE_ROWS = 20; // rows sent to the AI structure step (headers + a few samples only)

export default function HealthReportPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  const [stage, setStage] = useState<Stage>('upload');
  const [files, setFiles] = useState<UploadedFilePayload[]>([]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function postJson<T>(path: string, body: unknown, token: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `Analysis failed (${res.status})`;
      try {
        const b = await res.json();
        if (b?.detail && typeof b.detail === 'string') detail = b.detail;
      } catch {
        /* keep default (e.g. a platform 413 with no JSON body) */
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  }

  async function analyze() {
    setError(null);
    setStage('analyzing');
    try {
      const supabase = getSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your session has expired. Please sign in again.');
      const token = session.access_token;

      // Phase 1 — tiny payload: headers + a few sample rows -> column roles + ERP.
      const structure = await postJson<StructureResponse>(
        '/api/health-report/structure',
        {
          company_id: companyId,
          files: files.map((f) => ({
            filename: f.filename,
            headers: f.headers,
            row_count: f.rows.length,
            sample_rows: f.rows.slice(0, SAMPLE_ROWS).map((r) => f.headers.map((h) => r[h] ?? '')),
          })),
        },
        token,
      );

      // Phase 2 — upload ONLY the columns the analyzer needs (the backend tells us which),
      // encoded positionally (no repeated keys). Keeps the request small no matter how many
      // rows or columns the export has.
      const uploadedByName = new Map(files.map((f) => [f.filename, f]));
      const findingsFiles = structure.files.map((fc) => {
        const uploaded = uploadedByName.get(fc.filename);
        const rows = uploaded?.rows ?? [];
        const cols = structure.needed_columns[fc.filename] ?? [];
        return {
          filename: fc.filename,
          entity_type: fc.entity_type,
          entity_confidence: fc.entity_confidence,
          column_roles: fc.column_roles,
          headers: cols,
          rows: rows.map((r) => cols.map((h) => r[h] ?? '')),
        };
      });

      const fr = await postJson<FindingsResponse>(
        '/api/health-report/findings',
        { company_id: companyId, erp_detection: structure.erp_detection, files: findingsFiles },
        token,
      );

      setReport({
        schema_version: 1,
        erp_detection: structure.erp_detection,
        files: structure.files,
        findings: fr.findings,
        summary: fr.summary,
        recommendations: fr.recommendations,
        narrative_available: fr.narrative_available,
        ai_provider: fr.ai_provider,
        ai_model: fr.ai_model,
        generated_at: new Date().toISOString(),
      });
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
