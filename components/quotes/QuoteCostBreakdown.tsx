'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import { getQuoteCostBreakdown } from '@/utils/quotesAccess';
import type { QuoteLineItem } from '@/types/quote';
import QuoteCostBreakdownView from './QuoteCostBreakdownView';

interface QuoteCostBreakdownProps {
  quoteId: string;
  companyId: string;
}

export default function QuoteCostBreakdownCard({
  quoteId,
  companyId,
}: QuoteCostBreakdownProps) {
  const [error, setError] = useState<string | null>(null);

  const { data: breakdown, loading } = useLoad(
    () => getQuoteCostBreakdown(quoteId, companyId),
    [quoteId, companyId],
    {
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to load cost breakdown');
      },
    },
  );

  const lineItemsByPart = new Map<string, QuoteLineItem[]>();
  if (breakdown) {
    for (const li of breakdown.line_items) {
      const list = lineItemsByPart.get(li.part_id) || [];
      list.push(li);
      lineItemsByPart.set(li.part_id, list);
    }
  }

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
          Cost Breakdown
        </Typography>
        <Divider sx={{ mb: 2 }} />

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {breakdown && !loading && breakdown.parts.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            This quote has no cost snapshot.
          </Typography>
        )}

        {breakdown && !loading &&
          breakdown.parts.map((part) => {
            const lis = (lineItemsByPart.get(part.part_id) || []).sort(
              (a, b) => a.sequence - b.sequence,
            );
            const partName = lis[0]?.parts?.part_name ?? null;
            return (
              <QuoteCostBreakdownView
                key={part.part_id}
                partName={partName}
                operations={part.operations}
                materials={part.materials}
                lineItems={lis}
              />
            );
          })}
      </CardContent>
    </Card>
  );
}
