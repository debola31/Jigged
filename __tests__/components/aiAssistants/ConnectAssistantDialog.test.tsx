import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor, within } from '../../test-utils';
import ConnectAssistantButton from '@/components/aiAssistants/ConnectAssistantDialog';

/**
 * "Connect your assistant": a dialog with a Claude card and a ChatGPT card, each with its steps,
 * the server URL and its own way in, opened in place rather than on another page.
 */

const mockCapture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const SERVER = `${window.location.origin}/mcp`;

async function openDialog() {
  render(<ConnectAssistantButton />);
  await userEvent.click(screen.getByRole('button', { name: 'Connect your assistant' }));
  return screen.findByRole('dialog', { name: /Connect your assistant/ });
}

describe('ConnectAssistantButton', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  it('shows both assistants with three steps each and the server URL', async () => {
    const dialog = await openDialog();
    for (const name of ['Claude', 'ChatGPT']) {
      const card = within(dialog).getByRole('region', { name });
      expect(within(card).getAllByRole('listitem')).toHaveLength(3);
      expect(within(card).getByText(SERVER)).toBeInTheDocument();
    }
  });

  it("opens Claude's add-connector dialog already filled in with this server", async () => {
    const dialog = await openDialog();
    const claude = within(dialog).getByRole('region', { name: 'Claude' });
    const link = within(claude).getByRole('link', { name: /Add to Claude/ });
    const href = new URL(link.getAttribute('href') ?? '');
    expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
    expect(href.searchParams.get('modal')).toBe('add-custom-connector');
    expect(href.searchParams.get('connectorName')).toBe('Jigged');
    expect(href.searchParams.get('connectorUrl')).toBe(SERVER);
    expect(link).toHaveAttribute('target', '_blank');
    // The steps Jigged can't do for the person: Connect and Allow, and the per-chat switch.
    expect(claude).toHaveTextContent('Connect, sign in to Jigged and click Allow');
    expect(claude).toHaveTextContent('+ → Connectors');
    await userEvent.click(link);
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'claude' });
  });

  it("copies the URL and opens ChatGPT's Plugins page, with its steps written out", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const dialog = await openDialog();
    const chatgpt = within(dialog).getByRole('region', { name: 'ChatGPT' });
    expect(chatgpt).toHaveTextContent('Add custom MCP server');
    expect(chatgpt).toHaveTextContent('OAuth');
    expect(chatgpt).toHaveTextContent('Create as a plugin');
    await userEvent.click(within(chatgpt).getByRole('button', { name: /Open ChatGPT/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVER));
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/plugins', '_blank', 'noopener,noreferrer');
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'chatgpt' });
    expect(await screen.findByText('URL copied')).toBeInTheDocument();
    open.mockRestore();
  });

  it('copies the URL from either card, counted under that assistant', async () => {
    const dialog = await openDialog();
    await userEvent.click(within(within(dialog).getByRole('region', { name: 'Claude' })).getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVER));
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'claude' });
  });

  it('shows the URL itself when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const dialog = await openDialog();
    await userEvent.click(within(within(dialog).getByRole('region', { name: 'ChatGPT' })).getByRole('button', { name: 'Copy URL' }));
    expect(await screen.findByText(`Couldn't copy. The URL is ${SERVER}`)).toBeInTheDocument();
  });

  it('closes', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
