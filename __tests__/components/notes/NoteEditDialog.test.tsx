import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import NoteEditDialog from '@/components/notes/NoteEditDialog';
import type { JobNoteMedia } from '@/types/operator';

// Signed-URL lookup builds a Supabase client at module scope.
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  getJobNoteMediaUrl: vi.fn().mockResolvedValue('blob:thumb'),
}));

const onSave = vi.fn();
const onClose = vi.fn();

function photo(over: Partial<JobNoteMedia> = {}): JobNoteMedia {
  return {
    id: 'm1',
    note_id: 'n1',
    storage_path: 'c1/n1/a.jpg',
    thumbnail_path: null,
    kind: 'photo',
    mime_type: 'image/jpeg',
    width: 100,
    height: 100,
    ...over,
  };
}

function setup(props: Partial<React.ComponentProps<typeof NoteEditDialog>> = {}) {
  return render(
    <NoteEditDialog
      open
      initialBody="original text"
      onSave={onSave}
      onClose={onClose}
      {...props}
    />,
  );
}

const saveButton = () => screen.getByRole('button', { name: /^Save$/ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NoteEditDialog', () => {
  it('seeds the field with the existing body', () => {
    setup();
    expect(screen.getByRole('textbox')).toHaveValue('original text');
  });

  it('disables Save until something actually changes', async () => {
    const user = userEvent.setup();
    setup();
    expect(saveButton()).toBeDisabled();

    await user.type(screen.getByRole('textbox'), '!');
    expect(saveButton()).toBeEnabled();
  });

  it('treats a whitespace-only difference as no change', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('textbox'), '   ');
    // Trimmed on both sides before comparing, so padding is not an edit and
    // cannot stamp edited_at on a note nobody changed.
    expect(saveButton()).toBeDisabled();
  });

  it('blocks an emptied body on a note with no photos, and says to delete instead', async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByRole('textbox'));

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/can't be empty — delete it instead/i)).toBeInTheDocument();
  });

  it('ALLOWS an emptied body while a photo remains, and returns null', async () => {
    const user = userEvent.setup();
    setup({ media: [photo()] });
    await user.clear(screen.getByRole('textbox'));

    // A media-only note is legal: notes_body_blank_or_null permits NULL.
    expect(screen.queryByText(/delete it instead/i)).not.toBeInTheDocument();
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({ body: null, removedMediaIds: [] });
  });

  it('blocks emptying the body once the LAST photo is also marked for removal', async () => {
    const user = userEvent.setup();
    setup({ media: [photo()] });
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: /Remove this photo/i }));

    // Nothing would be left of the note at all.
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/can't be empty — delete it instead/i)).toBeInTheDocument();
  });

  it('marks a photo for removal without deleting it, and can undo', async () => {
    const user = userEvent.setup();
    setup({ media: [photo({ id: 'm1' }), photo({ id: 'm2' })] });

    await user.click(screen.getAllByRole('button', { name: /Remove this photo/i })[0]);
    expect(screen.getByText(/1 photo will be removed when you save/i)).toBeInTheDocument();

    // Undo is offered in place — nothing has been destroyed yet.
    await user.click(screen.getByRole('button', { name: /Keep this photo/i }));
    expect(screen.queryByText(/will be removed when you save/i)).not.toBeInTheDocument();
  });

  it('reports removals only on Save — the deferral that keeps Cancel honest', async () => {
    const user = userEvent.setup();
    setup({ media: [photo({ id: 'm1' }), photo({ id: 'm2' })] });

    await user.click(screen.getAllByRole('button', { name: /Remove this photo/i })[0]);
    // Marking alone is a change, so Save unlocks without touching the text.
    await user.click(saveButton());

    expect(onSave).toHaveBeenCalledWith({ body: 'original text', removedMediaIds: ['m1'] });
  });

  it('does not call onSave when cancelled', async () => {
    const user = userEvent.setup();
    setup({ media: [photo()] });

    await user.click(screen.getAllByRole('button', { name: /Remove this photo/i })[0]);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('uses the caller’s noun in the title and the empty-body helper', async () => {
    const user = userEvent.setup();
    setup({ noun: 'comment' });
    expect(screen.getByText('Edit comment')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox'));
    expect(screen.getByText(/A comment can't be empty/i)).toBeInTheDocument();
  });

  it('locks the controls while saving', () => {
    setup({ saving: true });
    // The label switches to "Saving…" so the button is its own progress
    // indicator — there is no separate spinner to find.
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('surfaces a save error', () => {
    setup({ error: 'permission denied' });
    expect(screen.getByText('permission denied')).toBeInTheDocument();
  });
});
