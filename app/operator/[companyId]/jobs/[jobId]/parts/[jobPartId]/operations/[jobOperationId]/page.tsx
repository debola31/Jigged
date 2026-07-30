'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TextField from '@mui/material/TextField';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import UndoIcon from '@mui/icons-material/Undo';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import {
  getOperatorOperationDetail,
  getCurrentMember,
  revertOperationCompletion,
  markOperationSent,
  markOperationReceived,
} from '@/utils/operatorAccess';
import {
  createOperationCompletion,
  getOperationCompletionSummaries,
} from '@/utils/operationCompletionsAccess';
import {
  operationCompletionConsequence,
  completionConsequenceCaption,
} from '@/components/operations/operationMath';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import { useSetOperatorChrome, useOperatorNav } from '@/components/operator/OperatorChromeContext';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import StationSelector from '@/components/operator/StationSelector';
import JobFeed from '@/components/operator/JobFeed';
import NoteCaptureFields from '@/components/operator/NoteCaptureFields';
import { useNoteCapture } from '@/hooks/useNoteCapture';
import PartReferenceRow from '@/components/operator/PartReferenceRow';

/**
 * Action view for ONE specific operation on a job_part. Reached by tapping a
 * step on the traveler, or directly from the station-scoped jobs list.
 *
 * Operators record how many GOOD pieces they finished: one number field that
 * defaults to the full remaining balance, so RECORD COMPLETION completes the
 * operation by default and records a partial when the number is dialled down
 * (each event appends to job_operation_completions; a DB trigger derives the
 * op status). No "start", no pause/exit, no on-job timer (shop operators don't
 * reliably start/pause/resume, so we don't pretend to track that time). Undo
 * voids the recorded completions. Loads by job_operation_id so the exact step
 * the operator chose is the one actioned.
 *
 * Station guard: recording requires a selected station (StationSelector prompts
 * when none is set). If the step's work center doesn't match the operator's
 * station — the likely signature of a wrong QR scan — the action is replaced
 * by a guide with a one-tap "switch & complete" (for legit cross-station work)
 * and a way back to the traveler.
 */
const OP_DETAILS_KEY = 'jigged:op-details-expanded';


