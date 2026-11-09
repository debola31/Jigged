import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor, within } from '../../test-utils';
import AiAssistantsPanel from '@/components/aiAssistants/AiAssistantsPanel';

/**
 * The AI assistants page: start connecting Claude or ChatGPT, and see or disconnect the
 * assistants already connected.
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

  it("opens Claude's add-connector dialog already filled in with this server", async () => {
    render(<AiAssistantsPanel />);
    const link = screen.getByRole('link', { name: /Add to Claude/ });
    const href = new URL(link.getAttribute('href') ?? '');
    expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
    expect(href.searchParams.get('modal')).toBe('add-custom-connector');
    expect(href.searchParams.get('connectorName')).toBe('Jigged');
    expect(href.searchParams.get('connectorUrl')).toBe(`${window.location.origin}/mcp`);
    expect(link).toHaveAttribute('target', '_blank');
    await userEvent.click(link);
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'claude' });
  });

  it('copies the server link and opens ChatGPT', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<AiAssistantsPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Copy link & open ChatGPT/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`));
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'chatgpt' });
    open.mockRestore();
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
