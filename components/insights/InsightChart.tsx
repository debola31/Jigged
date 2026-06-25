'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { BarChart } from '@mui/x-charts/BarChart';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import type { ChartConfig } from '@/utils/insightsAccess';

interface InsightChartProps {
  chartConfig: ChartConfig;
  height?: number;
}

/** Format ISO timestamps and date strings into clean short labels. */
function formatLabel(value: string): string {
  if (/^\d{4}-\d{2}/.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      if (date.getDate() === 1 || value.includes('T00:00:00')) {
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  return value.length > 12 ? value.slice(0, 12) + '...' : value;
}

/** Abbreviate large numbers for axis ticks: 7749 -> "7.7K", 1.2e6 -> "1.2M". */
function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(value);
}

/**
 * Wrapper component that renders MUI X Charts based on chart_config.
 * Supports: area, pie, bar, bar_horizontal, sparkline chart types.
 */
export default function InsightChart({ chartConfig, height = 250 }: InsightChartProps) {
  const theme = useTheme();

  const { chart_type, data, x_key, y_key, x_label, y_label } = chartConfig;

  if (!data || data.length === 0) {
    return (
      <Box
        sx={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          No data available for chart
        </Typography>
      </Box>
    );
  }

  // Fail loud if the model's x_key/y_key aren't present on the rows. The server
  // validator should already have dropped such configs, but never silently
  // render blank labels / zero bars (the original "empty chart" bug).
  const hasKeys = data.every((d) => x_key in d && y_key in d);
  if (!hasKeys) {
    return (
      <Box sx={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No chartable data
        </Typography>
      </Box>
    );
  }

  const chartColors = [
    theme.palette.primary.main,
    theme.palette.secondary.main,
    theme.palette.success.main,
    theme.palette.warning.main,
    theme.palette.error.main,
    theme.palette.info.main,
  ];

  // Sort nominal bars by value (descending) for readability; preserve the
  // original order for time series (area) and pie.
  const sortForBars = chart_type === 'bar' || chart_type === 'bar_horizontal';
  const rows = sortForBars
    ? [...data].sort((a, b) => Number(b[y_key] ?? 0) - Number(a[y_key] ?? 0))
    : data;

  // Extract x-axis labels and y-axis values
  const xLabels = rows.map((d) => formatLabel(String(d[x_key] ?? '')));
  const yValues = rows.map((d) => Number(d[y_key] ?? 0));

  if (chart_type === 'area') {
    return (
      <Box sx={{ width: '100%', height }}>
        <LineChart
          xAxis={[
            {
              data: xLabels,
              scaleType: 'point',
              label: x_label,
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          yAxis={[
            {
              label: y_label,
              min: 0,
              valueFormatter: (value: number) => formatCompact(value),
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          series={[
            {
              data: yValues,
              area: true,
              color: chartColors[0],
              showMark: true,
            },
          ]}
          height={height}
          margin={{ top: 20, right: 20, bottom: 50, left: 80 }}
          sx={{
            '& .MuiChartsAxis-line': { stroke: theme.palette.divider },
            '& .MuiChartsAxis-tick': { stroke: theme.palette.divider },
          }}
        />
      </Box>
    );
  }

  if (chart_type === 'pie') {
    const pieData = data.map((d, i) => ({
      id: i,
      value: Number(d[y_key] ?? 0),
      label: String(d[x_key] ?? ''),
      color: chartColors[i % chartColors.length],
    }));

    return (
      <Box sx={{ width: '100%', height }}>
        <PieChart
          series={[
            {
              data: pieData,
              innerRadius: 40,
              paddingAngle: 2,
              cornerRadius: 4,
              highlightScope: { fade: 'global', highlight: 'item' },
            },
          ]}
          height={height}
          margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
          slotProps={{
            legend: {
              labelStyle: { fill: theme.palette.text.primary, fontSize: 12 },
              position: { vertical: 'middle', horizontal: 'right' },
              padding: 0,
              itemMarkWidth: 10,
              itemMarkHeight: 10,
              markGap: 5,
              itemGap: 8,
            },
          }}
        />
      </Box>
    );
  }

  if (chart_type === 'bar') {
    return (
      <Box sx={{ width: '100%', height }}>
        <BarChart
          xAxis={[
            {
              data: xLabels,
              scaleType: 'band',
              label: x_label,
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          yAxis={[
            {
              label: y_label,
              min: 0,
              valueFormatter: (value: number) => formatCompact(value),
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          series={[
            {
              data: yValues,
              color: chartColors[0],
            },
          ]}
          height={height}
          margin={{ top: 20, right: 20, bottom: 50, left: 80 }}
          sx={{
            '& .MuiChartsAxis-line': { stroke: theme.palette.divider },
            '& .MuiChartsAxis-tick': { stroke: theme.palette.divider },
          }}
        />
      </Box>
    );
  }

  if (chart_type === 'bar_horizontal') {
    return (
      <Box sx={{ width: '100%', height }}>
        <BarChart
          yAxis={[
            {
              data: xLabels,
              scaleType: 'band',
              label: x_label,
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          xAxis={[
            {
              label: y_label,
              min: 0,
              valueFormatter: (value: number) => formatCompact(value),
              tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
            },
          ]}
          series={[
            {
              data: yValues,
              color: chartColors[0],
            },
          ]}
          layout="horizontal"
          height={height}
          margin={{ top: 20, right: 20, bottom: 50, left: 100 }}
          sx={{
            '& .MuiChartsAxis-line': { stroke: theme.palette.divider },
            '& .MuiChartsAxis-tick': { stroke: theme.palette.divider },
          }}
        />
      </Box>
    );
  }

  if (chart_type === 'sparkline') {
    return (
      <Box sx={{ width: '100%', height: Math.min(height, 80) }}>
        <SparkLineChart
          data={yValues}
          height={Math.min(height, 80)}
          curve="natural"
          area
          colors={[chartColors[0]]}
        />
      </Box>
    );
  }

  // Fallback for unknown chart types
  return (
    <Box
      sx={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        Unsupported chart type: {chart_type}
      </Typography>
    </Box>
  );
}
