import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import NoteReactions from '@/components/operator/NoteReactions';
import { addReaction, removeReaction } from '@/utils/operatorAccess';
import type { NoteReaction } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const mockAdd = vi.mocked(addReaction);
const mockRemove = vi.mocked(removeReaction);

const ME = 'member-me';
const THEM = 'member-them';

function helpful(reactorId: string, name: string | null): NoteReaction {
  return { kind: 'helpful', reactor_id: reactorId, name };
}

function setup(props: Partial<React.ComponentProps<typeof NoteReactions>> = {}) {
  return render(
    <NoteReactions
      companyId="c1"
      noteId="n1"
      authorId={THEM}
      reactions={[]}
      memberId={ME}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockAdd.mockReset();
  mockRemove.mockReset();
  mockAdd.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
});

describe('NoteReactions', () => {
  it('marks a note helpful', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /helpful/i }));

    expect(mockAdd).toHaveBeenCalledWith('c1', 'n1');
  });

  it('moves before the round trip completes', async () => {
    // On shop wifi a thumbs-up that waits for the server before moving reads as
    // a broken button.
    const user = userEvent.setup();
    let release: () => void = () => {};
    mockAdd.mockReturnValue(new Promise<void>((r) => (release = () => r())));
    setup();

    await user.click(screen.getByRole('button', { name: /helpful/i }));

    expect(await screen.findByRole('button', { name: /helpful · 1/i })).toBeInTheDocument();
    release();
  });

  it('rolls back rather than leaving a lie on screen', async () => {
    const user = userEvent.setup();
    mockAdd.mockRejectedValue(new Error('offline'));
    setup();

    await user.click(screen.getByRole('button', { name: /helpful/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /helpful · 1/i })).not.toBeInTheDocument(),
    );
  });

  it('takes it back on a second tap', async () => {
    const user = userEvent.setup();
    setup({ reactions: [helpful(ME, 'Me')] });

    await user.click(screen.getByRole('button', { name: /helpful · 1/i }));

    expect(mockRemove).toHaveBeenCalledWith('c1', 'n1');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('offers no control on your own note', async () => {
    // RLS forbids self-reaction, so a button here is a guaranteed 42501 that
    // reads to the operator as broken.
    setup({ authorId: ME, reactions: [helpful(THEM, 'Diego')] });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The endorsement still shows — it is reception.
    expect(screen.getByText('Diego')).toBeInTheDocument();
  });

  it('renders nothing at all when there is neither an action nor a reaction', () => {
    const { container } = setup({ authorId: ME, reactions: [] });

    expect(container).toBeEmptyDOMElement();
  });

  it('names the people, not just the number', async () => {
    // Attribution is the point of the whole workstream, and reactions are public
    // by design — so there is nothing to hide behind a second tap.
    setup({ reactions: [helpful(THEM, 'Diego'), helpful('m3', 'Priya')] });

    expect(await screen.findByText('Diego, Priya')).toBeInTheDocument();
  });

  it('collapses a long list rather than wrapping the card', async () => {
    setup({
      reactions: [
        helpful('a', 'Diego'),
        helpful('b', 'Priya'),
        helpful('c', 'Sam'),
        helpful('d', 'Jamie'),
        helpful('e', 'Morgan'),
      ],
    });

    expect(await screen.findByText('Diego, Priya, Sam +2')).toBeInTheDocument();
  });

  it('never renders a thumbs-down', async () => {
    // Not deferred — `kind` is CHECK-limited to ('helpful','confirmed') so there
    // is no schema slot for a negative. An inaccurate note is corrected or
    // superseded, never publicly judged by a colleague seen every morning.
    setup({ reactions: [helpful(THEM, 'Diego')] });

    expect(screen.queryByRole('button', { name: /not helpful|unhelpful|thumbs down/i })).toBeNull();
  });

  it('ignores confirmed, which has no UI yet', async () => {
    // 'confirmed' stays in the CHECK constraint but nothing writes it, and a
    // stray row must not inflate the helpful count.
    setup({
      reactions: [
        helpful(THEM, 'Diego'),
        { kind: 'confirmed', reactor_id: 'm3', name: 'Priya' },
      ],
    });

    expect(await screen.findByRole('button', { name: /helpful · 1/i })).toBeInTheDocument();
    expect(screen.queryByText(/Priya/)).not.toBeInTheDocument();
  });

  it('shows a count without a control in read-only mode', () => {
    // My work: endorsements received on your own notes.
    setup({ readOnly: true, authorId: null, memberId: null, reactions: [helpful(THEM, 'Diego')] });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Diego')).toBeInTheDocument();
  });

  it('waits for the member id before offering the control', () => {
    // Without it we cannot tell whose note this is, nor whether they already
    // reacted — an optimistic toggle on an unknown identity would be a guess.
    setup({ memberId: null, reactions: [helpful(THEM, 'Diego')] });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
