'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CancelIcon from '@mui/icons-material/Cancel';
import CloseIcon from '@mui/icons-material/Close';

import JobActivityComposer from './JobActivityComposer';
import JobActivityList from './JobActivityList';
import { filterToOperation, type JobActivityItem } from './jobActivityTimeline';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import NoteEditDialog, { type NoteEditResult } from '@/components/notes/NoteEditDialog';
import { updateNoteBody } from '@/utils/operatorAccess';
import { deleteJobNote, deleteJobNoteMedia } from '@/utils/jobNoteMediaAccess';
import { voidOperationCompletion } from '@/utils/operationCompletionsAccess';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';

/**
 * Rail width, per breakpoint.
 *
 * 320 at `lg` is the number the operation row can afford. The content column at
 * a 1200px viewport is `1200 − 240 sidebar − 48 padding − 320 − 24 gap = 568`,
 * and a partially-shipped outside op wraps its action cluster to a second line
 * there — which is why OperationCard's row carries an explicit flex-basis rather
 * than `flex: 1`. Widening this without revisiting that will clip buttons.
 */
export const RAIL_WIDTH_LG = 320;
export const RAIL_WIDTH_XL = 380;

/**
 * How much vertical room the app chrome takes above `<main>`'s content box.
 *
 * Only a max-height, never a `top` offset: `<main>` is the scroll container and
 * its padding-box already starts below the sticky header, so `top: 0` on a
 * sticky child is correct. Being a few pixels out here costs a slightly tall
 * scroller, not a covered header — which is exactly why this is a sticky column
 * and not a fixed drawer at `zIndex.drawer`.
 */
const RAIL_CHROME_INSET = 96;

export const RAIL_OPEN_STORAGE_KEY = 'jigged-job-activity-rail-open';

/** Read the remembered docked state. DEFAULTS OPEN — see below. */
export function readRailOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    /**
     * `!== 'false'`, not `=== 'true'`. A first-time user has no key at all, and
     * the whole reason this is a docked rail rather than an on-demand drawer is
     * that the feed and its composer should be discoverable without being
     * summoned. Defaulting closed would give up the only thing the shape buys.
     */
    return window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeRailOpen(open: boolean): void {
  try {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    // A browser refusing site data is not a reason to fail the toggle.
  }
}

/**
 * `activity rail toggled`.
 *
 * THIS IS THE NUMBER THAT SAYS WHETHER OPEN-BY-DEFAULT WAS RIGHT. A high close
 * rate with few reopens means the office is reclaiming the width and the
 * on-demand drawer was the better shape after all. `is_wide` keeps the docked
 * rail apart from the narrow overlay, where closing is just how you get back to
 * the page and means nothing.
 */
export function captureRailToggle(open: boolean, isWide: boolean): void {
  posthog.capture('activity rail toggled', { surface: 'office_job', open, is_wide: isWide });
}

export interface JobActivityRailProps {
  companyId: string;
  jobId: string;
  items: JobActivityItem[];
  loading: boolean;
  error: unknown;
  /** Re-read all three sources. Shared with the step cards so they cannot disagree. */
  reload: () => Promise<void>;
  memberId: string | null;
  isAdmin: boolean;
  /** The docked column's state, owned by the page because the Grid spans read it. */
  open: boolean;
  onClose: () => void;
  /** The narrow-screen overlay. Always starts false, so its Modal never mounts when docked. */
  mobileOpen: boolean;
  onMobileClose: () => void;
  /**
   * Set by a step card's note badge. Null is "the whole job".
   *
   * The step NAME comes with the id rather than being dug back out of the
   * items: a step can be filtered to while having no rows yet, and a label
   * derived from the rows would then be blank exactly when the empty state
   * needs to say which step it means.
   */
  filter: { operationId: string; stepName: string } | null;
  onClearFilter: () => void;
  onViewSlip?: (shipmentId: string) => void;
}

/**
 * The office activity rail.
 *
 * TWO BRANCHES, BOTH IN THE DOM: a docked in-flow column from `lg` up, and a
 * temporary Drawer below it. Which one shows is pure CSS, so both stay
 * renderable in jsdom — the position __tests__/setup.ts takes, and the reason
 * this is not `variant="persistent"` with a `useMediaQuery`.
 *
 * The Drawer's `open` is a SEPARATE state that only the narrow-screen toggle can
 * set, so on a wide screen its Modal never mounts and cannot fight the docked
 * column for focus. One rail, two mounts, one list implementation.
 */
