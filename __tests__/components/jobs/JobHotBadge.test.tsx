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
});
