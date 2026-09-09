'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import InsightChart from './InsightChart';
import type { ReportTurn } from '@/utils/aiChatAccess';
import type { ChartConfig } from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

interface ConversationTurnProps {
  question: string;
  answer: string;
  chartConfig: ChartConfig | null;
  /** Set when this turn is a one-page report: the answer is its headline. */
  report?: ReportTurn | null;
  /** Chart height in pixels. */
  chartHeight?: number;
  /** Opens the report's preview (the PDF, drawn from the stored spec). */
  onOpenReport?: () => void;
  /** What the model offered to look at next. Rendered on the newest turn only. */
  followUps?: string[];
  /** Asks one of them. Absent on every turn but the newest. */
  onFollowUp?: (question: string) => void;
  /** Disables the follow-up chips while another question is in flight. */
  followUpsDisabled?: boolean;
}

/**
 * One answered turn of a conversation: the question, the answer, then the chart
 * it introduces, or the report card when the turn was a request for a one-pager.
 *
 * NOT A CARD, since 2026-09-09. One `<Card>` per turn gave every exchange the
 * same weight and the same edges, so four turns read as four search results and
 * the question -- set as 12px caption -- was the smallest text on the screen. The
 * shape here is the one every chat people already use: the question is a short
 * right-aligned bubble, the answer runs full width underneath with no container
 * at all, and the asymmetry alone says who spoke. The report inset stays a
 * bordered object, because it is the one thing in a turn that IS a separate
 * object -- a document you open.
 *
 * The chart hides CLIENT-SIDE ONLY. `ai_chat_messages` has no UPDATE or DELETE
 * grant for any role and must not get one: the turn is the record of what the
 * assistant said, and a chart the owner is done looking at is a view preference,
 * not a correction to the record.
 *
 * No pin button since 2026-09-08. A chart is kept by having been answered -- the
 * History rail lists every turn that carried one -- so there is nothing to save.
 */
export default function ConversationTurn({
  question,
  answer,
  chartConfig,
  report = null,
  chartHeight = 220,
  onOpenReport,
  followUps = [],
  onFollowUp,
  followUpsDisabled = false,
}: ConversationTurnProps) {
  const spec = report ? reportSpecOf(report.report) : null;
  const [chartHidden, setChartHidden] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard denied or unavailable. The answer is on screen either way,
         and a toast about a failed copy is noise on a surface this quiet. */
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {/* The question, as the person said it. Right-aligned and tinted, which is
          the whole reason this reads as a conversation rather than a list. */}
      <Box
        sx={{
          alignSelf: 'flex-end',
          maxWidth: { xs: '88%', sm: '74%' },
          px: 1.5,
          py: 1,
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.2),
          border: '1px solid',
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.34),
          borderRadius: '12px 12px 4px 12px',
        }}
      >
        <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
          {question}
        </Typography>
      </Box>

      {/* The answer, unboxed. `pre-line` keeps the model's line breaks. */}
      <Box sx={{ maxWidth: { xs: '100%', sm: '92%' } }}>
        <Typography variant="body2" sx={{ lineHeight: 1.6, whiteSpace: 'pre-line' }}>
          {answer}
        </Typography>

        {chartConfig && !chartHidden && (
          <Box sx={{ mt: 1.5 }}>
            <InsightChart chartConfig={chartConfig} height={chartHeight} />
          </Box>
        )}

        {report && (
          <Box
            sx={{
              mt: 1.5,
              p: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              flexWrap: 'wrap',
            }}
          >
            <DescriptionOutlinedIcon color="primary" />
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {spec?.title ?? 'Report'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {spec
                  ? `${spec.period_label} · ${spec.kpis.length} KPIs · ${spec.blocks.length} blocks`
                  : 'One-page summary'}
                {report.dropped.length > 0 ? ` · not shown: ${report.dropped.join(', ')}` : ''}
              </Typography>
            </Box>
            <Button variant="outlined" onClick={onOpenReport} sx={{ minHeight: 48 }}>
              Open report
            </Button>
          </Box>
        )}

        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
          <Button
            variant="text"
            size="small"
            startIcon={<ContentCopyOutlinedIcon sx={{ fontSize: 16 }} />}
            onClick={copyAnswer}
            sx={{ minHeight: 48 }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {chartConfig && !chartHidden && (
            <Button
              variant="text"
              size="small"
              startIcon={<VisibilityOffOutlinedIcon sx={{ fontSize: 16 }} />}
              onClick={() => setChartHidden(true)}
              sx={{ minHeight: 48 }}
            >
              Hide chart
            </Button>
          )}
          {chartConfig && chartHidden && (
            <Button variant="text" size="small" onClick={() => setChartHidden(false)} sx={{ minHeight: 48 }}>
              Show chart
            </Button>
          )}
        </Stack>

        {/* What to look at next. Newest turn only -- a suggestion under an answer
            three exchanges back is an invitation to lose your place. */}
        {followUps.length > 0 && onFollowUp && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 0.4 }}>
              TRY NEXT
            </Typography>
            {followUps.map((f) => (
              <Chip
                key={f}
                label={f}
                variant="outlined"
                size="small"
                onClick={() => onFollowUp(f)}
                disabled={followUpsDisabled}
                sx={{ cursor: 'pointer', minHeight: 32, '&:hover': { bgcolor: 'action.hover' } }}
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
