'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { Finding, ImportReview, Severity } from '@/types/data-import';
import { summarize } from '@/lib/dataImportReview';

// Severity is encoded with THREE channels (icon + text label + color), never color alone
// — WCAG 1.4.1 + IBM Carbon. Info is deliberately low-key (no "green noise").
const SEV: Record<Severity, { label: string; color: 'error' | 'warning' | 'info'; Icon: typeof BlockIcon }> = {
  critical: { label: 'Blocking', color: 'error', Icon: BlockIcon },
  warning: { label: 'Review', color: 'warning', Icon: WarningAmberIcon },
  info: { label: 'Info', color: 'info', Icon: InfoOutlinedIcon },
};

function SeverityChip({ severity }: { severity: Severity }) {
  const s = SEV[severity];
  return <Chip size="small" color={s.color} icon={<s.Icon sx={{ fontSize: 16 }} />} label={s.label} sx={{ fontWeight: 600 }} />;
}

function ActionRow({ finding }: { finding: Finding }) {
  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardContent sx={{ py: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <SeverityChip severity={finding.severity} />
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
            {finding.title}
          </Typography>
          {!finding.verified && <Chip size="small" variant="outlined" label="AI-inferred" />}
        </Box>
        {finding.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {finding.detail}
          </Typography>
        )}
        {finding.examples.length > 0 && (
          <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              e.g.
            </Typography>
            {finding.examples.map((ex, i) => (
              <Chip key={i} size="small" variant="outlined" label={ex} sx={{ maxWidth: 340 }} />
            ))}
          </Box>
        )}
        {finding.recommended_action && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ fontWeight: 700 }}>→</Box>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {finding.recommended_action}
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

const REL_STATUS: Record<'ok' | 'broken' | 'unverified', { color: 'success' | 'error' | 'warning'; Icon: typeof BlockIcon }> = {
  ok: { color: 'success', Icon: CheckCircleOutlineIcon },
  broken: { color: 'error', Icon: BlockIcon },
  unverified: { color: 'warning', Icon: HelpOutlineIcon },
};

export default function ImportReviewView({ report, onUploadMore }: { report: ImportReview; onUploadMore?: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const s = summarize(report);
  const v = s.verdict;
  const verdictColor = v.level === 'blocking' ? 'error' : v.level === 'review' ? 'warning' : 'success';
  const VerdictIcon = v.level === 'blocking' ? BlockIcon : v.level === 'review' ? WarningAmberIcon : CheckCircleOutlineIcon;

  return (
    <Box>
      {/* 1 — Verdict (inverted pyramid: lead with the conclusion + the single top issue) */}
      <Paper
        elevation={0}
        sx={{
          p: 2.5,
          mb: 3,
          borderLeft: 6,
          borderColor: `${verdictColor}.main`,
          bgcolor: (t) => t.palette.action.hover,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <VerdictIcon color={verdictColor} sx={{ fontSize: 32 }} />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {v.headline}
          </Typography>
        </Box>
        {v.level !== 'ready' && (
          <Typography variant="body1" sx={{ mt: 1 }}>
            Start here: <strong>{v.lead}</strong>
          </Typography>
        )}
        <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {v.counts.critical > 0 && (
            <Chip color="error" icon={<BlockIcon sx={{ fontSize: 16 }} />} label={`${v.counts.critical} blocking`} />
          )}
          {v.counts.warning > 0 && (
            <Chip color="warning" icon={<WarningAmberIcon sx={{ fontSize: 16 }} />} label={`${v.counts.warning} to review`} />
          )}
          {v.counts.info > 0 && (
            <Chip variant="outlined" icon={<InfoOutlinedIcon sx={{ fontSize: 16 }} />} label={`${v.counts.info} info`} />
          )}
        </Box>
      </Paper>

      {/* 2 — Fix-first checklist */}
      {s.actions.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            What to fix
          </Typography>
          {s.actions.map((f) => (
            <ActionRow key={f.id} finding={f} />
          ))}
        </Box>
      )}

      {/* 3 — What you're importing (outlook + relationships) */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          What you&apos;re importing
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
        {s.relationships.length > 0 && (
          <Paper variant="outlined" sx={{ p: 0 }}>
            {s.relationships.map((r, i) => {
              const meta = REL_STATUS[r.status];
              return (
                <Box
                  key={r.label}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 1.25,
                    borderTop: i === 0 ? 0 : 1,
                    borderColor: 'divider',
                  }}
                >
                  <meta.Icon color={meta.color} sx={{ fontSize: 20 }} />
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 220 }}>
                    {r.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                    {r.note}
                  </Typography>
                </Box>
              );
            })}
          </Paper>
        )}
      </Box>

      {/* 4 — To finish setup (missing data + prompt to upload more) */}
      {s.toFinish.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" gutterBottom>
            To finish setup
          </Typography>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              {s.toFinish.map((f) => (
                <Box key={f.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                  <SeverityChip severity={f.severity} />
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {f.title}
                    </Typography>
                    {f.recommended_action && (
                      <Typography variant="body2" color="text.secondary">
                        {f.recommended_action}
                      </Typography>
                    )}
                  </Box>
                </Box>
              ))}
            </Stack>
            {onUploadMore && (
              <Button variant="outlined" startIcon={<UploadFileIcon />} sx={{ mt: 2 }} onClick={onUploadMore}>
                Add more files
              </Button>
            )}
          </Paper>
        </Box>
      )}

      {/* 5 — Details (progressive disclosure) */}
      <Button
        size="small"
        onClick={() => setShowDetails((x) => !x)}
        endIcon={showDetails ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      >
        {showDetails ? 'Hide details' : 'Show full summary & details'}
      </Button>
      <Collapse in={showDetails}>
        <Box sx={{ mt: 2 }}>
          {report.narrative_available && report.summary && (
            <>
              <Typography variant="subtitle2" gutterBottom>
                Full summary
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-line', mb: 2 }}>
                {report.summary}
              </Typography>
            </>
          )}
          {report.erp_detection.confidence >= 0.5 && report.erp_detection.source !== 'unknown' && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Looks like a {report.erp_detection.display_name} export.
            </Typography>
          )}
          <Divider sx={{ my: 1 }} />
          <Typography variant="subtitle2" gutterBottom>
            Per-file detail
          </Typography>
          {report.files.map((f) => (
            <Typography key={f.filename} variant="body2" color="text.secondary">
              {f.filename} — {f.entity_type === 'unknown' ? 'unrecognized' : f.entity_type.replace('_', ' ')},{' '}
              {f.row_count.toLocaleString()} rows
              {f.entity_confidence < 0.6 ? ' (low-confidence match — please confirm)' : ''}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
