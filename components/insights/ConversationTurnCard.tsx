'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import InsightChart from './InsightChart';
import type { ReportTurn } from '@/utils/aiChatAccess';
import type { ChartConfig } from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

interface ConversationTurnCardProps {
  question: string;
  answer: string;
  chartConfig: ChartConfig | null;
  /** Set when this turn is a one-page report: the answer is its headline. */
  report?: ReportTurn | null;
  /** Chart height in pixels. */
  chartHeight?: number;
  /** Opens the report's preview (the PDF, drawn from the stored spec). */
  onOpenReport?: () => void;
}

/**
 * One answered turn of a conversation: the question, the answer, then the chart
 * it introduces, or the report card when the turn was a request for a one-pager.
 *
 * No pin button since 2026-09-08. A chart is kept by having been answered -- the
 * History rail lists every turn that carried one -- so there is nothing to save.
 */
export default function ConversationTurnCard({
  question,
  answer,
  chartConfig,
  report = null,
  chartHeight = 220,
  onOpenReport,
}: ConversationTurnCardProps) {
  const spec = report ? reportSpecOf(report.report) : null;

  return (
    <Card elevation={2} sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
        <Typography variant="caption" color="primary.main" sx={{ fontWeight: 600, flex: 1 }}>
          {question}
        </Typography>
      </Box>

      {/* The answer first, then the chart it introduces: the model narrates and then
          says "here is the chart". `pre-line` keeps the model's line breaks. */}
      <Typography variant="body2" sx={{ lineHeight: 1.6, whiteSpace: 'pre-line' }}>
        {answer}
      </Typography>

      {chartConfig && (
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
    </Card>
  );
}
