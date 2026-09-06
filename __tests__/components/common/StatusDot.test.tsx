import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';
import StatusDot from '@/components/common/StatusDot';

const draw = (props: Parameters<typeof StatusDot>[0]) =>
  render(
    <ThemeProvider theme={jiggedTheme}>
      <StatusDot {...props} />
    </ThemeProvider>,
  );

describe('StatusDot', () => {
  it('ALWAYS renders the label, which is the second encoding and the point', () => {
    // The hue is the shortcut for someone scanning; the word is what survives
    // when it does not land. A colour-only treatment was considered and rejected
    // on exactly this -- roughly one man in twelve has a red-green deficiency,
    // and these lists are read almost entirely by men over fifty.
    draw({ label: 'Partially Shipped', color: 'secondary' });
    expect(screen.getByText('Partially Shipped')).toBeInTheDocument();
  });

  it('renders the neutral state hollow, mirroring StatusChip outlining it', () => {
    const { container } = draw({ label: 'Not Started' });
    const dot = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    // No fill: an "off" state must not carry a live state's visual weight.
    // jsdom resolves an unset background to transparent rather than ''.
    expect(dot).toBeTruthy();
    expect(getComputedStyle(dot).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('fills the dot for a semantic colour', () => {
    const { container } = draw({ label: 'In Progress', color: 'info' });
    const dot = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(getComputedStyle(dot).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('hides the dot from assistive tech — the label already names the state', () => {
    const { container } = draw({ label: 'Completed', color: 'success' });
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('does not wrap the label, so a row cannot grow a second line', () => {
    // Two chips in this cell wrapping onto a second line is what the dot replaced.
    draw({ label: 'Partially Shipped', color: 'secondary' });
    expect(getComputedStyle(screen.getByText('Partially Shipped')).whiteSpace).toBe('nowrap');
  });
});
