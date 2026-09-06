'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CancelIcon from '@mui/icons-material/Cancel';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import KeyboardDoubleArrowLeftIcon from '@mui/icons-material/KeyboardDoubleArrowLeft';

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
 * How much vertical room the sticky app header takes above `<main>`.
 *
 * A height, never a `top` offset: `<main>` is the scroll container and its
 * padding box already starts below the sticky header, so `top: 0` on a sticky
 * child is correct. Being a few pixels out here costs a slightly tall scroller,
 * not a covered header — which is exactly why this is a sticky column and not a
 * fixed drawer at `zIndex.drawer`.
 */
const RAIL_HEADER_INSET = 72;

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
  /**
   * Re-open the docked column. The rail owns the way back — see the collapsed
   * tab at the bottom of this file for why it cannot only live in the toolbar.
   */
  onOpen: () => void;
  /** The narrow-screen overlay. Always starts false, so its Modal never mounts when docked. */
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** Open the narrow-screen overlay. The collapsed strip is the only way in. */
  onMobileOpen: () => void;
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
  onOpen,
  mobileOpen,
  onMobileClose,
  onMobileOpen,
  filter,
  onClearFilter,
  onViewSlip,
}: JobActivityRailProps) {
  const [editing, setEditing] = useState<JobNote | null>(null);
  const [deleting, setDeleting] = useState<JobNote | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const shown = filter ? filterToOperation(items, filter.operationId) : items;

  const handleUndoCompletion = async (completion: JobActivityCompletion) => {
    setUndoingId(completion.id);
    setRowError(null);
    try {
      // The FUNCTION is still `voidOperationCompletion` and the column is still
      // `voided_at` — the schema's word for this is void. The user's word is
      // undo, because void belongs to documents someone is holding a copy of.
      await voidOperationCompletion(completion.id);
      await reload();
      /**
       * `capture_source` is the interesting half. The office undoing a row it
       * keyed in itself is a typo; the office undoing an `operator` row is the
       * office overruling the floor. One button, two different things.
       */
      posthog.capture('completion undone', {
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
      setUndoingId(null);
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

  /**
   * The body, built PER MOUNT so each owns its own dismiss.
   *
   * These used to share one handler that called both `onMobileClose()` and
   * `onClose()`, on the theory that only one mount is ever reachable. That was
   * wrong, and silently so: dismissing the narrow OVERLAY also wrote the DOCKED
   * column's remembered state to closed, so a phone-width dismiss collapsed the
   * desktop rail on a screen the person had not even opened yet.
   *
   * They also differ in meaning, not just in wiring. The docked column
   * COLLAPSES — it is a pane you set aside and bring back, which is what the
   * chevron says. The overlay CLOSES, because on a narrow screen it is covering
   * the page and getting rid of it is the whole intent.
   */
  const renderBody = (dismiss: {
    onDismiss: () => void;
    label: string;
    icon: React.ReactNode;
  }) => (
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
          <Tooltip title={dismiss.label}>
            <IconButton size="small" aria-label={dismiss.label} onClick={dismiss.onDismiss}>
              {dismiss.icon}
            </IconButton>
          </Tooltip>
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
        onUndoCompletion={handleUndoCompletion}
        undoingCompletionId={undoingId}
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
          /**
           * ONE SCREEN TALL, ALWAYS — `height`, not `maxHeight`.
           *
           * With a max the column was only as tall as its own content, so the
           * divider grew and shrank with the number of rows and read as the
           * edge of a floating block rather than the edge of a region. Matching
           * the CONTENT column instead would be worse: production plus
           * materials runs to several thousand pixels, so the rule would carry
           * on for screens past the last row, drawn beside nothing.
           *
           * Pinned to the viewport is the third option and the right one. The
           * feed scrolls inside it, and the divider always spans exactly what
           * you can see.
           */
          height: `calc(100dvh - ${RAIL_HEADER_INSET}px)`,
          /**
           * BLEEDS THROUGH `<main>`'s PADDING, so the region reaches the edges
           * of the screen instead of floating inside the page's gutter. A band
           * of canvas above and to the right of it reads as "a block that
           * happens to be tall", which is the thing the full height was meant
           * to stop.
           */
          /**
           * SIDEWAYS ONLY. `mr` matches `<main>`'s padding exactly — a bleed
           * wider than the padding it cancels is overflow, not bleed — and it
           * works because nothing constrains the box horizontally.
           *
           * A NEGATIVE `mt` DOES NOT WORK HERE, and the reason is worth writing
           * down: `position: sticky` with `top: 0` is a constraint at EVERY
           * scroll position, not only once you scroll. The margin puts the box
           * 24px above the scrollport, `top: 0` says it may never be above the
           * scrollport, and sticky pushes it straight back down. The two fight,
           * `top` wins, and the gap survives while the property meant to close
           * it sits in the styles looking correct. The top is PAINTED instead —
           * see `&::before` below.
           */
          mr: { xs: -2, md: -3 },
          /**
           * A REGION, not a box — a tint and one rule, no border-all-round and
           * no radius.
           *
           * This went through the full Card treatment once (fill, border,
           * radius) and read as a panel bolted onto the page, because that is
           * what those three together mean. What separates a region from an
           * object is exactly the furniture: a surface says "different place",
           * a closed outline says "different thing".
           *
           * A darkening WASH rather than a colour of its own, so it tracks
           * whatever the ambient backdrop is doing behind it instead of pinning
           * a hex that drifts out of step with the canvas.
           */
          bgcolor: 'rgba(0, 0, 0, 0.16)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.14)',
          /**
           * The top gap, PAINTED rather than fought over: a band carrying the
           * same wash and rule, sitting in `<main>`'s padding above the box.
           * `<main>` clips it at exactly the page header, which is where the
           * region should stop, and because it travels with a sticky parent it
           * scrolls out of view the moment the rail pins — no second state to
           * keep in sync, and no phantom scroll height.
           */
          '&::before': {
            content: '""',
            position: 'absolute',
            left: -1,
            right: 0,
            top: { xs: -16, md: -24 },
            height: { xs: 16, md: 24 },
            bgcolor: 'inherit',
            borderLeft: '1px solid rgba(255, 255, 255, 0.14)',
          },
          // Restores the inset the negative margins just cancelled, so the
          // content keeps the page's rhythm even though the surface does not.
          pl: 2,
          pr: 3,
          py: 3,
        }}
      >
        {renderBody({
          onDismiss: onClose,
          label: 'Collapse the activity feed',
          icon: <KeyboardDoubleArrowRightIcon fontSize="small" />,
        })}
      </Box>

      {/* THE ONLY WAY IN, at every width.
          There was a toolbar button too; it went, because it sat among Print
          Traveler and the Shipments dropdown reading as "open a thing" rather
          than "this region is collapsed", and two controls for one pane is one
          more than the page needs. This strip sits exactly where the rail was,
          so the way back is where the thing went.

          It therefore has to work BELOW `lg` as well, where the rail can only
          be an overlay — hence two buttons inside it, gated the same CSS way
          the mounts are. Removing the toolbar button without this would leave a
          narrow screen with no route to the feed at all. */}
      <Box
        component="aside"
        aria-label="Job activity, collapsed"
        data-testid="job-activity-rail-collapsed"
        sx={{
          display: { xs: 'flex', lg: open ? 'none' : 'flex' },
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          flexShrink: 0,
          width: 44,
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          py: 1.5,
          // The same height, wash and rule the open rail uses, so collapsing
          // reads as the region narrowing rather than as a different thing
          // appearing in its place.
          height: `calc(100dvh - ${RAIL_HEADER_INSET}px)`,
          /**
           * SIDEWAYS ONLY. `mr` matches `<main>`'s padding exactly — a bleed
           * wider than the padding it cancels is overflow, not bleed — and it
           * works because nothing constrains the box horizontally.
           *
           * A NEGATIVE `mt` DOES NOT WORK HERE, and the reason is worth writing
           * down: `position: sticky` with `top: 0` is a constraint at EVERY
           * scroll position, not only once you scroll. The margin puts the box
           * 24px above the scrollport, `top: 0` says it may never be above the
           * scrollport, and sticky pushes it straight back down. The two fight,
           * `top` wins, and the gap survives while the property meant to close
           * it sits in the styles looking correct. The top is PAINTED instead —
           * see `&::before` below.
           */
          mr: { xs: -2, md: -3 },
          bgcolor: 'rgba(0, 0, 0, 0.16)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.14)',
          /**
           * The top gap, PAINTED rather than fought over: a band carrying the
           * same wash and rule, sitting in `<main>`'s padding above the box.
           * `<main>` clips it at exactly the page header, which is where the
           * region should stop, and because it travels with a sticky parent it
           * scrolls out of view the moment the rail pins — no second state to
           * keep in sync, and no phantom scroll height.
           */
          '&::before': {
            content: '""',
            position: 'absolute',
            left: -1,
            right: 0,
            top: { xs: -16, md: -24 },
            height: { xs: 16, md: 24 },
            bgcolor: 'inherit',
            borderLeft: '1px solid rgba(255, 255, 255, 0.14)',
          },
        }}
      >
        {/* No Tooltip on either: the strip already names itself just below, and
            a tooltip on a control that hides itself on click has no mouseleave
            to close it — it strands the bubble in the corner of the page. */}
        <IconButton
          size="small"
          aria-label="Show the activity feed"
          onClick={onOpen}
          sx={{ display: { xs: 'none', lg: 'inline-flex' } }}
        >
          <KeyboardDoubleArrowLeftIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Show the activity feed"
          onClick={onMobileOpen}
          sx={{ display: { xs: 'inline-flex', lg: 'none' } }}
        >
          <KeyboardDoubleArrowLeftIcon fontSize="small" />
        </IconButton>
        <Typography
          variant="caption"
          sx={{
            // Vertical, so the strip stays narrow enough to cost the page
            // almost nothing while still naming itself.
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            color: 'text.secondary',
            letterSpacing: '0.08em',
            userSelect: 'none',
          }}
        >
          Activity {items.length > 0 ? `· ${items.length}` : ''}
        </Typography>
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
          {renderBody({
            onDismiss: onMobileClose,
            label: 'Close the activity feed',
            icon: <CloseIcon fontSize="small" />,
          })}
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