export default function JobActivityRail({
  companyId,
  jobId,
  items,
  loading,
  error,
  reload,
  memberId,
  isAdmin,
  open,
  onClose,
  mobileOpen,
  onMobileClose,
  filter,
  onClearFilter,
  onViewSlip,
}: JobActivityRailProps) {
  const [editing, setEditing] = useState<JobNote | null>(null);
  const [deleting, setDeleting] = useState<JobNote | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const shown = filter ? filterToOperation(items, filter.operationId) : items;

  const handleVoidCompletion = async (completion: JobActivityCompletion) => {
    setVoidingId(completion.id);
    setRowError(null);
    try {
      await voidOperationCompletion(completion.id);
      await reload();
      /**
       * `capture_source` is the interesting half. The office voiding a row it
       * keyed in itself is a typo; the office voiding an `operator` row is the
       * office overruling the floor. One button, two different things.
       */
      posthog.capture('completion voided', {
        surface: 'office_job',
        capture_source: completion.capture_source,
      });
    } catch (err) {
      setRowError(
        friendlyErrorMessage(err, {
          entity: 'completion',
          fallback: 'Could not undo that completion.',
        }),
      );
    } finally {
      setVoidingId(null);
    }
  };

  const handleSaveEdit = async (result: NoteEditResult) => {
    if (!editing) return;
    setRowBusy(true);
    setRowError(null);
    try {
      for (const mediaId of result.removedMediaIds) {
        const media = (editing.media ?? []).find((m) => m.id === mediaId);
        if (media) await deleteJobNoteMedia(media);
      }
      await updateNoteBody(editing.id, result.body);
      await reload();
      setEditing(null);
    } catch (err) {
      setRowError(friendlyErrorMessage(err, { entity: 'note', fallback: 'Could not save that.' }));
    } finally {
      setRowBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleting) return;
    setRowBusy(true);
    setRowError(null);
    try {
      await deleteJobNote(deleting.id);
      await reload();
      setDeleting(null);
    } catch (err) {
      setRowError(
        friendlyErrorMessage(err, { entity: 'note', fallback: 'Could not delete that note.' }),
      );
    } finally {
      setRowBusy(false);
    }
  };

  const body = (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Activity
        </Typography>
        {loading ? (
          <CircularProgress size={14} aria-label="Loading activity" />
        ) : (
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            {items.length}
          </Typography>
        )}
        <Box sx={{ ml: 'auto', display: 'flex' }}>
          <IconButton
            size="small"
            aria-label="Close the activity feed"
            onClick={() => {
              // Whichever mount is visible, only one of these is reachable.
              onMobileClose();
              onClose();
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      {filter ? (
        <Box sx={{ mb: 1 }}>
          <Chip
            size="small"
            label={`Showing ${filter.stepName}`}
            onDelete={() => {
              // The other half of `activity step filtered`: whether a narrowed
              // view is somewhere people are willing to stay, or somewhere they
              // immediately back out of.
              posthog.capture('activity step filtered', {
                surface: 'office_job',
                note_count: shown.filter((i) => i.kind === 'note').length,
                cleared: true,
              });
              onClearFilter();
            }}
            /* Clearing is always offered, so the filter is never a place you
               get stuck — the step badge that sets it is a one-way control.
               The label goes on the DELETE ICON, not the Chip root: MUI hangs
               the click handler off the icon, so a name on the root would be
               announced by a control that does nothing. */
            deleteIcon={
              <CancelIcon
                role="button"
                aria-label="Show the whole job again"
                data-testid="clear-step-filter"
              />
            }
          />
        </Box>
      ) : null}

      <JobActivityComposer
        companyId={companyId}
        jobId={jobId}
        authorId={memberId}
        onPosted={() => {
          void reload();
        }}
      />

      {error ? (
        <Box sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ color: 'error.light' }}>
            Could not load this job&rsquo;s activity.
          </Typography>
          <Button size="small" onClick={() => void reload()} sx={{ px: 0 }}>
            Try again
          </Button>
        </Box>
      ) : null}

      {rowError ? (
        <Typography variant="caption" sx={{ color: 'error.light', display: 'block', mb: 1 }}>
          {rowError}
        </Typography>
      ) : null}

      <JobActivityList
        items={shown}
        memberId={memberId}
        isAdmin={isAdmin}
        onEditNote={setEditing}
        onDeleteNote={setDeleting}
        onVoidCompletion={handleVoidCompletion}
        voidingCompletionId={voidingId}
        onViewSlip={onViewSlip}
        emptyMessage={
          filter
            ? `Nothing has been recorded on ${filter.stepName} yet.`
            : 'Nothing has been recorded on this job yet.'
        }
      />
    </>
  );

  return (
    <>
      {/* DOCKED — lg and up. In the flow, so it reserves its own width and no
          second number has to be kept in sync with it. */}
      <Box
        component="aside"
        aria-label="Job activity"
        data-testid="job-activity-rail"
        sx={{
          display: { xs: 'none', lg: open ? 'flex' : 'none' },
          flexDirection: 'column',
          flexShrink: 0,
          width: { lg: RAIL_WIDTH_LG, xl: RAIL_WIDTH_XL },
          position: 'sticky',
          top: 0,
          // Without this the flex row stretches the rail to the content
          // column's height and `sticky` never engages.
          alignSelf: 'flex-start',
          maxHeight: `calc(100dvh - ${RAIL_CHROME_INSET}px)`,
          borderLeft: '1px solid rgba(255,255,255,0.14)',
          pl: 2,
        }}
      >
        {body}
      </Box>

      {/* OVERLAY — below lg. `mobileOpen` is only ever set by the narrow-screen
          toggle, so this Modal does not mount while the rail is docked. */}
      <Drawer
        anchor="right"
        open={mobileOpen}
        onClose={onMobileClose}
        sx={{ display: { xs: 'block', lg: 'none' } }}
        slotProps={{
          paper: {
            sx: {
              width: { xs: '100vw', sm: 420 },
              p: 2,
              display: 'flex',
              flexDirection: 'column',
            },
          },
        }}
      >
        {/* The testid lives on a wrapper rather than the paper slot so tests can
            scope to this mount — both mounts render the same labels. */}
        <Box
          data-testid="job-activity-rail-overlay"
          sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
        >
          {body}
        </Box>
      </Drawer>

      {/* Rendered ONCE, outside both mounts — two of either would be two modals. */}
      <NoteEditDialog
        open={editing !== null}
        initialBody={editing?.body ?? null}
        media={editing?.media ?? []}
        saving={rowBusy}
        error={rowError}
        noun="note"
        onSave={handleSaveEdit}
        onClose={() => {
          setEditing(null);
          setRowError(null);
        }}
      />
      <NoteDeleteDialog
        open={deleting !== null}
        noun="note"
        deleting={rowBusy}
        error={rowError}
        onConfirm={handleConfirmDelete}
        onClose={() => {
          setDeleting(null);
          setRowError(null);
        }}
      />
    </>
  );
}
