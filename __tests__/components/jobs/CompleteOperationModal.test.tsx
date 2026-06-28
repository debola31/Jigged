import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import CompleteOperationModal from '@/components/jobs/CompleteOperationModal';
import type { JobOperation } from '@/types/job';

const op = (id: string, name: string): JobOperation =>
  ({ id, sequence: 1, operation_name: name }) as unknown as JobOperation;

const wrap = (ui: React.ReactElement) => (
  <ThemeProvider theme={jiggedTheme}>{ui}</ThemeProvider>
);

const notesField = () => screen.getByLabelText(/notes/i) as HTMLTextAreaElement;

describe('CompleteOperationModal — reset on (re)open', () => {
  it('clears the notes field each time the modal reopens (onEnter reset)', async () => {
    const props = { operation: op('o1', 'Mill'), onClose: vi.fn(), onConfirm: vi.fn() };
    const { rerender } = render(wrap(<CompleteOperationModal open {...props} />));

    await userEvent.type(notesField(), 'left-over notes');
    expect(notesField().value).toBe('left-over notes');

    // Close, then reopen — onEnter must wipe the field back to empty.
    rerender(wrap(<CompleteOperationModal open={false} {...props} />));
    rerender(wrap(<CompleteOperationModal open {...props} />));

    await waitFor(() => expect(notesField().value).toBe(''));
  });
});
