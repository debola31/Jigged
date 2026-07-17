'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import type { Finding, ImportReview } from '@/types/data-import';
import type { EntityImpact } from '@/lib/dataImportImpact';
import { summarize, isOpenable, type ReviewTask } from '@/lib/dataImportReview';
import { autoCreateLinkFor } from '@/lib/dataImportLinks';

interface ImportReviewViewProps {
  report: ImportReview;
  impact?: EntityImpact[];
  onUploadMore?: () => void;
  /** Open the focused fix for a finding. */
  onOpenTask?: (finding: Finding) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

/**
 * The Review step.
 *
 * Deliberately subtractive: no verdict banner, no severity count chips, no per-row severity
 * badges, no record-count panel (that's on the Import step). Exactly ONE saturated element is on
 * screen — what you lose if you import now — because if everything is emphasized, nothing is.
 *
 * The things you should DO read as interactive cards with an action button; the optional FYIs
 * read as quiet plain rows. That visual split IS the priority signal.
 */
export default function ImportReviewView({
  report,
  impact = [],
  onUploadMore,
  onOpenTask,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: ImportReviewViewProps) {
  const [showNoticed, setShowNoticed] = useState(false);
  const s = summarize(report, impact);
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
          bgcolor: (t) => (anythingLost ? `${t.palette.error.main}1c` : `${t.palette.success.main}1c`),
        }}
      >
        {anythingLost ? (
          <BlockIcon color="error" sx={{ mt: 0.25 }} />
        ) : (
          <CheckCircleOutlineIcon color="success" sx={{ mt: 0.25 }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.45 }}>
            {anythingLost
              ? `If you import now, ${s.lossPhrase} won't come in.`
              : 'Everything you uploaded will come in.'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {anythingLost
              ? 'Open each one below to fix it — the count grows as you go.'
              : s.tasks.length > 0
                ? "Nothing's in the way — the rest is just worth a look."
                : 'Nothing needs sorting out.'}
          </Typography>

          {/* What WILL come in — the positive side, and the progress signal: this bar fills
              and the count climbs toward the total as each fix lands. */}
          {s.totalRows > 0 && (
            <Box sx={{ mt: 1.75 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {anythingLost
                    ? `${s.willImport.toLocaleString()} of ${s.totalRows.toLocaleString()} rows will come in`
                    : `All ${s.totalRows.toLocaleString()} rows will come in`}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {Math.round((s.willImport / s.totalRows) * 100)}%
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(s.willImport / s.totalRows) * 100}
                color={anythingLost ? 'primary' : 'success'}
                sx={{ height: 8, borderRadius: 4 }}
              />
            </Box>
          )}
        </Box>
      </Paper>

      {/* 2 — Tasks, ranked by what they cost. */}
      {s.tasks.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h6" sx={{ fontWeight: 600, flex: 1 }}>
              What to sort out
            </Typography>
            {(canUndo || canRedo) && (
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                <Button size="small" startIcon={<UndoIcon />} disabled={!canUndo} onClick={onUndo}>
                  Undo
                </Button>
                <Button size="small" startIcon={<RedoIcon />} disabled={!canRedo} onClick={onRedo}>
                  Redo
                </Button>
              </Box>
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Start at the top — that&apos;s the one costing you the most records.
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
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
              {s.noticed.map((f, i) => {
                // The explanatory line: prefer the "what to do" advice, else the "what happens"
                // detail (e.g. duplicates: "the repeats collapse into one record").
                const note = f.recommended_action || f.detail;
                return (
                  <Box key={f.id} sx={{ p: 2, borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {f.title}
                    </Typography>
                    {note && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                        {note}
                      </Typography>
                    )}
                  </Box>
                );
              })}
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

/** The verb on a task's action button — says exactly what opening it does. */
function actionVerb(finding: Finding): string {
  if (autoCreateLinkFor(finding.id)) return 'Add them';
  if (finding.category === 'data_gap') {
    const field = finding.id.split('.').slice(2).join('.');
    return field === 'primary_unit' || field === 'unit' ? 'Set units' : 'Fill in';
  }
  if (finding.category === 'name_variant') return 'Review';
  return 'Open';
}

/**
 * One task. Two visual treatments that encode the priority:
 *  - Actionable (has a focused fix): an interactive outlined card with a verb button, so it
 *    unmistakably reads as "click me".
 *  - Optional / no in-app fix: a quiet plain row with an "Optional" tag and its advice line.
 */
function TaskRow({ task, onOpenTask }: { task: ReviewTask; onOpenTask?: (f: Finding) => void }) {
  const { finding, blocking } = task;
  const openable = !!onOpenTask && isOpenable(finding);

  const details = (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontWeight: 600, lineHeight: 1.4 }}>{finding.title}</Typography>
      {finding.detail && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {finding.detail}
        </Typography>
      )}
      {/* Real values from their own data — recognition beats description. */}
      {finding.examples.length > 0 && (
        <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {finding.examples.slice(0, 4).map((ex, i) => (
            <Chip key={i} size="small" variant="outlined" label={ex} sx={{ maxWidth: 300 }} />
          ))}
        </Box>
      )}
    </Box>
  );

  // Optional / non-actionable: a quiet plain row, clearly secondary to the action cards.
  if (!openable) {
    return (
      <Box sx={{ display: 'flex', gap: 2, p: 2, borderBottom: 1, borderColor: 'divider' }}>
        {details}
        {!blocking && (
          <Chip size="small" variant="outlined" label="Optional" sx={{ flex: 'none', alignSelf: 'flex-start' }} />
        )}
      </Box>
    );
  }

  // Actionable: an interactive card. It's a role="button" DIV, not a <button> — the card holds
  // rich flow content (paragraphs, chips) that a real <button> can't legally contain. Keyboard
  // support is wired explicitly so it stays accessible.
  const open = () => onOpenTask!(finding);
  return (
    <Paper
      variant="outlined"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'center',
        p: 2,
        minHeight: 48, // shop-floor touch target
        cursor: 'pointer',
        borderColor: 'divider',
        transition: 'border-color 0.15s, background 0.15s',
        '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' },
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {details}
      {!blocking && <Chip size="small" variant="outlined" label="Optional" sx={{ flex: 'none' }} />}
      {/* Looks like a button; is NOT one — the whole card is the button, so a real <button>
          here would nest interactive elements (invalid HTML + double focus). */}
      <Box
        sx={{
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          pl: 1.5,
          pr: 0.75,
          py: 0.75,
          borderRadius: 1,
          border: 1,
          borderColor: 'primary.main',
          color: 'primary.main',
          fontSize: '0.8125rem',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {actionVerb(finding)}
        <ChevronRightIcon fontSize="small" />
      </Box>
    </Paper>
  );
}

