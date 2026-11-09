import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '../../test-utils';
import ConnectAssistantMenu from '@/components/aiAssistants/ConnectAssistantMenu';

/**
 * "Connect your assistant": a menu of three ways in, each starting the connection in place
 * rather than sending the person to another page first.
 */

const mockCapture = vi.fn();
vi.mock('posthog-js', () => ({ default: { capture: (...a: unknown[]) => mockCapture(...a) } }));

const SERVER = `${window.location.origin}/mcp`;

async function openMenu() {
  render(<ConnectAssistantMenu />);
  await userEvent.click(screen.getByRole('button', { name: 'Connect your assistant' }));
  return screen.findByRole('menu');
}

describe('ConnectAssistantMenu', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  it("opens Claude's add-connector dialog already filled in with this server", async () => {
    await openMenu();
    const item = screen.getByRole('menuitem', { name: /Add to Claude/ });
    const href = new URL(item.getAttribute('href') ?? '');
    expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
    expect(href.searchParams.get('modal')).toBe('add-custom-connector');
    expect(href.searchParams.get('connectorName')).toBe('Jigged');
    expect(href.searchParams.get('connectorUrl')).toBe(SERVER);
    expect(item).toHaveAttribute('target', '_blank');
    // The step Claude leaves to the person, and the per-chat switch Jigged can't set.
    expect(item).toHaveTextContent('Connect and Allow');
    expect(item).toHaveTextContent('+ → Connectors');
    await userEvent.click(item);
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'claude' });
  });

  it('copies the server link and opens ChatGPT', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Open ChatGPT/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVER));
    expect(open).toHaveBeenCalledWith('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'chatgpt' });
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    open.mockRestore();
  });

  it('copies the link for any other assistant', async () => {
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Copy link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVER));
    expect(mockCapture).toHaveBeenCalledWith('ai assistant connect started', { client_kind: 'other' });
  });

  it('shows the link itself when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Copy link/ }));
    expect(await screen.findByText(`Couldn't copy the link. It is ${SERVER}`)).toBeInTheDocument();
  });
});
