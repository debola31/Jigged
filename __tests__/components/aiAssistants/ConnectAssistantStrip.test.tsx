import { describe, it, expect } from 'vitest';

import { render, screen } from '../../test-utils';
import ConnectAssistantStrip from '@/components/aiAssistants/ConnectAssistantStrip';

/**
 * The dashboard's way to the person's own assistant. It stands apart from Insights, so the one
 * thing it must do is open the connect page for this company.
 */
describe('ConnectAssistantStrip', () => {
  it('links to the connect page for the company', () => {
    render(<ConnectAssistantStrip companyId="co-1" />);
    expect(screen.getByRole('heading', { name: 'Use your own AI assistant' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your assistant' })).toHaveAttribute(
      'href',
      '/dashboard/co-1/ai-assistants',
    );
  });
});
