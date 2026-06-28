import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import AcceptPurchaseOrderModal from '@/components/jobs/AcceptPurchaseOrderModal';
import { getCustomersForSelect } from '@/utils/jobsAccess';

vi.mock('@/utils/jobsAccess', () => ({
  getCustomersForSelect: vi.fn(),
  createJobFromPurchaseOrder: vi.fn(),
}));
vi.mock('@/utils/jobAttachmentsAccess', () => ({ uploadJobAttachment: vi.fn() }));
vi.mock('@/utils/partPricingTiersAccess', () => ({ getTiersWithComputedPrices: vi.fn() }));
vi.mock('@/utils/quotePricingResolver', () => ({ resolveTier: vi.fn() }));
// Stub the heavy line-editor children — they fetch/render complex trees and
// aren't part of the reset-on-open behavior under test here.
vi.mock('@/components/parts/PartAutocomplete', () => ({
  default: () => <div data-testid="part-autocomplete" />,
}));
vi.mock('@/components/jobs/AttachmentUploadField', () => ({
  default: () => <div data-testid="attachment-upload" />,
}));

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const props = { companyId: 'co1', onClose: vi.fn(), onCreated: vi.fn() };
const poField = () => screen.getByLabelText(/customer po/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  (getCustomersForSelect as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'c1', name: 'Acme Corp' },
  ]);
});

describe('AcceptPurchaseOrderModal — reset + load on (re)open', () => {
  it('reloads customers and clears the PO field each time the modal reopens', async () => {
    const { rerender } = render(wrap(<AcceptPurchaseOrderModal open {...props} />));

    // onEnter loads the customer list on open.
    await waitFor(() => expect(getCustomersForSelect).toHaveBeenCalledTimes(1));

    await userEvent.type(poField(), 'PO-123');
    expect(poField().value).toBe('PO-123');

    // Close, then reopen — onEnter must wipe the form and reload customers,
    // never carry over the previous PO number.
    rerender(wrap(<AcceptPurchaseOrderModal open={false} {...props} />));
    rerender(wrap(<AcceptPurchaseOrderModal open {...props} />));

    await waitFor(() => expect(poField().value).toBe(''));
    expect(getCustomersForSelect).toHaveBeenCalledTimes(2);
  });
});
