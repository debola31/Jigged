import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import JobHotBadge from '@/components/jobs/JobHotBadge';

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

describe('JobHotBadge', () => {
  it('renders a HOT chip with the flame icon when the job is hot', () => {
    render(wrap(<JobHotBadge job={{ is_hot: true }} />));
    expect(screen.getByText('HOT')).toBeInTheDocument();
    // The flame icon carries the MUI test id for LocalFireDepartment.
    expect(screen.getByTestId('LocalFireDepartmentIcon')).toBeInTheDocument();
  });

  it('renders nothing when the job is not hot', () => {
    const { container } = render(wrap(<JobHotBadge job={{ is_hot: false }} />));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when is_hot is null/undefined', () => {
    const { container } = render(wrap(<JobHotBadge job={{ is_hot: null }} />));
    expect(container).toBeEmptyDOMElement();
  });

  it('is a solid (filled) chip by default — the loud "prioritize now" register', () => {
    const { container } = render(wrap(<JobHotBadge job={{ is_hot: true }} />));
    const chip = container.querySelector('.MuiChip-root');
    expect(chip?.className).toContain('MuiChip-filled');
    expect(chip?.className).not.toContain('MuiChip-outlined');
  });

  it('drops to an outlined "was hot" chip when muted (closed job)', () => {
    const { container } = render(wrap(<JobHotBadge job={{ is_hot: true }} muted />));
    // Still shows HOT (history preserved) but in the quieter outlined register.
    expect(screen.getByText('HOT')).toBeInTheDocument();
    const chip = container.querySelector('.MuiChip-root');
    expect(chip?.className).toContain('MuiChip-outlined');
    expect(chip?.className).not.toContain('MuiChip-filled');
  });
});
