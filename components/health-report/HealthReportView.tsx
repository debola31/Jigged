'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ConfidenceChip from '@/components/import/ConfidenceChip';
import type { Finding, HealthReport, Severity } from '@/types/health-report';

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info'];

const SEVERITY_META: Record<Severity, { label: string; color: 'error' | 'warning' | 'info' }> = {
  critical: { label: 'Needs attention', color: 'error' },
  warning: { label: 'Worth a look', color: 'warning' },
  info: { label: 'For your information', color: 'info' },
};

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <Card elevation={2} sx={{ mb: 1.5 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
            {finding.title}
          </Typography>
          {!finding.verified && <Chip size="small" color="default" variant="outlined" label="AI-inferred" />}
        </Box>
        {finding.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {finding.detail}
          </Typography>
        )}
        {finding.examples.length > 0 && (
          <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {finding.examples.map((ex, i) => (
              <Chip key={i} size="small" label={ex} sx={{ maxWidth: 320 }} />
            ))}
          </Box>
        )}
        {finding.recommended_action && (
          <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic' }}>
            → {finding.recommended_action}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function HealthReportView({ report }: { report: HealthReport }) {
  const { erp_detection: erp } = report;
  // Detection is informative context, never a bold headline. Below ~0.5 confidence or
  // "unknown", we don't present a verdict at all — the findings apply regardless.
  const showErp = erp.confidence >= 0.5 && erp.source !== 'unknown';

  const findingsBySeverity = SEVERITY_ORDER.map((sev) => ({
    sev,
    items: report.findings.filter((f) => f.severity === sev),
  })).filter((g) => g.items.length > 0);

  return (
    <Box>
      {/* Source system — modest, hedged */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        {showErp ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              Looks consistent with:
            </Typography>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {erp.display_name}
            </Typography>
            <ConfidenceChip confidence={erp.confidence} reasoning={erp.evidence} />
            {erp.matched_headers.slice(0, 4).map((m) => (
              <Chip key={m.header} size="small" variant="outlined" label={m.header} title={m.signal} />
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Source system not auto-identified — the readiness report below applies regardless.
          </Typography>
        )}
      </Paper>

      {/* Per-file classification */}
      <Typography variant="h6" gutterBottom>
        Files
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 3, flexWrap: 'wrap', gap: 1 }}>
        {report.files.map((f) => (
          <Paper key={f.filename} variant="outlined" sx={{ p: 1.5, minWidth: 200 }}>
            <Typography variant="subtitle2" noWrap>
              {f.filename}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <Chip
                size="small"
                label={f.entity_type === 'unknown' ? 'unrecognized' : f.entity_type.replace('_', ' ')}
                color={f.entity_type === 'unknown' ? 'default' : 'primary'}
              />
              <ConfidenceChip confidence={f.entity_confidence} />
            </Box>
            <Typography variant="caption" color="text.secondary">
              {f.row_count} rows
            </Typography>
          </Paper>
        ))}
      </Stack>

      {/* Narrative summary */}
      {report.narrative_available ? (
        report.summary && (
          <Card elevation={2} sx={{ mb: 3 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Summary
              </Typography>
              <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                {report.summary}
              </Typography>
              {report.recommendations.length > 0 && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2" gutterBottom>
                    Recommended next steps
                  </Typography>
                  <List dense>
                    {report.recommendations.map((r, i) => (
                      <ListItem key={i} sx={{ py: 0.25 }}>
                        <ListItemText primary={`${i + 1}. ${r}`} />
                      </ListItem>
                    ))}
                  </List>
                </>
              )}
            </CardContent>
          </Card>
        )
      ) : (
        <Alert severity="info" sx={{ mb: 3 }}>
          AI summary unavailable — showing the detailed findings below only.
        </Alert>
      )}

      {/* Findings grouped by severity */}
      {findingsBySeverity.map(({ sev, items }) => (
        <Box key={sev} sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Chip size="small" color={SEVERITY_META[sev].color} label={SEVERITY_META[sev].label} />
            <Typography variant="body2" color="text.secondary">
              {items.length} item{items.length === 1 ? '' : 's'}
            </Typography>
          </Box>
          {items.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </Box>
      ))}
    </Box>
  );
}
