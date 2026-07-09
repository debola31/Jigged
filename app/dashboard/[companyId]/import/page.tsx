'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Paper from '@mui/material/Paper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import AIAnalysisLoading from '@/components/import/AIAnalysisLoading';
import MultiFileDropzone from '@/components/health-report/MultiFileDropzone';
import HealthReportView from '@/components/health-report/HealthReportView';
import { analyzeBundle, type AnalyzedFile } from '@/lib/healthReportAnalyzer';
import { summarize } from '@/lib/healthReportSummary';
import { API_BASE_URL } from '@/lib/api';
import { getSupabase } from '@/lib/supabase';
import type {
  Finding,
  HealthReport,
  NarrativeResponse,
  StructureResponse,
  UploadedFilePayload,
} from '@/types/health-report';

const STEPS = ["What you'll need", 'Upload your files', 'Review', 'Import'];
const SAMPLE_ROWS = 20;

const WHAT_TO_EXPORT = [
  { name: 'Parts & inventory', hint: 'part numbers, descriptions, costs, on-hand qty' },
  { name: 'Vendors', hint: 'suppliers and outside processors' },
  { name: 'Work centers', hint: 'machines and outside operations' },
  { name: 'Routings', hint: 'the operation steps for each part' },
  { name: 'Bills of material', hint: 'which parts go into which assemblies' },
  { name: 'Customers', hint: 'optional, if you have them' },
];

export default function ImportDataPage() {
  const params = useParams();
  const companyId = params.companyId as string;

  const [activeStep, setActiveStep] = useState(0);
  const [files, setFiles] = useState<UploadedFilePayload[]>([]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
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
        /* keep default */
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  }

  async function analyze() {
    setError(null);
    setAnalyzing(true);
    try {
      const supabase = getSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your session has expired. Please sign in again.');
      const token = session.access_token;

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

      const uploadedByName = new Map(files.map((f) => [f.filename, f]));
      const analyzed: AnalyzedFile[] = structure.files.map((fc) => ({
        filename: fc.filename,
        entityType: fc.entity_type,
        columnRoles: fc.column_roles,
        rows: uploadedByName.get(fc.filename)?.rows ?? [],
        headers: fc.headers,
      }));
      const findings = analyzeBundle(analyzed);

      const narrative = await postJson<NarrativeResponse>(
        '/api/health-report/narrative',
        {
          company_id: companyId,
          erp_detection: structure.erp_detection,
          findings: findings.map((f) => ({
            id: f.id,
            category: f.category,
            severity: f.severity,
            title: f.title,
            detail: f.detail,
            count: f.count,
            examples: f.examples.slice(0, 3),
          })),
          file_summaries: analyzed.map((af) => ({
            filename: af.filename,
            entity_type: af.entityType,
            row_count: af.rows.length,
          })),
        },
        token,
      );

      const gotchaFindings: Finding[] = narrative.gotchas.map((g, i) => ({
        id: `gotcha.${i}`,
        category: 'erp_gotcha',
        severity: 'info',
        entity_type: 'unknown',
        title: g.title || 'Worth verifying',
        detail: g.detail || '',
        count: 0,
        examples: [],
        source_files: [],
        verified: false,
        recommended_action: g.recommended_action || '',
      }));

      setReport({
        schema_version: 1,
        erp_detection: structure.erp_detection,
        files: structure.files,
        findings: [...findings, ...gotchaFindings],
        summary: narrative.narrative_available ? narrative.summary : '',
        recommendations: narrative.recommendations,
        narrative_available: narrative.narrative_available,
        ai_provider: narrative.ai_provider,
        ai_model: narrative.ai_model,
        generated_at: new Date().toISOString(),
      });
      setActiveStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Import your data
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Bring your existing shop data into Jigged. We&apos;ll check it first and show you exactly what
          will come in — nothing is imported until you say so.
        </Typography>
      </Box>

      <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Step 0 — What you'll need */}
      {activeStep === 0 && (
        <Card elevation={2}>
          <CardContent sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Export these from your current system as CSV
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Add whatever you have — you don&apos;t need all of them, and you can add more later. Most
              shop systems (JobBOSS, E2, Tangle, spreadsheets) can export each list to CSV.
            </Typography>
            <Stack spacing={1.25}>
              {WHAT_TO_EXPORT.map((w) => (
                <Box key={w.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <DescriptionOutlinedIcon color="action" />
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {w.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    — {w.hint}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="contained" size="large" onClick={() => setActiveStep(1)}>
                Get started
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Step 1 — Upload */}
      {activeStep === 1 && !analyzing && (
        <Box>
          <MultiFileDropzone files={files} onChange={setFiles} />
          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setActiveStep(0)}>Back</Button>
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
      {activeStep === 1 && analyzing && (
        <AIAnalysisLoading description="Reading your files, detecting the source system, and checking data quality…" />
      )}

      {/* Step 2 — Review */}
      {activeStep === 2 && report && (
        <Box>
          <HealthReportView report={report} onUploadMore={() => setActiveStep(1)} />
          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setActiveStep(1)}>Back to files</Button>
            <Button variant="contained" size="large" onClick={() => setActiveStep(3)}>
              Continue to import
            </Button>
          </Box>
        </Box>
      )}

      {/* Step 3 — Import (pre-commit review; the write is deferred) */}
      {activeStep === 3 && report && <ImportStep report={report} onBack={() => setActiveStep(2)} />}
    </Box>
  );
}

function ImportStep({ report, onBack }: { report: HealthReport; onBack: () => void }) {
  const s = summarize(report);
  const blocking = s.verdict.counts.critical;
  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Review what will be created
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Once imported, Jigged will contain:
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5, mb: 2 }}>
          {s.outlook.map((o) => (
            <Paper key={o.entityType} variant="outlined" sx={{ px: 2, py: 1.5, minWidth: 130 }}>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                {o.count.toLocaleString()}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {o.label}
              </Typography>
            </Paper>
          ))}
        </Stack>

        {blocking > 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            You still have <strong>{blocking} blocking issue{blocking === 1 ? '' : 's'}</strong>. We
            strongly recommend fixing {blocking === 1 ? 'it' : 'them'} in your source files and
            re-checking before importing, or some records will be dropped.
          </Alert>
        ) : (
          <Alert severity="success" icon={<CheckCircleOutlineIcon />} sx={{ mb: 2 }}>
            No blocking issues — your data looks ready to bring in.
          </Alert>
        )}

        <Alert severity="info" sx={{ mb: 2 }}>
          Guided one-click import is coming soon. For now, our team brings your cleaned data into
          Jigged with you — this check is the first step so nothing is lost.
        </Alert>

        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onBack}>Back to review</Button>
          <Button variant="contained" size="large" disabled>
            Import into Jigged (coming soon)
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
