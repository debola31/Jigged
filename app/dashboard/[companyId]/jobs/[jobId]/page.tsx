'use client';

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CancelIcon from '@mui/icons-material/Cancel';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import PrintIcon from '@mui/icons-material/Print';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import Snackbar from '@mui/material/Snackbar';

import {
  getJobWithRelations,
  cancelJob,
  reopenJob,
  deleteJob,
} from '@/utils/jobsAccess';
import { getJobPartShipmentSummaries } from '@/utils/shipmentsAccess';
import type { JobWithRelations, JobPartWithRelations } from '@/types/job';
import type { JobPartShipmentSummary } from '@/types/shipment';
import { OperationsPanel, JobTravelerPreviewDialog, JobBillingShippingCard, JobPartMaterialsCard, JobEditForm, ShipmentsMenu, InvoicesMenu } from '@/components/jobs';
import JobOverdueBadge from '@/components/jobs/JobOverdueBadge';
import JobFulfillmentChip, { formatShipDate } from '@/components/jobs/JobStatusBlock';
import { ProductionStatusChip } from '@/components/jobs/JobStatusChip';
import JobAttachmentsInline from '@/components/jobs/JobAttachmentsInline';
import JobActivityRail, {
  captureRailToggle,
  readRailOpen,
  writeRailOpen,
} from '@/components/jobs/activity/JobActivityRail';
import { useJobActivity } from '@/hooks/useJobActivity';
import { getCurrentMember } from '@/utils/operatorAccess';
import { OutsideShipmentPreviewDialog } from '@/components/outsideShipments';
import { CreateShipmentModal } from '@/components/shipments';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';
import PushToQuickBooksDialog from '@/components/jobs/PushToQuickBooksDialog';
import {
  getJobPartInvoiceSummaries,
  type JobPartInvoiceSummary,
} from '@/utils/quickbooksAccess';

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<JobWithRelations | null>(null);
  const [partSummaries, setPartSummaries] = useState<JobPartShipmentSummary[]>([]);
  const [invoiceSummaries, setInvoiceSummaries] = useState<JobPartInvoiceSummary[]>([]);
  const [invoicesRefreshKey, setInvoicesRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [pendingPreviewShipmentId, setPendingPreviewShipmentId] = useState<string | null>(null);
  const [travelerPart, setTravelerPart] = useState<{ id: string; name: string | null } | null>(null);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushSuccess, setPushSuccess] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  // Anchor for the top-bar Print-Traveler part picker (shown when a job has
  // more than one part).
  const [travelerMenuAnchor, setTravelerMenuAnchor] = useState<null | HTMLElement>(null);

  /**
   * THE ACTIVITY RAIL.
   *
   * Two open states, not one. `railOpen` is the docked column above `lg`,
   * remembered per browser and defaulting OPEN — being discoverable without
   * being summoned is the whole reason this is a rail. `mobileRailOpen` is the
   * narrow-screen overlay and always starts false, so the Drawer's Modal never
   * mounts while the rail is docked and cannot fight it for focus.
   */
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailOpen());
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  /**
   * Which step the rail is narrowed to, as a THREE-state value.
   *
   * `undefined` means nobody has touched the filter, so a `?op=` deep link
   * still governs; `null` means it was explicitly cleared and the link should
   * not re-apply; a string is a step somebody picked. Derived rather than
   * synced in an effect — a `useEffect` that setState'd the link into the
   * filter is a cascading render, and clearing it would have needed a ref to
   * stop the effect immediately putting it back.
   */
  const [userFilterOpId, setUserFilterOpId] = useState<string | null | undefined>(undefined);
  const [member, setMember] = useState<{ id: string; isAdmin: boolean } | null>(null);
  /** The rail's own slip preview. OperationsPanel keeps its post-send one. */
  const [railSlipId, setRailSlipId] = useState<string | null>(null);
  /**
   * Bumped after any write the RAIL performs, and passed to OperationsPanel so
   * its own quantity ledgers re-read. `fetchJob` alone is not enough: the panel
   * loads summaries, actuals and the outside ledger through its own useLoads,
   * and without this a void in the rail would leave the step card still showing
   * the quantity it just undid.
   */
  const [activityVersion, setActivityVersion] = useState(0);

  const activity = useJobActivity(companyId, jobId, job?.created_at ?? null);
  const { reload: reloadActivity } = activity;


  const searchParams = useSearchParams();
  const deepLinkedOpId = searchParams.get('op');


  const fetchJob = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getJobWithRelations(jobId, companyId);
      setJob(data);
      try {
        const summaries = await getJobPartShipmentSummaries(jobId);
        setPartSummaries(summaries);
      } catch (err) {
        console.warn('Job detail: per-part shipment summaries failed', err);
      }
      try {
        const invSummaries = await getJobPartInvoiceSummaries(jobId);
        setInvoiceSummaries(invSummaries);
      } catch (err) {
        console.warn('Job detail: per-part invoice summaries failed', err);
      }
      // Notes are no longer read here. They belong to the activity rail, which
      // loads them through useJobActivity — and the bucketing this used to do
      // silently DROPPED every note without a job_operation_id, which is why
      // job-level notes have been invisible on this page since they shipped.
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId, companyId]);

  /**
   * THE ONE THING EVERY WRITE ON THIS PAGE CALLS.
   *
   * The page shows the same facts twice — a step card's quantities and status,
   * and the activity rail's row for the event that produced them — and they are
   * loaded by different hooks. Refreshing one is always wrong, and it was:
   * marking a step complete refreshed the cards and left the rail showing
   * nothing until a manual reload, because `onOperationUpdate` was wired
   * straight to `fetchJob`.
   *
   * There were three near-copies of this before, one per write path, and the
   * step cards called none of them. One function, called by all of them, is the
   * only shape where a new write cannot silently forget half the page:
   *
   *   - `reloadActivity` re-reads notes, completions and slips for the rail
   *   - `activityVersion` re-runs OperationsPanel's own quantity ledgers, which
   *     nothing outside that component can reach
   *   - `fetchJob` re-reads the job row for the status chips
   */
  const refreshAfterWrite = useCallback(async () => {
    await reloadActivity();
    setActivityVersion((n) => n + 1);
    await fetchJob();
  }, [reloadActivity, fetchJob]);

  useEffect(() => {
    // Data-fetch-on-mount false positive: fetchJob's setState all runs after
    // its await, not synchronously in this effect body (the documented class
    // the eslint.config.mjs note describes). Large page with many refetch
    // callers — kept as-is rather than restructured to the .then() shape.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchJob();
  }, [fetchJob]);

  /**
   * The signed-in member, for the rail's own-note edit/delete gates. Resolved
   * unconditionally rather than on first interaction — the gates render with
   * every note, not after a click.
   */
  useEffect(() => {
    let active = true;
    getCurrentMember(companyId)
      .then((m) => {
        if (active && m) setMember({ id: m.id, isAdmin: m.role === 'admin' });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [companyId]);

  // The QuickBooks invoice link used to be fetched here. Its comment claimed it
  // surfaced a "View invoice" deep link; nothing rendered it, and its only
  // reader was the delete guard above. Both are gone, and so is a round trip on
  // every job page load.


  const handleReopen = async () => {
    setActionLoading(true);
    try {
      await reopenJob(jobId);
      await fetchJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reopen job');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await cancelJob(jobId);
      await fetchJob();
      setCancelDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setActionLoading(false);
    }
  };

  // Explain-on-click instead of hiding/greying: deletion is gated by records of
  // value (a shipment or an invoice), not production status. If either exists,
  // say so immediately rather than opening a confirm dialog that only errors;
  // otherwise confirm + delete (any status).
  /**
   * NO RECORDS-OF-VALUE GUARDS. This refused to delete a job that had shipments
   * or a QuickBooks invoice, on the stated grounds that "the FK blocks either
   * way" — and that was simply not true. `deleteJob` is a SOFT delete: it stamps
   * `deleted_at` and nothing else, so no foreign key is ever tested and its own
   * comment says as much ("archiving preserves the row and its history, so it
   * can never orphan a record").
   *
   * So the access layer allowed it, the UI refused it, and a comment here
   * claimed the two agreed. CLAUDE.md's rule is the one to follow: an invoiced
   * job archives like anything else.
   */
  const handleDeleteClick = () => setDeleteDialogOpen(true);

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteJob(jobId, companyId);
      // Navigate away on success — the job (and this page) no longer exist.
      // Don't reset actionLoading here: the component unmounts on push.
      router.push(`/dashboard/${companyId}/jobs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  if (loading && !job) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!job) {
    return (
      <Box>
        <Alert severity="error">Job not found</Alert>
      </Box>
    );
  }

  const parts: JobPartWithRelations[] = job.job_parts ?? [];
  const canCancel =
    job.production_status !== 'completed' && job.production_status !== 'cancelled';
  const canReopen = job.production_status === 'cancelled';
  // Delete is shown on every job, in any production status — removal is gated by
  // records of value (a shipment or an invoice), not the status label, and that
  // gate is explained on click (see handleDeleteClick) rather than by hiding the
  // button. The access layer enforces the same gate as the backstop.
  const canShip =
    job.production_status !== 'cancelled' &&
    job.fulfillment_status !== 'fully_shipped' &&
    parts.length > 0;

  const summariesByPart = new Map(partSummaries.map((s) => [s.job_part_id, s]));

  // Print Traveler is a per-part action in the top bar: with one part it acts
  // directly; with several it opens a small picker menu.
  const handleTravelerClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (parts.length === 1) {
      setTravelerPart({ id: parts[0].id, name: parts[0].parts?.part_name ?? null });
    } else {
      setTravelerMenuAnchor(e.currentTarget);
    }
  };

  const handleCreated = async (result: {
    shipmentId: string;
    packingSlipNumber: string;
    pdfError?: Error | null;
  }) => {
    setShipModalOpen(false);
    // Force the history card to refetch + auto-open the preview on the new row.
    setPendingPreviewShipmentId(result.shipmentId);
    setHistoryRefreshKey((k) => k + 1);
    // Re-pull job + per-part summary so status block + parts row reflect the new shipment.
    await fetchJob();
  };

  // Single edit surface: the "Edit" button flips the page into JobEditForm
  // (PO/due date, addresses, contact, and per-line qty/price with the same
  // invoice/shipped locks), saved in one go — no scattered per-section edits.
  if (editMode) {
    return (
      <JobEditForm
        job={job}
        companyId={companyId}
        shippedByPart={new Map(partSummaries.map((s) => [s.job_part_id, s.qty_shipped]))}
        invoicedByPart={new Map(invoiceSummaries.map((s) => [s.job_part_id, s.qty_invoiced]))}
        onCancel={() => setEditMode(false)}
        onSaved={async () => {
          setEditMode(false);
          await fetchJob();
        }}
      />
    );
  }

  /**
   * A `?op=` deep link scroll-highlights the step (OperationsPanel) and narrows
   * the rail to it — landing on a highlighted step with its history already
   * showing is the moment the rail earns the width it costs.
   *
   * Resolves to null until the job loads, and again if the id names a step this
   * job does not have: a filter chip labelled with a step nobody can see would
   * be worse than no chip.
   */
  const activeFilterOpId = userFilterOpId !== undefined ? userFilterOpId : deepLinkedOpId;
  const railFilter = (() => {
    if (!activeFilterOpId) return null;
    const step = job?.job_parts
      ?.flatMap((p) => p.job_operations ?? [])
      .find((o) => o.id === activeFilterOpId);
    return step ? { operationId: step.id, stepName: step.operation_name } : null;
  })();

  const railReserved = railOpen;
  const headerCardSpan = railReserved
    ? ({ xs: 12, xl: 6 } as const)
    : ({ xs: 12, md: 6 } as const);

  // Fired by the collapsed strip, which is now the only way in — there is no
  // toolbar button. It sat among Print Traveler and the Shipments dropdown
  // reading as "open a thing" rather than "this region is collapsed", and two
  // controls for one pane is one more than the page needs.
  const openRail = () => {
    setRailOpen(true);
    writeRailOpen(true);
    captureRailToggle(true, true);
  };
  const closeRail = () => {
    setRailOpen(false);
    writeRailOpen(false);
    captureRailToggle(false, true);
  };

  return (
    /* The rail is an in-flow column, so it reserves its own width and there is
       no second number to keep in sync with it — the trap LocationsManager has
       to work around for its persistent drawer. */
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: { lg: 3 } }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/jobs`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Jobs
      </Button>

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          mb: 2,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography
            variant="h4"
            component="h1"
            sx={{ fontSize: { xs: '1.5rem', md: '2.125rem' } }}
          >
            {job.job_number}
          </Typography>
          <JobOverdueBadge job={job} size="medium" />
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {parts.length > 0 && (
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => setEditMode(true)}
              disabled={actionLoading}
            >
              Edit
            </Button>
          )}
          {parts.length > 0 && (
            <Button
              variant="outlined"
              startIcon={<PrintIcon />}
              onClick={handleTravelerClick}
              disabled={actionLoading}
            >
              Print Traveler
            </Button>
          )}
          {/* Shipments + invoices are dropdowns (view existing + create) so both are
              reachable from the top without scrolling, and the toolbar doesn't grow a
              separate button per action. Full detail lives in the Fulfillment section. */}
          {parts.length > 0 && (
            <ShipmentsMenu
              jobId={jobId}
              refreshKey={historyRefreshKey}
              canShip={canShip}
              onCreate={() => setShipModalOpen(true)}
              onVoided={fetchJob}
              disabled={actionLoading}
            />
          )}
          {/* NO second slip menu here, deliberately. A "Vendor slips" dropdown
              sitting beside "Shipments" put two packing-slip menus on one
              toolbar, and telling them apart meant reading the labels rather
              than seeing the difference — on the surface where picking the
              wrong one sends a customer's paperwork to a plater. A job's vendor
              slips live on the OPERATION that produced them (expand it for the
              slip history) and in the Jobs-page drawer, which is where "what is
              out" is actually asked. */
          }
          {parts.length > 0 && (
            <InvoicesMenu
              companyId={companyId}
              jobId={jobId}
              refreshKey={invoicesRefreshKey}
              onCreate={() => setPushDialogOpen(true)}
              disabled={actionLoading}
            />
          )}

          {/* Reopen / Cancel, then Delete last — the destructive control is
              rightmost and red at rest, per interaction-standards.md.

              These were briefly behind a kebab. Delete came back out because it
              already ends in a confirm dialog, so the overflow was a second
              guard on an action that was not unguarded — it only made a rare
              thing slower to find. Cancel came with it: a menu holding one item
              is worse than no menu. */}
          {canReopen && (
            <Button
              variant="outlined"
              startIcon={<RestartAltIcon />}
              onClick={handleReopen}
              disabled={actionLoading}
            >
              Reopen
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<CancelIcon />}
              onClick={() => setCancelDialogOpen(true)}
              disabled={actionLoading}
            >
              Cancel
            </Button>
          )}
          <Tooltip title="Delete job">
            <span>
              <IconButton
                color="error"
                onClick={handleDeleteClick}
                disabled={actionLoading}
                aria-label="Delete job"
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>


      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* WITH THE RAIL OPEN THE CONTENT COLUMN IS 568px AT `lg`, which would put
          these two cards at 284px each. The span follows the rail rather than a
          raw breakpoint, so they stack until there is genuinely room for two. */}
      <Grid container spacing={3}>
        {/* Compact details + billing, side by side (mirrors the edit view). */}
        <Grid size={headerCardSpan}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job Details
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {/* TWO EXPLICIT COLUMNS, not a grid the fields flow through.
                  Auto-flow put them in DOM order — Customer | PO, Source |
                  Production, Fulfillment | Created — which reads as neither a
                  list nor a pair of lists. Each column is its own stack now, so
                  what sits beside what is a decision rather than a consequence
                  of the order somebody happened to write them in.

                  Left is what the job IS, right is where it STANDS. */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  columnGap: 3,
                  alignItems: 'start',
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer
                    </Typography>
                    {job.customers ? (
                      <MuiLink
                        component={Link}
                        href={`/dashboard/${companyId}/customers/${job.customer_id}`}
                        sx={{ display: 'block', fontWeight: 500 }}
                      >
                        {job.customers.name}
                      </MuiLink>
                    ) : (
                      <Typography>—</Typography>
                    )}
                  </Box>

                  {job.quote_id && job.quotes && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Source
                      </Typography>
                      <MuiLink
                        component={Link}
                        href={`/dashboard/${companyId}/quotes/${job.quote_id}`}
                        sx={{ display: 'block', fontWeight: 500 }}
                      >
                        Quote {job.quotes.quote_number}
                      </MuiLink>
                    </Box>
                  )}

                  {/* Created is not here. It is the activity feed's oldest
                      row — where a date is the start of a sequence rather than
                      a fact with no neighbours, and where it stops a new job's
                      feed from opening empty. */}
                  {job.due_date && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Due
                      </Typography>
                      <Typography fontWeight={500}>{formatShipDate(job.due_date)}</Typography>
                    </Box>
                  )}
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  {/* UNCONDITIONAL, unlike the other optional fields, because the
                      paperclip lives here: attachments are the customer's PO
                      PDF, and hiding the row when there is no PO NUMBER would
                      make a file on such a job unreachable from this page. One
                      "—" is cheaper than an orphaned document. */}
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer PO
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Typography fontWeight={500}>{job.customer_po_number || '—'}</Typography>
                      <JobAttachmentsInline jobId={jobId} />
                    </Box>
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Fulfillment
                    </Typography>
                    <Box sx={{ mt: 0.25 }}>
                      <JobFulfillmentChip job={job} parts={parts} />
                    </Box>
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Production
                    </Typography>
                    <Box sx={{ mt: 0.25 }}>
                      <ProductionStatusChip status={job.production_status} size="medium" />
                    </Box>
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={headerCardSpan}>
          <JobBillingShippingCard job={job} companyId={companyId} onUpdated={fetchJob} readOnly />
        </Grid>

        {/* No section header and no collapse. A job carries one part, so a
            "Production · 1 part" heading over a single part was a count of one
            and a control that only ever hid the thing people came to see. */}
        <Grid size={{ xs: 12 }}>
              {parts.length === 0 ? (
                <Typography color="text.secondary" sx={{ px: 1 }}>
                  No parts on this job.
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {parts.map((part) => {
                    const summary = summariesByPart.get(part.id);
                    return (
                      <Box key={part.id}>
                        {/* Per-part fulfillment is shown as the "X of Y shipped" text below,
                            not a chip — the single job-level fulfillment chip lives up top
                            (mirrors how production status is one chip, not one per part). */}
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 1.5,
                            flexWrap: 'wrap',
                            mb: 1,
                          }}
                        >
                          <MuiLink
                            component={Link}
                            href={`/dashboard/${companyId}/parts/${part.part_id}`}
                            sx={{ fontWeight: 600, fontSize: '1.05rem' }}
                          >
                            {part.parts?.part_name ?? 'Part'}
                          </MuiLink>
                          {part.parts?.description && (
                            <Typography variant="body2" color="text.secondary">
                              {part.parts.description}
                            </Typography>
                          )}
                          <Chip
                            size="small"
                            label={`Order qty ${part.quantity}`}
                            variant="outlined"
                          />
                          {summary && summary.qty_shipped > 0 && (
                            <Typography variant="body2" color="text.secondary">
                              {summary.qty_shipped} of {summary.qty_ordered} shipped
                              {summary.qty_remaining > 0
                                ? ` · ${summary.qty_remaining} remaining`
                                : ''}
                            </Typography>
                          )}
                        </Box>
                        {part.job_operations && part.job_operations.length > 0 ? (
                          <OperationsPanel
                            job={job}
                            operations={part.job_operations}
                            onOperationUpdate={refreshAfterWrite}
                            disabled={actionLoading}
                            noteCounts={activity.noteCounts}
                            onShowActivity={(operationId) => {
                              setUserFilterOpId(operationId);
                              // On a narrow screen the rail is an overlay, so
                              // filtering it without opening it would look like
                              // the press did nothing.
                              setMobileRailOpen(true);
                              if (!railOpen) openRail();
                            }}
                            refreshSignal={activityVersion}
                            // The outside-send dialog names the part in its
                            // subtitle; without this it would repeat the process
                            // name twice, which reads as a rendering bug.
                            partName={part.parts?.part_name ?? null}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ pl: 1 }}
                          >
                            No operations on this part.
                          </Typography>
                        )}
                        <Box sx={{ mt: 2 }}>
                          <JobPartMaterialsCard
                            partId={part.part_id}
                            jobId={job.id}
                            jobPartId={part.id}
                            orderQuantity={part.quantity}
                          />
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              )}
        </Grid>

        {/* Shipping + invoicing now live entirely in the top toolbar dropdowns
            (Shipments / Invoices), so there's no bottom Fulfillment section.
            Attachments moved up into the Job Details card (read-only there;
            add/remove on the Edit screen). */}
      </Grid>

      <Dialog open={cancelDialogOpen} onClose={() => setCancelDialogOpen(false)}>
        <DialogTitle>Cancel Job?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to cancel <strong>{job.job_number}</strong>? Every part on the
            job will be marked cancelled. You can reopen the job later.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelDialogOpen(false)} disabled={actionLoading}>
            Keep Job
          </Button>
          <Button
            onClick={handleCancel}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <CancelIcon />}
          >
            {actionLoading ? 'Cancelling…' : 'Cancel Job'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onClose={actionLoading ? undefined : () => setDeleteDialogOpen(false)}
      >
        <DialogTitle>Delete Job?</DialogTitle>
        <DialogContent>
          {/* WHAT IT ACTUALLY DOES. This said the delete "permanently removes
              the job and all of its parts, operations, notes, and attachments"
              and "cannot be undone". None of that was true: `deleteJob` stamps
              `deleted_at` and returns, every shipment and invoice keeps
              resolving, and clearing the column brings it back. Overstating a
              consequence is not a safe kind of wrong — it is what stopped
              people archiving jobs they were entitled to archive. */}
          <Typography>
            Delete <strong>{job.job_number}</strong>? It comes off the jobs list and out of
            searches. Shipments, invoices and packing slips that reference it keep working, and
            the record is kept.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Keep Job
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {actionLoading ? 'Deleting…' : 'Delete Job'}
          </Button>
        </DialogActions>
      </Dialog>

      <CreateShipmentModal
        open={shipModalOpen}
        jobId={jobId}
        companyId={companyId}
        onClose={() => setShipModalOpen(false)}
        onCreated={handleCreated}
      />

      {/* Auto-preview the packing slip right after a shipment is created. */}
      <PackingSlipPreviewDialog
        open={!!pendingPreviewShipmentId}
        shipmentId={pendingPreviewShipmentId}
        onClose={() => setPendingPreviewShipmentId(null)}
      />

      <JobTravelerPreviewDialog
        open={travelerPart !== null}
        jobPartId={travelerPart?.id ?? null}
        jobId={jobId}
        companyId={companyId}
        partName={travelerPart?.name ?? null}
        onClose={() => setTravelerPart(null)}
      />

      <PushToQuickBooksDialog
        open={pushDialogOpen}
        companyId={companyId}
        jobId={jobId}
        jobNumber={job.job_number}
        onClose={() => setPushDialogOpen(false)}
        onPushed={(message) => {
          setPushDialogOpen(false);
          setPushSuccess(message);
          setInvoicesRefreshKey((k) => k + 1);
          // Refresh job (invoicing_status) + per-part invoice summaries so the toolbar,
          // edit-form floor, and per-part breakdown reflect the new invoice.
          fetchJob();
        }}
      />

      <Menu
        anchorEl={travelerMenuAnchor}
        open={!!travelerMenuAnchor}
        onClose={() => setTravelerMenuAnchor(null)}
      >
        {parts.map((p) => (
          <MenuItem
            key={p.id}
            onClick={() => {
              setTravelerMenuAnchor(null);
              setTravelerPart({ id: p.id, name: p.parts?.part_name ?? null });
            }}
          >
            {p.parts?.part_name ?? 'Part'}
          </MenuItem>
        ))}
      </Menu>

      <Snackbar
        open={!!pushSuccess}
        autoHideDuration={5000}
        onClose={() => setPushSuccess(null)}
        message={pushSuccess ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      />

      {/* The rail's slip preview. OperationsPanel keeps its own for the
          auto-preview after a send; only one is ever open, and each reloads
          both halves of the page so a void cannot update one and not the
          other. */}
      <OutsideShipmentPreviewDialog
        open={railSlipId !== null}
        shipmentId={railSlipId}
        onClose={() => setRailSlipId(null)}
        onVoided={() => {
          void refreshAfterWrite();
        }}
      />
      </Box>

      <JobActivityRail
        companyId={companyId}
        jobId={jobId}
        items={activity.items}
        loading={activity.loading}
        error={activity.error}
        reload={refreshAfterWrite}
        memberId={member?.id ?? null}
        isAdmin={member?.isAdmin ?? false}
        open={railOpen}
        onClose={closeRail}
        onOpen={openRail}
        mobileOpen={mobileRailOpen}
        onMobileOpen={() => {
          setMobileRailOpen(true);
          captureRailToggle(true, false);
        }}
        onMobileClose={() => {
          setMobileRailOpen(false);
          captureRailToggle(false, false);
        }}
        filter={railFilter}
        onClearFilter={() => setUserFilterOpId(null)}
        onViewSlip={setRailSlipId}
      />
    </Box>
  );
}
