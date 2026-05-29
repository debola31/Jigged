import { describe, it, expect } from 'vitest';
import { render, screen } from '../../test-utils';
import ConfidenceChip from '@/components/import/ConfidenceChip';

/**
 * ConfidenceChip rules:
 *   isManual → "Manual" + "Selected by user" tooltip
 *   confidence ≥ 0.8 → color="success", label="{pct}%"
 *   confidence ≥ 0.5 → color="warning"
 *   confidence < 0.5 → color="error"
 *   reasoning prop wraps the chip in a Tooltip
 *
 * Asserting on the rendered color class avoids depending on MUI internals;
 * the chip role is exposed via role="generic" by MUI, so we anchor on label
 * text + class names.
 */
describe('ConfidenceChip', () => {
  it('renders the percentage label for high-confidence scores', () => {
    render(<ConfidenceChip confidence={0.95} />);
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('renders the percentage label for medium-confidence scores', () => {
    render(<ConfidenceChip confidence={0.65} />);
    expect(screen.getByText('65%')).toBeInTheDocument();
  });

  it('renders the percentage label for low-confidence scores', () => {
    render(<ConfidenceChip confidence={0.30} />);
    expect(screen.getByText('30%')).toBeInTheDocument();
  });

  it('uses success color at exactly the 0.8 threshold', () => {
    const { container } = render(<ConfidenceChip confidence={0.8} />);
    const chip = container.querySelector('.MuiChip-colorSuccess');
    expect(chip).not.toBeNull();
  });

  it('uses warning color at exactly the 0.5 threshold (below 0.8)', () => {
    const { container } = render(<ConfidenceChip confidence={0.5} />);
    const chip = container.querySelector('.MuiChip-colorWarning');
    expect(chip).not.toBeNull();
  });

  it('uses error color just below 0.5', () => {
    const { container } = render(<ConfidenceChip confidence={0.49} />);
    const chip = container.querySelector('.MuiChip-colorError');
    expect(chip).not.toBeNull();
  });

  it('rounds confidence to nearest whole percent', () => {
    render(<ConfidenceChip confidence={0.756} />);
    expect(screen.getByText('76%')).toBeInTheDocument();
  });

  it('shows the Manual chip + tooltip when isManual=true regardless of confidence', () => {
    render(<ConfidenceChip confidence={0.42} isManual />);
    expect(screen.getByText('Manual')).toBeInTheDocument();
    // Confidence label suppressed.
    expect(screen.queryByText('42%')).not.toBeInTheDocument();
  });

  it('honors the size prop (medium) on the chip element', () => {
    const { container } = render(<ConfidenceChip confidence={0.9} size="medium" />);
    // MUI uses .MuiChip-sizeSmall by default; medium drops that class.
    expect(container.querySelector('.MuiChip-sizeSmall')).toBeNull();
  });
});
