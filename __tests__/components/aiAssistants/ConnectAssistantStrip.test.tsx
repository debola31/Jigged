import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '../../test-utils';
import ConnectAssistantStrip from '@/components/aiAssistants/ConnectAssistantStrip';

/**
 * The dashboard's way to the person's own assistant. It stands apart from Insights, and connects
 * in place: its button opens the connect menu rather than sending the person to another page.
 */
describe('ConnectAssistantStrip', () => {
  it('opens the connect menu in place', async () => {
    render(<ConnectAssistantStrip />);
    expect(screen.getByRole('heading', { name: 'Use your own AI assistant' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect your assistant' }));
    expect(await screen.findByRole('menuitem', { name: /Add to Claude/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your assistant' })).not.toBeInTheDocument();
  });
});
