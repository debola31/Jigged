'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import type { Finding, ImportReview } from '@/types/data-import';
import type { EntityImpact } from '@/lib/dataImportImpact';
import { summarize, type ReviewTask } from '@/lib/dataImportReview';
import { autoCreateLinkFor } from '@/lib/dataImportLinks';

interface ImportReviewViewProps {
  report: ImportReview;
  impact?: EntityImpact[];
  onUploadMore?: () => void;
  /** Open the focused fix for a finding. The row IS the affordance — no per-row buttons. */
  onOpenTask?: (finding: Finding) => void;
}

/**
 * The Review step.
 *
 * Deliberately subtractive vs. what this was: no verdict banner, no severity count chips, no
 * per-row severity badges, no record-count/relationship panel (that belongs on the Import
 * step, where it's about to matter). Exactly ONE saturated element is on screen — what you
 * lose if you import now — because if everything is emphasized, nothing is. Everything else
 * earns attention through position and plain words.
 */
export default function ImportReviewView({
  report,
  impact = [],
  onUploadMore,
  onOpenTask,
}: ImportReviewViewProps) {
  const [showNoticed, setShowNoticed] = useState(false);
  const s = summarize(report, impact);
  const blocking = s.tasks.filter((t) => t.blocking);
  const anythingLost = s.lossPhrase !== '';

  return (
    <Box>
      {/* 1 — The one loud thing: the truth about importing right now. */}
      <Paper
        elevation={0}
        sx={{
          p: 2.5,
          mb: 4,
          display: 'flex',
          gap: 1.75,
          alignItems: 'flex-start',
          border: 1,
          borderColor: anythingLost ? 'error.main' : 'success.main',
          bgcolor: (t) =>
            anythingLost ? `${t.palette.error.main}1c` : `${t.palette.success.main}1c`,
        }}
      >
        {anythingLost ? (
          <BlockIcon color="error" sx={{ mt: 0.25 }} />
        ) : (
          <CheckCircleOutlineIcon color="success" sx={{ mt: 0.25 }} />
        )}
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.45 }}>
            {anythingLost
              ? `If you import now, ${s.lossPhrase} won't come in.`
              : 'Everything you uploaded will come in.'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {anythingLost
              ? blocking.length === 1
                ? 'One thing is causing that.'
                : `${blocking.length} things are causing that.`
              : s.tasks.length > 0
                ? "Nothing's in the way — the rest is just worth a look."
                : 'Nothing needs sorting out.'}
          </Typography>
        </Box>
      </Paper>

      {/* 2 — Tasks, ranked by what they cost. The whole row opens the fix. */}
      {s.tasks.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            What to sort out
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Start at the top — that&apos;s the one costing you the most records.
          </Typography>
          <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
            {s.tasks.map((t) => (
              <TaskRow key={t.finding.id} task={t} onOpenTask={onOpenTask} />
            ))}
          </Box>
        </Box>
      )}

      {/* 3 — Nothing to do here. Collapsed, neutral, out of the way. */}
      {s.noticed.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Button
            size="small"
            onClick={() => setShowNoticed((v) => !v)}
            endIcon={showNoticed ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          >
            {s.noticed.length} other {s.noticed.length === 1 ? 'thing' : 'things'} we noticed — nothing you need to do
          </Button>
          <Collapse in={showNoticed}>
            <Paper variant="outlined" sx={{ mt: 1 }}>
              {s.noticed.map((f, i) => (
                <Box key={f.id} sx={{ p: 2, borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {f.title}
                  </Typography>
                  {f.recommended_action && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                      {f.recommended_action}
                    </Typography>
                  )}
                </Box>
              ))}
            </Paper>
          </Collapse>
        </Box>
      )}

      {onUploadMore && (
        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={onUploadMore}>
          Add more files
        </Button>
      )}
    </Box>
  );
}

/**
 * One task. Neutral by default: the ONLY tag is "Optional", and only because a non-blocking
 * task genuinely reads differently. GOV.UK drops the background from rows that need nothing
 * precisely to "draw more attention to tasks that require action".
 */
function TaskRow({ task, onOpenTask }: { task: ReviewTask; onOpenTask?: (f: Finding) => void }) {
  const { finding, blocking } = task;
  // A task is openable when we have a focused fix for it; otherwise its advice line stands.
  const openable = !!onOpenTask && isOpenable(finding);

  const body = (
    <>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, lineHeight: 1.4 }}>{finding.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {finding.detail || finding.recommended_action}
        </Typography>
        {/* Real values from their own data — recognition beats description. */}
        {finding.examples.length > 0 && (
          <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {finding.examples.slice(0, 4).map((ex, i) => (
              <Chip key={i} size="small" variant="outlined" label={ex} sx={{ maxWidth: 300 }} />
            ))}
          </Box>
        )}
        {!openable && finding.recommended_action && finding.detail && (
          <Typography variant="body2" sx={{ mt: 1, fontWeight: 500 }}>
            {finding.recommended_action}
          </Typography>
        )}
      </Box>
      {!blocking && (
        <Chip size="small" variant="outlined" label="Optional" sx={{ flex: 'none', alignSelf: 'center' }} />
      )}
      {openable && <ChevronRightIcon sx={{ color: 'text.secondary', flex: 'none', alignSelf: 'center' }} />}
    </>
  );

  const sx = {
    display: 'flex',
    gap: 2,
    width: '100%',
    textAlign: 'left' as const,
    p: 2,
    minHeight: 48, // shop-floor touch target
    borderBottom: 1,
    borderColor: 'divider',
    color: 'text.primary',
  };

  if (!openable) return <Box sx={sx}>{body}</Box>;
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onOpenTask!(finding)}
      sx={{
        ...sx,
        alignItems: 'flex-start',
        background: 'none',
        border: 0,
        borderBottom: 1,
        borderColor: 'divider',
        cursor: 'pointer',
        font: 'inherit',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {body}
    </Box>
  );
}

/** Findings with a focused fix behind them today. */
export function isOpenable(finding: Finding): boolean {
  if (autoCreateLinkFor(finding.id)) return true;
  if (finding.category === 'data_gap') return true;
  if (finding.category === 'name_variant') return true;
  return false;
}
