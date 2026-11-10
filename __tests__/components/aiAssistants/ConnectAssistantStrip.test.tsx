import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '../../test-utils';
import ConnectAssistantStrip from '@/components/aiAssistants/ConnectAssistantStrip';

/**
 * The dashboard's way to the person's own assistant. It stands apart from Insights, and connects
 * in place: its button opens the connect dialog rather than sending the person to another page.
 */
describe('ConnectAssistantStrip', () => {
  it('opens the connect dialog in place', async () => {
    render(<ConnectAssistantStrip />);
    expect(screen.getByRole('heading', { name: 'Use your own AI assistant' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect your assistant' }));
    expect(await screen.findByRole('dialog', { name: /Connect your assistant/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your assistant' })).not.toBeInTheDocument();
  });
});
