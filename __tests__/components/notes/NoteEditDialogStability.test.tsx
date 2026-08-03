import { describe, it, expect, vi } from 'vitest';
import { Profiler } from 'react';
import { render, screen } from '@/__tests__/test-utils';

import NoteEditDialog from '@/components/notes/NoteEditDialog';

vi.mock('@/utils/jobNoteMediaAccess', () => ({
  getJobNoteMediaUrl: vi.fn(async () => 'https://example.test/photo.jpg'),
}));

/**
 * This component must reach a resting state and stay there.
 *
 * The bug this guards against had no symptom anywhere you would normally look. `media = []`
 * was a DEFAULT PARAMETER, so it produced a new array identity on every render; that array
 * was `useLoad`'s dependency, so the loader re-ran every render and every resolution
 * setState'd a fresh object, which rendered again. React never complained, because the
 * setState came from a promise callback rather than synchronously during render, so the
 * "Maximum update depth exceeded" guard never fired. With `open={false}` the dialog rendered
 * null, so there were no DOM mutations to notice. The loader mapped over an empty array, so
 * there were no network requests to notice. Every iteration was sub-millisecond, so a
 * longtask observer reported zero.
 *
 * The only observable was a CPU core pinned for as long as the component stayed mounted —
 * and the operator "Me" tab mounted one of these PER NOTE ROW, closed, so a screen of ten
 * notes ran ten of them and every subsequent tap competed with a saturated core. That is
 * what "the app stalls after going to the Me page" was.
 *
 * Counting commits is the assertion because it is the only thing that distinguishes the two
 * states from outside. Rendered output is identical either way.
 */
async function countCommits(ui: React.ReactElement, ms: number): Promise<number> {
  let commits = 0;
  render(<Profiler id="probe" onRender={() => { commits += 1; }}>{ui}</Profiler>);
  await new Promise((r) => setTimeout(r, ms));
  return commits;
}

describe('NoteEditDialog render stability', () => {
  const noop = () => {};

  it('settles when no media prop is passed (the surface that spun a core)', async () => {
    const commits = await countCommits(
      <NoteEditDialog open={false} initialBody="Clamp on the boss." onSave={noop} onClose={noop} />,
      300,
    );

    // Settled means a handful of commits, not thousands. Before the fix this was ~1000+
    // in the same window and still climbing.
    expect(commits).toBeLessThan(15);
  });

  it('settles for many closed instances, which is how the Me tab rendered them', async () => {
    const many = (
      <>
        {Array.from({ length: 10 }, (_, i) => (
          <NoteEditDialog
            key={i}
            open={false}
            initialBody={`note ${i}`}
            onSave={noop}
            onClose={noop}
          />
        ))}
      </>
    );

    const commits = await countCommits(many, 300);
    expect(commits).toBeLessThan(40);
  });

  it('still settles when media IS passed with a stable identity', async () => {
    const media = [
      { id: 'm1', storage_path: 'a/b.jpg', thumbnail_path: null },
    ] as never;

    const commits = await countCommits(
      <NoteEditDialog
        open
        initialBody="With a photo."
        media={media}
        onSave={noop}
        onClose={noop}
      />,
      300,
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(commits).toBeLessThan(15);
  });
});
