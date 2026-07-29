'use client';

/**
 * "Short for this week" — the shop-wide half of journey J4.
 *
 * Same computation as the job card, aggregated across every open job. The distinction that
 * makes this worth a page: a job card compares ONE job to the whole shop's stock, so two jobs
 * each needing 10 against 15 on hand both read "not short". Only here does that conflict
 * become visible.
 *
 * The window only ever ADDS jobs — overdue, hot and undated open jobs are in scope whatever is
 * selected. A "this week" view that hides last week's late job, or the rush job that is the
 * entire reason this feature exists, would be worse than no view.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import NextLink from 'next/link';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';

import { useLoad } from '@/hooks/useLoad';
import { getShopMaterialShortages } from '@/utils/materialCheckAccess';
import type { PartShortage, ShortageWindow } from '@/types/materialCheck';

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

const NUM_SX = { fontVariantNumeric: 'tabular-nums' as const };

const WINDOWS: Array<{ value: ShortageWindow; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'Next 30 days' },
  { value: 'all', label: 'All open' },
];

function formatDate(value: string | null): string {
  if (!value) return 'No due date';
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function InventoryShortagesPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const [window, setWindow] = useState<ShortageWindow>('week');

  const { data, loading, error } = useLoad(
    () => getShopMaterialShortages(companyId, window),
    [companyId, window],
  );

  const shortages = useMemo(() => data?.shortages ?? [], [data]);
  const short = shortages.filter((s) => s.status === 'short');
  const odd = shortages.filter((s) => s.status === 'incomparable');

  return (
    <Box>
      <Button
        component={NextLink}
        href={`/dashboard/${companyId}/inventory`}
        startIcon={<ArrowBackIcon />}
        sx={{ mb: 2 }}
      >
        Back to inventory
      </Button>

      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        What open jobs need that you don&apos;t have
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mt: 2, mb: 1 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={window}
          onChange={(_, v: ShortageWindow | null) => v && setWindow(v)}
        >
          {WINDOWS.map((w) => (
            <ToggleButton key={w.value} value={w.value}>{w.label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        {loading && <CircularProgress size={18} />}
      </Box>

      {/* Never leave "this week" ambiguous — say the date it resolved to. */}
      {data && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {data.rangeEnd ? `Due on or before ${formatDate(data.rangeEnd)}` : 'Every open job'}
          {' · plus overdue, hot and undated open jobs · '}
          {data.jobCount} {data.jobCount === 1 ? 'job' : 'jobs'}
        </Typography>
      )}

      {/* useLoad types `error` as unknown, so coerce before rendering. */}
      {Boolean(error) && (
        <Alert severity="error" sx={{ mb: 2 }}>Could not work out shortages.</Alert>
      )}

      {!loading && short.length === 0 && (
        <Card elevation={2}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CheckCircleOutlineIcon color="success" />
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                Nothing is short.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Every material these jobs need is on hand.
              </Typography>
            </Box>
          </CardContent>
        </Card>
      )}

      {short.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {short.map((s) => (
            <ShortageCard key={s.partId} shortage={s} companyId={companyId} />
          ))}
        </Box>
      )}

      {/* Kept separate and BELOW: an unmeasurable material must never sit silently in the
          "you're fine" bucket. */}
      {odd.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="overline" color="text.secondary">
            Can&apos;t compare units ({odd.length})
          </Typography>
          <Card elevation={2} sx={{ mt: 0.5 }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                These are measured differently on the BOM than in stock, so we can&apos;t say
                whether you have enough. Add a unit conversion on the part to fix it.
              </Typography>
              {odd.map((s, i) => (
                <Box key={s.partId}>
                  {i > 0 && <Divider sx={{ my: 1 }} />}
                  <Typography
                    variant="body2"
                    component={NextLink}
                    href={`/dashboard/${companyId}/parts/${s.partId}`}
                    sx={{ fontWeight: 500, color: 'inherit', textDecoration: 'none' }}
                  >
                    {s.partName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {s.incomparableJobCount} {s.incomparableJobCount === 1 ? 'job' : 'jobs'} affected
                  </Typography>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Box>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
        Top-level materials only — sub-assemblies are not exploded.
      </Typography>
    </Box>
  );
}

function ShortageCard({ shortage: s, companyId }: { shortage: PartShortage; companyId: string }) {
  const unit = s.stockUnit ?? '';
  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography
            variant="body1"
            component={NextLink}
            href={`/dashboard/${companyId}/parts/${s.partId}`}
            sx={{ fontWeight: 600, color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
          >
            {s.partName}
          </Typography>
          <Chip
            size="small"
            color="warning"
            label={`Short ${fmt(s.shortBy ?? 0)} ${unit}`}
            sx={NUM_SX}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2" color="text.secondary" sx={NUM_SX}>
            {fmt(s.totalRequired ?? 0)} needed · {fmt(s.onHand)} on hand
            {s.totalIssued > 0 && ` · ${fmt(s.totalIssued)} already taken`}
          </Typography>
        </Box>

        <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {s.contributions.map((c) => (
            <Box
              key={`${c.jobId}:${c.jobPartId}`}
              sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Typography
                variant="body2"
                component={NextLink}
                href={`/dashboard/${companyId}/jobs/${c.jobId}`}
                sx={{ color: 'primary.main', textDecoration: 'none' }}
              >
                {c.jobNumber}
              </Typography>
              {c.isHot && <Chip size="small" color="error" variant="outlined" label="HOT" />}
              <Typography variant="caption" color="text.secondary">
                {c.madePartName ?? '—'} · {formatDate(c.dueDate)}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Typography variant="caption" color="text.secondary" sx={NUM_SX}>
                {c.required === null ? '—' : `${fmt(c.required)} ${unit}`}
              </Typography>
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
