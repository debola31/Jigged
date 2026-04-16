'use client';

import { useEffect, useState } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import { getQuoteCostBreakdown } from '@/utils/quotesAccess';
import type { QuoteCostBreakdown } from '@/types/quote';
import QuoteCostBreakdownView from './QuoteCostBreakdownView';

interface QuoteCostBreakdownProps {
  quoteId: string;
  companyId: string;
  quantity: number;
}

export default function QuoteCostBreakdownCard({
  quoteId,
  companyId,
  quantity,
}: QuoteCostBreakdownProps) {
  const [breakdown, setBreakdown] = useState<QuoteCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getQuoteCostBreakdown(quoteId, companyId)
      .then((data) => {
        if (!cancelled) setBreakdown(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load cost breakdown');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quoteId, companyId]);

  const hasOverride =
    breakdown?.override_per_unit !== null &&
    breakdown?.override_per_unit !== undefined &&
    Math.abs(breakdown.override_per_unit) >= 0.005;

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Cost Breakdown
          </Typography>
          {hasOverride && (
            <Typography variant="caption" color="warning.main">
              Price overridden
            </Typography>
          )}
        </Box>
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

        {breakdown && !loading && (
          <QuoteCostBreakdownView
            operations={breakdown.operations.map((o) => ({
              key: o.id,
              operation_name: o.operation_name,
              run_time_minutes: o.run_time_minutes,
              setup_time_minutes: o.setup_time_minutes,
              labor_rate: o.labor_rate,
              run_cost: o.run_cost,
              setup_cost: o.setup_cost,
            }))}
            materials={breakdown.materials.map((m) => ({
              key: m.id,
              item_name: m.item_name,
              quantity: m.quantity,
              unit: m.unit,
              cost_per_unit: m.cost_per_unit,
              line_cost: m.line_cost,
            }))}
            quantity={quantity}
            baseCost={breakdown.base_cost}
            markupPercent={breakdown.markup_percent}
            computedUnitPrice={breakdown.computed_unit_price}
            actualUnitPrice={breakdown.actual_unit_price}
          />
        )}
      </CardContent>
    </Card>
  );
}
