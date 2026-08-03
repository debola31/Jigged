import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import NewHelpfulBlock from '@/components/operator/NewHelpfulBlock';
import type { NewHelpful } from '@/types/operator';

vi.mock('@/utils/operatorAccess', () => ({ MAX_HELPFUL_NAMES: 3 }));

function item(over: Partial<NewHelpful> = {}): NewHelpful {
  return {
    note_id: 'n1',
    body: 'Clamp on the boss, not the flange — it walks.',
    reference: 'J-0042',
    names: ['Sam Carter'],
    latest_at: '2026-08-01T09:00:00Z',
    ...over,
  };
}

describe('New since you last looked', () => {
  /**
   * The signal names a person because that is the part with evidence behind it. What
   * transfers to a text row is directed gratitude — one person valuing one specific thing
   * — mediated by perceived social worth (Grant & Gino 2010). A bare count has no giver.
   */
  it('names the person and quotes the note they found helpful', () => {
    render(<NewHelpfulBlock items={[item()]} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Clamp on the boss/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Carter found your note helpful/)).toBeInTheDocument();
    // Never a nameless count, which is the banner's job and not this one's.
    expect(screen.queryByText(/1 person/i)).not.toBeInTheDocument();
  });

  /**
   * THE NOTE IS THE UNIT. Three people marking one note is one item naming three, not
   * three items — several individuals re-described as a single audience holds the signal
   * at single-target strength rather than fading as the count grows (Västfjäll et al.
   * 2014), and it is the only shape that keeps reactions off a per-person total.
   */
  it('groups several reactors onto the one note they reacted to', () => {
    render(
      <NewHelpfulBlock
        items={[item({ names: ['Sam Carter', 'Dee Novak', 'Ray Ellis'] })]}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.getByText(/Sam Carter, Dee Novak and Ray Ellis found your note helpful/),
    ).toBeInTheDocument();
  });

  it('collapses past three names behind a tappable "more", never a hover', async () => {
    const user = userEvent.setup();
    render(
      <NewHelpfulBlock
        items={[item({ names: ['Sam Carter', 'Dee Novak', 'Ray Ellis', 'Priya Nair', 'Kurtis Lang'] })]}
        onDismiss={vi.fn()}
      />,
    );

    const more = screen.getByRole('button', { name: /2 more/ });
    expect(more).toBeInTheDocument();
    expect(screen.queryByText(/Priya Nair/)).not.toBeInTheDocument();

    await user.click(more);

    expect(screen.getByText(/Priya Nair/)).toBeInTheDocument();
    expect(screen.getByText(/Kurtis Lang/)).toBeInTheDocument();
  });

  /**
   * Dismissal must advance a cursor and destroy nothing, and it must carry the newest
   * instant ACTUALLY SHOWN — not now(). A reaction landing between render and the tap
   * would otherwise be marked seen without ever having been on screen, and a missed
   * "Sam Carter found your note helpful" is the whole thing this mechanism protects.
   */
  it('dismisses with the newest instant it displayed, not the current time', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn(async () => {});
    render(
      <NewHelpfulBlock
        items={[
          item({ note_id: 'n1', latest_at: '2026-08-01T09:00:00Z' }),
          item({ note_id: 'n2', latest_at: '2026-08-02T17:30:00Z' }),
          item({ note_id: 'n3', latest_at: '2026-07-30T08:00:00Z' }),
        ]}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole('button', { name: /got it/i }));

    expect(onDismiss).toHaveBeenCalledWith('2026-08-02T17:30:00Z');
  });

  it('keeps the block on screen when dismissing fails, rather than losing the news', async () => {
    const user = userEvent.setup();
    render(
      <NewHelpfulBlock items={[item()]} onDismiss={vi.fn(async () => { throw new Error('offline'); })} />,
    );

    await user.click(screen.getByRole('button', { name: /got it/i }));

    expect(await screen.findByText(/Could not save that/)).toBeInTheDocument();
    expect(screen.getByText(/Clamp on the boss/)).toBeInTheDocument();
  });

  /**
   * Nothing at zero. An empty recognition surface is a standing reminder that nobody
   * cares, which is worse than silence — the same reasoning that makes the login banner
   * render null rather than announce "0 views".
   */
  it('renders nothing when there is nothing new', () => {
    const { container } = render(<NewHelpfulBlock items={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The quoted text has to read as SOMETHING YOU WROTE. Set in bold with no framing it
   * read as the block's own headline instead — "hard to tell that it is a note written by
   * the user", from looking at the shipped surface on a phone. Both channels carry it now:
   * a blockquote visually, and "your note" in the sentence, which is the half a screen
   * reader gets.
   */
  it('marks the quoted text as the operator\'s own note, in words and in markup', () => {
    const { container } = render(<NewHelpfulBlock items={[item()]} onDismiss={vi.fn()} />);

    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote).toHaveTextContent('Clamp on the boss');
    expect(screen.getByText(/found your note helpful/)).toBeInTheDocument();
    // "it" has no antecedent once the block holds more than one note.
    expect(screen.queryByText(/found it helpful/)).not.toBeInTheDocument();
  });

  it('survives a photo-only note, which has no body to quote', () => {
    render(<NewHelpfulBlock items={[item({ body: null })]} onDismiss={vi.fn()} />);

    const row = within(screen.getAllByRole('listitem')[0]!);
    expect(row.getByText(/Sam Carter found your note helpful/)).toBeInTheDocument();
  });

  /**
   * The guardrail, asserted where it would erode: this surface is where a per-person
   * tally wants to grow. An award that implies you did more than your peers is the shape
   * measured to backfire (Robinson et al. 2021).
   */
  it('shows no score, rank or per-person total', () => {
    const { container } = render(
      <NewHelpfulBlock
        items={[item({ names: ['Sam Carter', 'Dee Novak'] })]}
        onDismiss={vi.fn()}
      />,
    );

    const text = container.textContent ?? '';
    for (const forbidden of [/streak/i, /rank/i, /leaderboard/i, /top \d/i, /total/i, /points?\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
