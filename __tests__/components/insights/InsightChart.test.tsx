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

vi.mock('@mui/x-charts/BarChart', () => ({
  // The band axis is echoed so a test can read the order the bars were given in.
  BarChart: (props: { xAxis?: { data?: string[] }[]; yAxis?: { data?: string[] }[] }) => (
    <div data-testid="bar-chart" data-bands={JSON.stringify(props.xAxis?.[0]?.data ?? props.yAxis?.[0]?.data ?? [])} />
  ),
}));
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

  it('ranks nominal bars by value, tallest first', () => {
    render(
      <InsightChart
        chartConfig={makeConfig({
          data: [
            { customer: 'Helix', revenue: 60 },
            { customer: 'Hastings', revenue: 100 },
            { customer: 'Deister', revenue: 80 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('bar-chart').getAttribute('data-bands')).toBe(JSON.stringify(['Hastings', 'Deister', 'Helix']));
  });

  it('keeps calendar order when bars sit on a time axis', () => {
    // "A bar chart of monthly bookings" arrives as bars over dates; ranking those
    // prints Mar, Feb, Jan, Dec. Same predicate as the PDF renderer.
    render(
      <InsightChart
        chartConfig={makeConfig({
          x_key: 'month',
          data: [
            { month: '2026-01-01', revenue: 300 },
            { month: '2026-02-01', revenue: 100 },
            { month: '2026-03-01', revenue: 200 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('bar-chart').getAttribute('data-bands')).toBe(JSON.stringify(['Jan 2026', 'Feb 2026', 'Mar 2026']));
  });

  it('puts month names in calendar order too, however the rows arrived', () => {
    render(
      <InsightChart
        chartConfig={makeConfig({
          x_key: 'month',
          data: [
            { month: 'August', revenue: 19606 },
            { month: 'September', revenue: 16282 },
            { month: 'July', revenue: 14617 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('bar-chart').getAttribute('data-bands')).toBe(JSON.stringify(['July', 'August', 'September']));
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
