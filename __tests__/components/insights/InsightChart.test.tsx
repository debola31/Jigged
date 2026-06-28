/**
 * InsightChart renders an @mui/x-charts chart from a chart_config. These tests
 * assert the Phase-3 "fail-loud" guards: a blank or key-mismatched config must
 * show an explicit empty state, never silently render blank labels / zero bars
 * (the original "empty chart" bug). The x-charts components are stubbed so the
 * tests are deterministic and don't depend on jsdom layout / ResizeObserver.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../test-utils';
import InsightChart from '@/components/insights/InsightChart';
import type { ChartConfig } from '@/utils/insightsAccess';

vi.mock('@mui/x-charts/BarChart', () => ({ BarChart: () => <div data-testid="bar-chart" /> }));
vi.mock('@mui/x-charts/LineChart', () => ({ LineChart: () => <div data-testid="line-chart" /> }));
vi.mock('@mui/x-charts/PieChart', () => ({ PieChart: () => <div data-testid="pie-chart" /> }));
vi.mock('@mui/x-charts/SparkLineChart', () => ({
  SparkLineChart: () => <div data-testid="spark-chart" />,
}));

function makeConfig(over: Partial<ChartConfig> = {}): ChartConfig {
  return {
    chart_type: 'bar',
    x_key: 'customer',
    y_key: 'revenue',
    data: [
      { customer: 'A', revenue: 100 },
      { customer: 'B', revenue: 80 },
      { customer: 'C', revenue: 60 },
    ],
    x_label: 'Customer',
    y_label: 'Revenue ($)',
    ...over,
  };
}

describe('InsightChart', () => {
  it('shows an empty state when there is no data', () => {
    render(<InsightChart chartConfig={makeConfig({ data: [] })} />);
    expect(screen.getByText('No data available for chart')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).toBeNull();
  });

  it('fails loud (no blank chart) when x_key/y_key are missing from the rows', () => {
    render(
      <InsightChart
        chartConfig={makeConfig({
          data: [
            { name: 'A', value: 100 },
            { name: 'B', value: 80 },
          ],
        })}
      />,
    );
    expect(screen.getByText('No chartable data')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).toBeNull();
  });

  it('renders the chart (no fallback text) for a valid config', () => {
    render(<InsightChart chartConfig={makeConfig()} />);
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.queryByText('No chartable data')).toBeNull();
    expect(screen.queryByText('No data available for chart')).toBeNull();
  });

  it('renders an area chart for a temporal config', () => {
    render(
      <InsightChart
        chartConfig={makeConfig({
          chart_type: 'area',
          x_key: 'week',
          data: [
            { week: '2026-01-01', revenue: 100 },
            { week: '2026-02-01', revenue: 120 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });
});
