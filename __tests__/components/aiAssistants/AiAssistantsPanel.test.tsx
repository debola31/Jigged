import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor, within } from '../../test-utils';
import AiAssistantsPanel from '@/components/aiAssistants/AiAssistantsPanel';

/**
 * The AI assistants page: the assistants already connected, and disconnecting one.
 */

const mockList = vi.fn();
const mockDisconnect = vi.fn();
vi.mock('@/utils/aiAssistantAccess', () => ({
  listConnectedAssistants: (...a: unknown[]) => mockList(...a),
  disconnectAssistant: (...a: unknown[]) => mockDisconnect(...a),
}));

const mockCapture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const CLAUDE = {
  client: { id: 'client-claude', name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
  scopes: ['email'],
  granted_at: '2026-11-09T14:20:00Z',
};

describe('AiAssistantsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([CLAUDE]);
    mockDisconnect.mockResolvedValue(undefined);
  });

  it('offers the connect menu in its header', () => {
    render(<AiAssistantsPanel />);
    expect(screen.getByRole('button', { name: 'Connect your assistant' })).toBeInTheDocument();
  });

  it('lists each connected assistant with when it was connected', async () => {
    render(<AiAssistantsPanel />);
    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.getByText(/^Connected .*2026/)).toBeInTheDocument();
  });

  it('says so when nothing is connected', async () => {
    mockList.mockResolvedValue([]);
    render(<AiAssistantsPanel />);
    expect(await screen.findByText('No assistants connected yet.')).toBeInTheDocument();
  });

  it('disconnects only after confirming, then refreshes the list', async () => {
    render(<AiAssistantsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Claude?' });
    expect(mockDisconnect).not.toHaveBeenCalled();

    mockList.mockResolvedValue([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith('client-claude'));
    expect(mockCapture).toHaveBeenCalledWith('ai assistant disconnected', { client_kind: 'claude' });
    expect(await screen.findByText('No assistants connected yet.')).toBeInTheDocument();
  });

  it('keeps the dialog open with the reason when disconnecting fails', async () => {
    mockDisconnect.mockRejectedValue(new Error('network down'));
    render(<AiAssistantsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(mockCapture).not.toHaveBeenCalledWith('ai assistant disconnected', expect.anything());
  });
});
