import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@/__tests__/test-utils';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const submitWaitlist = vi.fn();
vi.mock('@/app/actions/waitlist', () => ({ submitWaitlist: (...args: unknown[]) => submitWaitlist(...args) }));
const reportWaitlistSubmitFailure = vi.fn(() => false);
vi.mock('@/lib/serverActionSkew', () => ({
  reportWaitlistSubmitFailure: (...args: unknown[]) => reportWaitlistSubmitFailure(...(args as [])),
  SKEW_ALERT_MESSAGE: 'This page is out of date. Reload it and try again.',
  GENERIC_ALERT_MESSAGE: 'Something went wrong. Please try again.',
}));

import posthog from 'posthog-js';
import InterestForm from '@/app/(marketing)/showcase/_components/InterestForm';

function chooseFile(container: HTMLElement, name = 'bracket.step') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(64)], name)] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  submitWaitlist.mockResolvedValue({ success: true });
});

describe('InterestForm', () => {
  it('asks only for the file until one is chosen', () => {
    render(<InterestForm />);
    expect(screen.getByRole('button', { name: 'Choose your part file' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
  });

  it('refuses a format it cannot take, at the field', () => {
    const { container } = render(<InterestForm />);
    chooseFile(container, 'model.stl');
    expect(screen.getByText(/model\.stl/)).toHaveTextContent(/Choose a STEP, IGES, Parasolid/);
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
  });

  it('says the file is not uploaded, and what is missing before anything is chosen', () => {
    const { container } = render(<InterestForm />);
    chooseFile(container);
    expect(screen.getByText(/Your file stays on your computer: we don't upload it/)).toBeInTheDocument();
    expect(screen.getByText(/Choose what you would like/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('joins the pilot on the waitlist with name, business and email, and records only the shape', async () => {
    const user = userEvent.setup();
    const { container } = render(<InterestForm />);
    chooseFile(container);
    await user.click(screen.getByRole('radio', { name: /Join the pilot/ }));
    await user.type(screen.getByLabelText(/Name/), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/Business/), 'Cedar Ridge Machine');
    await user.type(screen.getByLabelText(/Email/), ' Ada@Example.com ');
    await user.click(screen.getByRole('button', { name: 'Join the pilot' }));

    await waitFor(() => expect(screen.getByText("Thanks — you're in the pilot.")).toBeInTheDocument());
    expect(submitWaitlist).toHaveBeenCalledWith({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      company_name: 'Cedar Ridge Machine',
      shop_size: null,
      source: 'showcase_pilot',
    });
    // Never the name, business, email or file.
    expect(posthog.capture).toHaveBeenCalledWith('waitlist submitted', { source: 'showcase_pilot', shop_size: null });
  });

  it('records a feature request under its own source', async () => {
    const user = userEvent.setup();
    const { container } = render(<InterestForm />);
    chooseFile(container);
    await user.click(screen.getByRole('radio', { name: /Request this feature/ }));
    await user.type(screen.getByLabelText(/Name/), 'Ada');
    await user.type(screen.getByLabelText(/Business/), 'Cedar Ridge');
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Request it' }));

    await waitFor(() => expect(screen.getByText("Thanks — you're on the list.")).toBeInTheDocument());
    expect(submitWaitlist).toHaveBeenCalledWith(expect.objectContaining({ source: 'showcase_feature_request' }));
  });

  it('shows an error and keeps the form when the waitlist refuses', async () => {
    submitWaitlist.mockResolvedValue({ error: 'Failed to submit' });
    const user = userEvent.setup();
    const { container } = render(<InterestForm />);
    chooseFile(container);
    await user.click(screen.getByRole('radio', { name: /Request this feature/ }));
    await user.type(screen.getByLabelText(/Name/), 'Ada');
    await user.type(screen.getByLabelText(/Business/), 'Cedar Ridge');
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Request it' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.'));
    expect(reportWaitlistSubmitFailure).toHaveBeenCalledWith(expect.any(Error), 'showcase_feature_request');
    expect(screen.getByRole('button', { name: 'Request it' })).toBeEnabled();
  });
});
