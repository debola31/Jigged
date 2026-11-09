import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '../../test-utils';
import AiAssistantsCard from '@/components/settings/AiAssistantsCard';

/**
 * Settings → AI assistants: a company admin decides whether assistants may work here at all, and
 * whether they may change anything. Each switch saves on change.
 */

const mockGetCompany = vi.fn();
vi.mock('@/utils/companyAccess', () => ({ getCompany: (...a: unknown[]) => mockGetCompany(...a) }));

const mockSetAccess = vi.fn();
vi.mock('@/utils/aiAssistantAccess', () => ({ setAssistantAccess: (...a: unknown[]) => mockSetAccess(...a) }));

const mockCapture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const company = (features: Record<string, boolean>) => ({ id: 'co-1', name: 'Acme', settings: { features } });

describe('AiAssistantsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCompany.mockResolvedValue(company({}));
    mockSetAccess.mockResolvedValue(undefined);
  });

  it('shows both switches on by default', async () => {
    render(<AiAssistantsCard companyId="co-1" />);
    expect(await screen.findByRole('switch', { name: /Allow AI assistants/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Allow changes/ })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Connect your assistant' })).toHaveAttribute(
      'href',
      '/dashboard/co-1/ai-assistants',
    );
  });

  it('turning assistants off saves it and greys out the changes switch', async () => {
    render(<AiAssistantsCard companyId="co-1" />);
    await userEvent.click(await screen.findByRole('switch', { name: /Allow AI assistants/ }));
    await waitFor(() =>
      expect(mockSetAccess).toHaveBeenCalledWith('co-1', { ai_assistants: false, ai_assistant_writes: true }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Allow changes/ })).toBeDisabled();
    expect(mockCapture).toHaveBeenCalledWith('ai assistant access changed', {
      ai_assistants: false,
      ai_assistant_writes: true,
    });
  });

  it('read-only is the changes switch alone', async () => {
    render(<AiAssistantsCard companyId="co-1" />);
    await userEvent.click(await screen.findByRole('switch', { name: /Allow changes/ }));
    await waitFor(() =>
      expect(mockSetAccess).toHaveBeenCalledWith('co-1', { ai_assistants: true, ai_assistant_writes: false }),
    );
  });

  it('reflects a company that already turned assistants off', async () => {
    mockGetCompany.mockResolvedValue(company({ ai_assistants: false }));
    render(<AiAssistantsCard companyId="co-1" />);
    expect(await screen.findByRole('switch', { name: /Allow AI assistants/ })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Allow changes/ })).toBeDisabled();
  });

  it('puts the switch back and says so when the save fails', async () => {
    mockSetAccess.mockRejectedValue(new Error('denied'));
    render(<AiAssistantsCard companyId="co-1" />);
    const toggle = await screen.findByRole('switch', { name: /Allow AI assistants/ });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
