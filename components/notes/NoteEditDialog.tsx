'use client';

import { useMemo, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormHelperText from '@mui/material/FormHelperText';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import UndoIcon from '@mui/icons-material/Undo';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { getJobNoteMediaUrl } from '@/utils/jobNoteMediaAccess';
import type { JobNoteMedia } from '@/types/operator';

const THUMB = 72;

/** What Save hands back: the new body, plus any photos marked for removal. */
export interface NoteEditResult {
  /** Trimmed; null when emptied (legal only while photos remain). */
  body: string | null;
  /** note_media ids to delete. Empty on the common text-only edit. */
  removedMediaIds: string[];
}

/**
 * Edit one note's text, and optionally drop photos from it (#628).
 *
 * ONE dialog for all five surfaces — the job feed, the Playbook sheet, My work, the
 * machine logbook and the office part Activity tab. That is the point rather than
 * an economy: five surfaces with one editing behaviour, one blank-body rule and one
 * error string, instead of five that drift.
 *
 * WHY A DIALOG AND NOT INLINE EDITING, on both surface families:
 *
 *   Phone. NoteCaptureFields already had to add scrollIntoView({block:'center'})
 *   because the fixed action bar and the on-screen keyboard cover whatever is being
 *   edited. Swapping a feed row into a text field reproduces exactly that, AND
 *   collapses the row's height mid-scroll, which loses the reader's place in a list
 *   they were scrolling. A dialog guarantees a visible field above the keyboard and
 *   an unambiguous commit.
 *
 *   Desktop. The Activity tab's rows are ListItem + ListItemText(primary/secondary)
 *   with an absolutely-positioned secondaryAction; an inline field fights that
 *   layout rather than fitting into it.
 *
 * PHOTO REMOVAL IS DEFERRED TO SAVE, NEVER APPLIED ON TAP. A tapped photo dims and
 * offers Undo; Cancel discards the marks and nothing is deleted. Deleting on tap
 * would make Cancel a lie for photos, and on a phone a mis-tap on a small X would
 * irreversibly destroy a storage object. A confirm dialog nested inside this one was
 * the alternative and is worse for the same protection.
 *
 * ADDING photos is deliberately out of scope, and the reason is uploads rather than
 * atomicity — an edit that removes photos is already more than one statement. An
 * upload is the part that dies mid-flight on cellular and needs progress, retry and
 * orphan cleanup for a file that reached storage without its row. A delete is one
 * fast statement with none of that.
 */
/**
 * Stable empty default for `media`. MUST be module-level, not a `= []` default parameter.
 *
 * A default parameter is re-evaluated on every render, so it produced a NEW array identity
 * each time. That array is the dependency of the `useLoad` below, and `useLoad` memoises its
 * loader with `useCallback(fn, deps)` and re-runs on the loader's identity — so a fresh `[]`
 * per render re-ran the loader per render, and each resolution called setState with a fresh
 * object (no Object.is bailout), which rendered again, which built another `[]`. An infinite
 * loop that React never reports, because the setState happens in a promise callback rather
 * than synchronously in render, so the "Maximum update depth exceeded" guard never fires.
 *
 * It was invisible from outside: with `open={false}` the Dialog renders null, so the loop
 * made no DOM mutations and no network requests, and every task in it was sub-millisecond,
 * so a longtask observer reported nothing. It simply held a CPU core down for as long as the
 * page was mounted. The operator "Me" tab was the one surface that mounted this dialog
 * unconditionally — one per note row — so a screen showing ten notes ran ten of these at
 * once and everything the operator tapped afterwards competed with a pegged core.
 */
const NO_MEDIA: JobNoteMedia[] = [];

export default function NoteEditDialog({
  open,
  initialBody,
  media = NO_MEDIA,
  saving = false,
  error = null,
  noun = 'note',
  onSave,
  onClose,
}: {
  open: boolean;
  initialBody: string | null;
  /** The note's photos. Omit on surfaces that carry none (part comments). */
  media?: JobNoteMedia[];
  saving?: boolean;
  error?: string | null;
  /** "note" or "comment" — used in the title and the empty-body helper. */
  noun?: string;
  onSave: (result: NoteEditResult) => void;
  onClose: () => void;
}) {
  // Seeded once, at mount. There is deliberately NO effect resyncing this to
  // `initialBody` — that would be a setState inside an effect (the lint rule this
  // codebase enforces), and it would also fight the parent whenever a save patches
  // the note in place.
  //
  // Freshness comes from the caller MOUNTING this per note instead:
  //   {editingNote && <NoteEditDialog key={editingNote.id} … />}
  // so switching notes, or reopening after a Cancel, is a remount with a clean
  // draft. Same technique and same reason as MachineReplyComposer, whose draft
  // must likewise die with the thing it was written about — there, a sentence
  // about one item could otherwise be filed as the fix for another.
  const [body, setBody] = useState(initialBody ?? '');
  const [removed, setRemoved] = useState<string[]>([]);

  const remainingMedia = useMemo(
    () => media.filter((m) => !removed.includes(m.id)),
    [media, removed],
  );

  const trimmed = body.trim();

  // An empty body is legal only while the note still has a photo to be. Falls out
  // of the media list rather than needing a prop: a part comment has no media, so
  // empty is never allowed there, which is exactly what
  // part_comments_body_not_blank enforces server-side.
  const allowEmpty = remainingMedia.length > 0;
  const isEmpty = trimmed.length === 0;
  const emptyBlocked = isEmpty && !allowEmpty;

  const changed = trimmed !== (initialBody ?? '').trim() || removed.length > 0;
  const canSave = changed && !emptyBlocked && !saving;

  // Batch-load thumbnails once per media set, mirroring NoteMediaGallery.
  const { data: urls } = useLoad(async () => {
    const pairs = await Promise.all(
      media.map(async (m) => {
        try {
          return [m.id, await getJobNoteMediaUrl(m.thumbnail_path ?? m.storage_path)] as const;
        } catch {
          return null;
        }
      }),
    );
    const map: Record<string, string> = {};
    for (const p of pairs) if (p) map[p[0]] = p[1];
    return map;
  }, [media]);

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit {noun}</DialogTitle>

      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={saving}
          error={emptyBlocked}
          placeholder="What should the next person know?"
          sx={{ mt: 1 }}
        />

        {emptyBlocked && (
          // Names the correct action rather than only refusing. Someone emptying the
          // field is usually trying to get rid of the note, and "you can't do that"
          // without saying what they can do is where people give up.
          <FormHelperText error>
            A {noun} can&apos;t be empty — delete it instead.
          </FormHelperText>
        )}

        {media.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Photos
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
              {media.map((m) => {
                const isRemoved = removed.includes(m.id);
                const url = urls?.[m.id];
                return (
                  <Box key={m.id} sx={{ position: 'relative', width: THUMB, height: THUMB }}>
                    <Box
                      sx={{
                        width: THUMB,
                        height: THUMB,
                        borderRadius: 1,
                        overflow: 'hidden',
                        bgcolor: 'rgba(255,255,255,0.06)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        // Marked photos stay visible but obviously pending, so the
                        // state reads as "will go when you save" rather than "gone".
                        opacity: isRemoved ? 0.25 : 1,
                      }}
                    >
                      {url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={url}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <BrokenImageOutlinedIcon fontSize="small" color="disabled" />
                      )}
                    </Box>

                    <IconButton
                      aria-label={isRemoved ? 'Keep this photo' : 'Remove this photo'}
                      disabled={saving}
                      onClick={() =>
                        setRemoved((prev) =>
                          isRemoved ? prev.filter((id) => id !== m.id) : [...prev, m.id],
                        )
                      }
                      size="small"
                      sx={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        bgcolor: 'background.paper',
                        '&:hover': { bgcolor: 'background.paper' },
                      }}
                    >
                      {isRemoved ? (
                        <UndoIcon sx={{ fontSize: 16 }} />
                      ) : (
                        <CloseIcon sx={{ fontSize: 16 }} />
                      )}
                    </IconButton>
                  </Box>
                );
              })}
            </Box>
            {removed.length > 0 && (
              <FormHelperText>
                {removed.length} photo{removed.length === 1 ? '' : 's'} will be removed when you
                save.
              </FormHelperText>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={saving} sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!canSave}
          sx={{ minHeight: 48 }}
          onClick={() => onSave({ body: trimmed || null, removedMediaIds: removed })}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