export default function OperatorOperationActionPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;
  const jobOperationId = params.jobOperationId as string;

  const travelerHref = `/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}`;

  const { stationId, stationName, initializing } = useStationContext();
  const nav = useOperatorNav();

  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Good-quantity the operator is about to record. Blank until the summary loads,
  // then defaults to the remaining balance (dialled down for a partial).
  const [qtyInput, setQtyInput] = useState('');
  const [qtyDirty, setQtyDirty] = useState(false);
  // Bumped after this page writes a note, so the feed below reloads and shows
  // it. Replaces the old capture-offer signal: there is no prompt any more,
  // because capture happens in the completion block itself.
  const [feedRefreshSignal, setFeedRefreshSignal] = useState(0);

  // Job-card details, collapsed by default. STICKY across steps: an operator who
  // wants the customer and the order quantity wants them on the next step too,
  // and re-opening it every time is its own friction. sessionStorage rather than
  // localStorage on purpose — this survives navigation, and whether it should
  // survive across days (a remembered per-user preference) is a separate
  // decision we have not made yet.
  const [detailsOpen, setDetailsOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.sessionStorage.getItem(OP_DETAILS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(OP_DETAILS_KEY, detailsOpen ? '1' : '0');
    } catch {
      /* private mode / quota — the preference is best-effort */
    }
  }, [detailsOpen]);

  // Header back pops in-app history (nav.goBack). This href is only the deep-link
  // fallback — the part's traveler — for an operation scanned into directly.
  useSetOperatorChrome({ back: { href: travelerHref, label: 'Back to traveler' } }, [travelerHref]);

  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentMember(companyId);
      if (operator) setCurrentOperatorId(operator.id);
    }
    loadOperator();
  }, [companyId]);

  // Top of the funnel for the reader flow: they reached a step. Compared against
  // prior_notes_opened this is what shows whether prior knowledge is being found
  // — notes written but never opened is a discoverability problem, not a
  // motivation one, and only these two numbers together can tell them apart.
  //
  // Keyed on the operation so re-renders don't re-count, and fired regardless of
  // whether a station is selected — landing here and bouncing off the station
  // picker is itself a funnel step worth seeing.
  useEffect(() => {
    logOperatorEvent(companyId, 'op_card_opened', { jobOperationId });
  }, [companyId, jobOperationId]);

  const {
    data: job,
    loading,
    reload: loadJob,
  } = useLoad(
    () => getOperatorOperationDetail(jobOperationId, companyId),
    [jobOperationId, companyId],
    {
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to load operation');
      },
    },
  );

  // Good/remaining for THIS op (partial-completion progress). Separate load so a
  // completion re-reads the counts without refetching the whole detail graph.
  const { data: summary, reload: loadSummary } = useLoad(
    () =>
      getOperationCompletionSummaries(jobPartId).then(
        (rows) => rows.find((r) => r.job_operation_id === jobOperationId) ?? null,
      ),
    [jobPartId, jobOperationId],
  );

  const target = summary?.target ?? job?.part_quantity ?? 0;
  const qtyGood = summary?.qty_good ?? 0;
  const remaining = summary?.qty_remaining ?? Math.max(0, target - qtyGood);

  // The field shows the remaining balance by default (states its own outcome,
  // like the shipment form's prefill) until the operator edits it — derived, not
  // an effect, so there's no setState-in-effect cascade. A successful record
  // clears the dirty flag, snapping the value back to the new remaining.
  const isExternal = job?.operation_work_center_kind === 'external';
  const isCompleted = job?.operation_status === 'completed';

  // Capture belongs to the completion action, so it is enabled on exactly the
  // branch that renders RECORD COMPLETION. A completed step and an outside step
  // have no completion to attach a note to, so the feed keeps its own composer
  // there (standaloneCapture below) — otherwise finishing a step would make it
  // impossible to add the photo afterwards, and an outside step could never
  // carry "sent to coater, back on the 16th".
  const ownsCapture = !isCompleted && !isExternal;
  const capture = useNoteCapture({
    companyId,
    jobId,
    operatorId: currentOperatorId,
    context: { jobPartId, jobOperationId },
    enabled: ownsCapture,
  });

  const qtyValue = qtyDirty ? qtyInput : remaining > 0 ? String(remaining) : '';

  // What the single primary button will do. Completing takes precedence: a
  // quantity in the field is a statement about production, and the note rides
  // along with it.
  const canComplete = Number(qtyValue) > 0;
  const noteOnly = !canComplete && capture.hasContent;

  const reloadAll = async () => {
    await Promise.all([loadJob(), loadSummary()]);
  };

  // Record a specific good quantity. Over-completion is allowed (warned, not
  // blocked) — the only floor is > 0.
  const handleRecord = async () => {
    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }
    const qty = Number(qtyValue);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter how many good pieces you finished.');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      await createOperationCompletion({
        companyId,
        jobOperationId,
        jobPartId,
        quantityGood: qty,
      });
      setQtyDirty(false);
      // After the write resolves — a failed completion is not a completion.
      logOperatorEvent(companyId, 'completion_recorded', { jobOperationId, quantityGood: qty });

      // ORDER IS LOAD-BEARING, AND DELIBERATELY NOT ATOMIC.
      //
      // The completion is already durable by the time we get here. The note is
      // attempted second so that a failed photo upload — the slowest, most
      // failure-prone part of the whole flow on shop wifi — can never un-complete
      // a finished step. Wrapping both in a transaction would be worse, not
      // better: it would roll back real work because an image did not upload.
      //
      // So a note failure surfaces on its own and the step stays complete. The
      // operator can retype it; they cannot un-finish the part they finished.
      if (capture.hasContent) {
        try {
          await capture.submit();
          setFeedRefreshSignal((n) => n + 1);
        } catch {
          // useNoteCapture puts the message in the fields, next to the text the
          // operator still has. Do not overwrite the page-level error with it —
          // "the completion worked, the note did not" is the accurate reading.
        }
      }

      await reloadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record completion');
    } finally {
      setActionLoading(false);
    }
  };

  // Save a note with NO completion.
  //
  // Closes a hole B4 opened. Capture rides on RECORD COMPLETION, and that button
  // requires qty > 0 — so an operator who finished ZERO pieces ("machine down",
  // "waiting on material", "tool chipped") had two options and both were bad:
  // say nothing, and lose exactly the knowledge this whole workstream exists to
  // capture; or type a false quantity to get the note saved, corrupting the
  // number that feeds costing and scheduling. Falsifying production data to
  // satisfy a UI constraint is far worse than an extra code path.
  //
  // No second composer and no extra chrome: the SAME field, and the primary
  // button says what it will actually do.
  const handleSaveNoteOnly = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await capture.submit();
      setFeedRefreshSignal((n) => n + 1);
    } catch {
      // useNoteCapture surfaces the message in the field itself.
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevert = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await revertOperationCompletion(jobOperationId);
      setQtyDirty(false);
      await reloadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to undo completion');
    } finally {
      setActionLoading(false);
    }
  };

  // Outside (external-vendor) op actions — the part leaves the shop for a vendor
  // (Mark Sent Out) and comes back (Mark Received). Distinct from Mark Complete.
  const handleSend = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await markOperationSent(jobOperationId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark sent out');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReceive = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await markOperationReceived(jobOperationId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark received');
    } finally {
      setActionLoading(false);
    }
  };

  const isSent = job?.operation_status === 'sent';
  const consequence = operationCompletionConsequence(qtyValue, remaining);

  // Wait for BOTH the job fetch and the station context's one-time init before
  // deciding what to render — otherwise the "no station" branch can flash for an
  // operator who actually has a stored station.
  if (loading || initializing) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!job) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">Operation not found</Alert>
      </Box>
    );
  }

  // No station selected yet — show ONLY a focused picker, never stacked beneath
  // the job card. Reaching this with a job loaded means the stored default
  // supplied no station — e.g. a first-time operator, or one who cleared it on
  // logout. Gated on `initializing` above so it can't flash for an operator who
  // does have a stored station.
  // Outside ops have no operator station (they run at a vendor), so they never
  // require a selected station and never trigger the station-match guard.
  if (!isCompleted && !isExternal && !stationId) {
    return <StationSelector subtitle="Select your station to complete this step." />;
  }

  // Station guard: a step whose work center differs from the operator's selected
  // station is the likely signature of a wrong traveler-QR scan, or of an
  // operator who never switched stations. (Can't catch a mis-scan between two
  // steps sharing one work center — the on-screen step name + Undo are the
  // backstop there.)
  const stationMismatch =
    !isCompleted &&
    !isExternal &&
    !!stationId &&
    !!job.operation_work_center_id &&
    job.operation_work_center_id !== stationId;

  return (
    // Bottom padding so the last of the feed can scroll clear of the sticky
    // action bar instead of ending underneath it — the documented failure mode
    // of sticky bars is obscuring the content or the error you need to read.
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Card
        elevation={2}
        sx={{ mb: 3, bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' }}
      >
        {/* THE WHOLE CARD TOGGLES. One target rather than a chevron button:
            a separate control for the same action is a second thing to aim at,
            and nesting it inside this action area would be invalid markup. The
            expanded section sits OUTSIDE this button for the same reason — it
            contains a real link. */}
        <CardActionArea
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
          aria-label={detailsOpen ? 'Hide job details' : 'Show job details'}
        >
        <CardContent sx={{ py: 1.5 }}>
          {/* ONE LINE BY DEFAULT: job number and part — what an operator needs to
              confirm they have the right thing in hand. Everything else is
              reference, and reference does not belong between someone and the
              button they came to press (ISA-101: relevance over detail; a step
              screen is a Level 1 action display, not a Level 3 detail display).
              The rest expands IN PLACE rather than on another page, so nobody
              loses their position mid-task. */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6" component="span" fontWeight={700} sx={{ flexShrink: 0 }}>
              {job.job_number}
            </Typography>
            <Typography variant="h6" color="text.secondary" sx={{ flexShrink: 0 }}>
              ·
            </Typography>
            <Typography variant="h6" noWrap sx={{ minWidth: 0 }}>
              {job.part_name || 'Part'}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {/* Decorative, NOT a button. The whole card is the tap target, so a
                separate chevron control would be a second target for the same
                action — and a nested one, which is invalid markup. It stays as the
                affordance: without any indicator nobody discovers the card
                expands at all. */}
            <ExpandMoreIcon
              sx={{
                flexShrink: 0,
                color: 'text.secondary',
                transition: 'transform 150ms',
                transform: detailsOpen ? 'rotate(180deg)' : 'none',
              }}
            />
          </Box>

          {/* FULL STRENGTH, not dimmed. Shop part descriptions frequently ARE the
              working instruction, because per-operation instructions are optional
              and often left blank — so whichever field the engineer chose is the
              one that matters, and the app cannot know which. Dimming this
              asserted "reference, not instruction", which is false exactly when it
              costs the most. Muted text draws less attention and raises the odds
              of a skip (NN/G), and ISA-101 requires every emphasis to carry a
              defined meaning — de-emphasis used as a guess carries none. */}
          {job.part_description && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {job.part_description}
            </Typography>
          )}

          {/* Distinguished by a LABEL, not by weight or a box.
              The two lines cannot be ranked: either may hold the engineer's
              instruction, since per-operation text is optional and often blank.
              So neither is dimmed — what is dimmed is the LABEL, which is chrome,
              never the content. That tells the operator WHICH they are reading
              (per-step vs per-part) without asserting which is more important,
              and it keeps emphasis free for the states that genuinely mean "look
              here now": the over-quantity error and the station mismatch.
              The earlier problem was the tinted box, not the label. */}
          {job.operation_instructions && (
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              {/* "Instructions:" — the same word the admin sees when writing this
                  field. ISA-101's consistency rule is about exactly this: an
                  operator and an engineer talking about the same box should use
                  the same name for it.
                  Same variant as the content, so the only difference between them
                  is colour. A smaller label beside larger text read as two
                  unrelated things rather than a label and its value, and the colon
                  does the demarcating that a size change was doing badly. */}
              <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                Instructions:
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {job.operation_instructions}
              </Typography>
            </Box>
          )}


          {/* ALWAYS VISIBLE, deliberately outside the expander: "where am I on
              this part" is the question a step screen exists to answer, and it
              must not depend on whether someone happened to expand the card. */}
          {job.operations_total > 1 && (
            <Box sx={{ mt: 1.5 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Part progress
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {job.operations_completed} of {job.operations_total} operations
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(job.operations_completed / job.operations_total) * 100}
                sx={{ height: 6, borderRadius: 1 }}
              />
            </Box>
          )}
        </CardContent>
      </CardActionArea>

          <Collapse in={detailsOpen} unmountOnExit>
          <Box sx={{ px: 2, pb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {job.customer_name || 'No customer'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Order qty {job.part_quantity}
          </Typography>

          {isExternal && (
            // Just name the vendor (matches the traveler/admin "Outside · …"
            // chip). The Mark Sent Out / Mark Received buttons below carry the
            // "what to do" — no separate instructional banner needed.
            <Box sx={{ mt: 1.5 }}>
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<LocalShippingIcon />}
                label={
                  job.operation_vendor_name
                    ? `Outside · ${job.operation_vendor_name}`
                    : 'Outside process'
                }
              />
            </Box>
          )}


          {!isCompleted && job.estimated_minutes != null && job.estimated_minutes > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Estimated:{' '}
              {job.estimated_minutes < 60
                ? `${Math.round(job.estimated_minutes)} min`
                : `${(job.estimated_minutes / 60).toFixed(1)} hrs`}
            </Typography>
          )}

          {/* The way to the full step list. It used to be the job number itself,
              which cannot stay now that the whole card is one tap target — a link
              nested inside a button is invalid and swallows one of the two taps.
              An explicit labelled link is also clearer than an icon nobody was
              told about. */}
          <Button
            variant="text"
            size="small"
            endIcon={<FormatListBulletedIcon fontSize="small" />}
            onClick={() => nav.push(travelerHref)}
            sx={{ mt: 0.5, ml: -1, minHeight: 44 }}
          >
            View all steps for {job.job_number}
          </Button>
          </Box>
          </Collapse>
      </Card>

      <PartReferenceRow
        companyId={companyId}
        partId={job.part_id}
        partName={job.part_name}
        excludeJobId={jobId}
        jobOperationId={jobOperationId}
        // The quantity shares the reference row rather than taking a line of its
        // own, and LEADS it: it is the input for this screen's primary action,
        // while Files and Playbook are reference. Three controls on one line is
        // what buys back the vertical space that pinning used to provide.
        leading={
          !isCompleted && !isExternal ? (
        <TextField
          label="Parts finished"
          type="number"
          value={qtyValue}
          onChange={(e) => {
            setQtyDirty(true);
            setQtyInput(e.target.value);
          }}
          inputProps={{ min: 0, inputMode: 'numeric', 'aria-label': 'Parts finished' }}
          fullWidth
          size="small"
          // Matched to the 48px reference buttons beside it: a taller control
          // reads as a different KIND of thing and pulls the eye for no reason.
          sx={{ '& .MuiOutlinedInput-root': { minHeight: 48 } }}
          error={consequence.kind === 'over'}
          helperText={
            consequence.kind === 'none'
              ? `Order qty ${target}${qtyGood > 0 ? ` · ${remaining} remaining` : ''}`
              : completionConsequenceCaption(consequence)
          }
          FormHelperTextProps={{
            sx: {
              color:
                consequence.kind === 'over'
                  ? 'error.main'
                  : consequence.kind === 'partial'
                    ? 'warning.main'
                    : consequence.kind === 'full'
                      ? 'success.main'
                      : 'text.secondary',
            },
          }}
        />
          ) : undefined
        }
      />

      {isCompleted ? (
        // The completed state IS the undo control — one element shows the status
        // (green check + "complete"/"received") and doubles as the button that
        // reverts it. For an outside op, undo steps back to "sent" (parts still
        // out), not straight to pending.
        <Button
          fullWidth
          variant="outlined"
          size="large"
          onClick={handleRevert}
          disabled={actionLoading}
          aria-label={isExternal ? 'Parts received — tap to undo' : 'This step is complete — tap to undo'}
          sx={{ minHeight: 56 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 1 }}>
            <CheckCircleIcon color="success" />
            <Box component="span" sx={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: '1.05rem' }}>
              {isExternal
                ? 'Parts received from the vendor'
                : `This step is complete${target > 0 ? ` — ${qtyGood} of ${target} good` : ''}`}
            </Box>
            {actionLoading ? (
              <CircularProgress size={18} />
            ) : (
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, opacity: 0.8, fontWeight: 500 }}>
                <UndoIcon fontSize="small" /> Undo
              </Box>
            )}
          </Box>
        </Button>
      ) : isExternal ? (
        // Outside op: send/receive, never Mark Complete. A pending op offers both
        // (received directly from pending is allowed — sent is optional); a sent
        // op shows "at vendor" + Mark Received + Undo send.
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {isSent && job.operation_sent_at && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, color: 'warning.main' }}>
              <LocalShippingIcon fontSize="small" sx={{ flexShrink: 0 }} />
              <Typography variant="body2" color="inherit">
                At the vendor since{' '}
                <strong>{new Date(job.operation_sent_at).toLocaleDateString()}</strong>. Mark
                received when the parts come back.
              </Typography>
            </Box>
          )}
          {!isSent && (
            <Button
              fullWidth
              variant="outlined"
              size="large"
              color="warning"
              startIcon={<LocalShippingIcon />}
              onClick={handleSend}
              disabled={actionLoading}
              sx={{ minHeight: 56, fontWeight: 600 }}
            >
              {actionLoading ? <CircularProgress size={22} /> : 'MARK SENT OUT'}
            </Button>
          )}
          <Button
            fullWidth
            variant="contained"
            size="large"
            color="primary"
            startIcon={<Inventory2Icon />}
            onClick={handleReceive}
            disabled={actionLoading}
            sx={{ minHeight: 64, fontSize: '1.25rem', fontWeight: 600 }}
          >
            {actionLoading ? <CircularProgress size={24} /> : 'MARK RECEIVED'}
          </Button>
          {isSent && (
            <Button
              fullWidth
              variant="text"
              size="small"
              color="inherit"
              startIcon={<UndoIcon />}
              onClick={handleRevert}
              disabled={actionLoading}
            >
              Undo send
            </Button>
          )}
        </Box>
      ) : (
        // Not completed. Operators record how many GOOD pieces they finished —
        // the field defaults to the remaining balance (states its own outcome)
        // and a partial leaves the rest outstanding. A station mismatch only
        // WARNS (completion keys off the operation id, not the station).
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {stationMismatch && (
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 0.5, color: 'warning.main' }}>
              <WarningAmberIcon fontSize="small" sx={{ mt: 0.25, flexShrink: 0 }} />
              <Typography variant="body2" color="inherit">
                You&apos;re at <strong>{stationName || 'another station'}</strong>, but this step runs
                at <strong>{job.operation_work_center_name || 'another station'}</strong>.
              </Typography>
            </Box>
          )}

          {qtyGood > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 0.5 }}>
              {qtyGood} of {target} good so far · {remaining} remaining
            </Typography>
          )}


          {/* CAPTURE, MERGED INTO COMPLETION.
              Finishing a step and writing down what you learned are one act, one
              button, one commit. It used to be two: RECORD COMPLETION, then a
              separate offer, then a separate Post — and the middle of that had no
              durability, so attaching a photo showed a thumbnail, read as
              finished, and was discarded by a back tap. There is no second Post
              to forget now.
              Optional, always: completion works with the field left empty. */}
          <NoteCaptureFields
            capture={capture}
            placeholder="Anything worth noting for next time?"
            disabled={actionLoading}
            compact
          />

          {/* STICKY, and that is the point. The action used to sit in normal flow
              and fell below the fold on a 6.9" phone as soon as anything was added
              above it — which B4 promptly did. Decluttering fixes that for today;
              sticking it to the bottom makes it structurally impossible to break
              again, and puts it in the thumb's green zone where the reachability
              research says a primary action belongs. It sits inside the scrolling
              region, so it lands directly above the bottom nav rather than over
              it, and the errors above it stay visible. */}
          {/* IN NORMAL FLOW, not pinned. A fixed bar guaranteed the action was
              always reachable but overlaid the content beneath it, so it was
              reverted by decision. The protection now comes from density instead:
              the quantity field shares a row with Files/Playbook and the job card
              collapses to a few lines, which keeps this above the fold on a tall
              phone. That is a weaker guarantee than pinning — if this screen grows
              again the action can drift off-screen, which is exactly how it broke
              the first time. Measure before adding anything above it. */}
          <Box>
            {/* One button, and it says what it will do. The quantity field
                defaults to the full remaining balance, so this records a full
                completion by default and a partial when the number is dialled
                down. With nothing finished but something typed it saves the note
                alone — better than a dead button that does not explain itself. */}
            <Button
              fullWidth
              variant="contained"
              size="large"
              color="primary"
              startIcon={canComplete ? <CheckCircleIcon /> : <NoteAddIcon />}
              onClick={canComplete ? handleRecord : handleSaveNoteOnly}
              disabled={actionLoading || (!canComplete && !noteOnly)}
              sx={{ minHeight: 64, fontSize: '1.15rem', fontWeight: 600 }}
            >
              {actionLoading ? (
                <CircularProgress size={24} />
              ) : canComplete ? (
                'RECORD COMPLETION'
              ) : (
                'SAVE NOTE'
              )}
            </Button>
          </Box>

          {qtyGood > 0 && (
            <Button
              fullWidth
              variant="text"
              color="inherit"
              startIcon={<UndoIcon fontSize="small" />}
              onClick={handleRevert}
              disabled={actionLoading}
              sx={{ minHeight: 44, opacity: 0.8 }}
            >
              Undo all ({qtyGood})
            </Button>
          )}
        </Box>
      )}

      {/* Job feed — capture notes/photos for THIS step (auto-tagged), and read
          the whole job's feed. This is the primary capture surface: operators
          land here from the per-operation QR. */}
      <Box sx={{ mt: 3 }}>
        <JobFeed
          jobId={jobId}
          companyId={companyId}
          refreshSignal={feedRefreshSignal}
          // Only where this page's completion block is not rendered — see
          // ownsCapture. Two composers on one screen would be a bug, and none
          // would strand a finished or outside step with no way to add a photo.
          standaloneCapture={!ownsCapture}
          operationContext={{
            jobPartId,
            jobOperationId,
          }}
        />
      </Box>

    </Box>
  );
}
