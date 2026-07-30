import { describe, it, expect } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import MachineDetailsCard from '@/components/maintenance/MachineDetailsCard';

const empty = {
  make: null,
  model: null,
  serial_number: null,
  year_built: null,
  purchased_on: null,
};

describe('MachineDetailsCard', () => {
  // §4.5, enforced. Asset data entry is a leading cause of CMMS abandonment: the
  // tool arrives, the shop is asked to describe its equipment before it can do
  // anything, and the project dies in the describing. A machine with nothing
  // filled in has to look FINISHED, because it is.
  it('renders nothing when no detail has been filled in', () => {
    const { container } = render(<MachineDetailsCard details={empty} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the machine has no detail row at all', () => {
    const { container } = render(<MachineDetailsCard details={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never prompts, nudges, or measures how complete it is', () => {
    const { container } = render(<MachineDetailsCard details={empty} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows only the fields somebody actually filled in', () => {
    render(<MachineDetailsCard details={{ ...empty, make: 'Haas', serial_number: '1104321' }} />);

    expect(screen.getByText('Haas')).toBeInTheDocument();
    expect(screen.getByText('1104321')).toBeInTheDocument();
    // No "Model —" placeholder row: an absent field is absent, not blank.
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
    expect(screen.queryByText('Year')).not.toBeInTheDocument();
  });

  it('shows the year and purchase date when they are known', () => {
    render(
      <MachineDetailsCard
        details={{ ...empty, year_built: 2014, purchased_on: '2016-03-08' }}
      />,
    );

    expect(screen.getByText('2014')).toBeInTheDocument();
    expect(screen.getByText(/2016/)).toBeInTheDocument();
  });
});
