import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import AcceptPurchaseOrderModal from '@/components/jobs/AcceptPurchaseOrderModal';

vi.mock('@/utils/jobsAccess', () => ({
  getCustomersForSelect: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Acme Machining' }]),
  createJobFromPurchaseOrder: vi.fn(),
}));
vi.mock('@/utils/jobAttachmentsAccess', () => ({ uploadJobAttachment: vi.fn() }));
vi.mock('@/utils/partPricingTiersAccess', () => ({ getTiersWithComputedPrices: vi.fn() }));
vi.mock('@/utils/quotePricingResolver', () => ({ resolveTier: vi.fn() }));
// The line editor's children are irrelevant to due-date validation timing.
vi.mock('@/components/parts/PartAutocomplete', () => ({
  default: () => <div data-testid="part-autocomplete" />,
}));
vi.mock('@/components/jobs/AttachmentUploadField', () => ({
  default: () => <div data-testid="attachment-upload" />,
}));

const props = { companyId: 'c1', onClose: vi.fn(), onCreated: vi.fn() };
const dueField = () => screen.getByLabelText(/due date/i) as HTMLInputElement;
const submitButton = () => screen.getByRole('button', { name: /accept & create job/i });

// Comfortably in the future, so the "can't be in the past" rule never fires
// here no matter when the suite runs.
const FUTURE = '2099-12-31';

beforeEach(() => vi.clearAllMocks());

describe('AcceptPurchaseOrderModal — due date validation timing', () => {
  it('does not flag the empty due date on open — the disabled submit already blocks it', () => {
    render(<AcceptPurchaseOrderModal open {...props} />);

    expect(dueField()).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText('Due date is required')).not.toBeInTheDocument();
    // The gate the red field would be duplicating.
    expect(submitButton()).toBeDisabled();
  });

  it('flags it once the user has been in the field and left it blank', async () => {
    const user = userEvent.setup();
    render(<AcceptPurchaseOrderModal open {...props} />);

    await user.click(dueField());
    await user.tab();

    await waitFor(() => expect(dueField()).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Due date is required')).toBeInTheDocument();
  });

  it('clears the flag when a valid date is entered', async () => {
    const user = userEvent.setup();
    render(<AcceptPurchaseOrderModal open {...props} />);

    await user.click(dueField());
    await user.tab();
    await waitFor(() => expect(dueField()).toHaveAttribute('aria-invalid', 'true'));

    fireEvent.change(dueField(), { target: { value: FUTURE } });

    await waitFor(() => expect(dueField()).toHaveAttribute('aria-invalid', 'false'));
    expect(screen.queryByText('Due date is required')).not.toBeInTheDocument();
  });

  it('still rejects a past date immediately, without waiting for a blur', async () => {
    render(<AcceptPurchaseOrderModal open {...props} />);

    fireEvent.change(dueField(), { target: { value: '2020-01-01' } });

    await waitFor(() => expect(dueField()).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText("Due date can't be in the past")).toBeInTheDocument();
  });
});
