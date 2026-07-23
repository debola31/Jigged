'use client';

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
import Stack from '@mui/material/Stack';
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
  updateJobDetails,
} from '@/utils/jobsAccess';
import { getJobPartShipmentSummaries, countShipmentsForJob } from '@/utils/shipmentsAccess';
import type { JobWithRelations, JobPartWithRelations } from '@/types/job';
import { isJobClosed } from '@/types/job';
import type { JobPartShipmentSummary } from '@/types/shipment';
import type { JobNote } from '@/types/operator';
import { getJobNotes } from '@/utils/operatorAccess';
import { OperationsPanel, JobTravelerPreviewDialog, JobBillingShippingCard, JobPartMaterialsCard, JobEditForm, CollapsibleSection, ShipmentsMenu, InvoicesMenu } from '@/components/jobs';
import JobOverdueBadge from '@/components/jobs/JobOverdueBadge';
import JobHotBadge from '@/components/jobs/JobHotBadge';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import LocalFireDepartmentOutlinedIcon from '@mui/icons-material/LocalFireDepartmentOutlined';
import JobStatusBlock from '@/components/jobs/JobStatusBlock';
import { CreateShipmentModal } from '@/components/shipments';
import PackingSlipPreviewDialog from '@/components/shipments/PackingSlipPreviewDialog';
import PushToQuickBooksDialog from '@/components/jobs/PushToQuickBooksDialog';
import JobAttachmentsCard from '@/components/jobs/JobAttachmentsCard';
import {
  getQuickBooksInvoiceLinkForJob,
  getJobPartInvoiceSummaries,
  type QuickBooksInvoiceLink,
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
  const [notesByOperation, setNotesByOperation] = useState<Map<string, JobNote[]>>(new Map());
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
  const [qbInvoiceLink, setQbInvoiceLink] = useState<QuickBooksInvoiceLink | null>(null);
  const [shipmentCount, setShipmentCount] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(false);
  // Anchor for the top-bar Print-Traveler part picker (shown when a job has
  // more than one part).
  const [travelerMenuAnchor, setTravelerMenuAnchor] = useState<null | HTMLElement>(null);


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
      try {
        // Operator step-tagged notes + photos, grouped by operation, so an
        // operation's expand can show who noted what (and any pictures) —
        // regardless of completion status, so pending-op notes surface too.
        const allNotes = await getJobNotes(jobId, companyId);
        const byOp = new Map<string, JobNote[]>();
        for (const n of allNotes) {
          if (!n.job_operation_id) continue;
          const arr = byOp.get(n.job_operation_id) ?? [];
          arr.push(n);
          byOp.set(n.job_operation_id, arr);
        }
        // getJobNotes is newest-first; show a step's notes oldest-first.
        for (const arr of byOp.values()) arr.reverse();
        setNotesByOperation(byOp);
      } catch (err) {
        console.warn('Job detail: step notes failed', err);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId, companyId]);

  useEffect(() => {
    // Data-fetch-on-mount false positive: fetchJob's setState all runs after
    // its await, not synchronously in this effect body (the documented class
    // the eslint.config.mjs note describes). Large page with many refetch
    // callers — kept as-is rather than restructured to the .then() shape.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchJob();
  }, [fetchJob]);

  // Surface a "View invoice" deep link if this job already has a QBO invoice.
  // Plain Supabase read (no AI), safe on mount.
  useEffect(() => {
    let cancelled = false;
    getQuickBooksInvoiceLinkForJob(companyId, jobId)
      .then((link) => {
        if (!cancelled) setQbInvoiceLink(link);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId, jobId]);

  // Deletability depends on having no shipment records (voided included — the FK
  // blocks either way). Fetch the count so we only OFFER Delete when it can
  // actually succeed, instead of letting the user confirm and then hit an error.
  useEffect(() => {
    let cancelled = false;
    countShipmentsForJob(jobId)
      .then((n) => {
        if (!cancelled) setShipmentCount(n);
      })
      .catch(() => {
        if (!cancelled) setShipmentCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

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

  const handleToggleHot = async () => {
    if (!job) return;
    setActionLoading(true);
    try {
      const updated = await updateJobDetails(jobId, companyId, { is_hot: !job.is_hot });
      // Merge onto the hydrated job so we keep the joined relations fetchJob loaded.
      setJob((prev) => (prev ? { ...prev, is_hot: updated.is_hot } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Hot status');
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
  const handleDeleteClick = () => {
    if (shipmentCount && shipmentCount > 0) {
      setError(
        "This job has shipment records, so it's kept for recordkeeping and can't be deleted.",
      );
      return;
    }
    if (qbInvoiceLink) {
      setError(
        "This job has been invoiced in QuickBooks, so it's kept for recordkeeping and can't be deleted.",
      );
      return;
    }
    setDeleteDialogOpen(true);
  };

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

  return (
    <Box>
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
          <JobHotBadge job={job} size="medium" muted={isJobClosed(job)} />
          <JobOverdueBadge job={job} size="medium" />
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant={job.is_hot ? 'contained' : 'outlined'}
            color="error"
            startIcon={
              job.is_hot ? <LocalFireDepartmentOutlinedIcon /> : <LocalFireDepartmentIcon />
            }
            onClick={handleToggleHot}
            disabled={actionLoading}
          >
            {job.is_hot ? 'Unmark Hot' : 'Mark Hot'}
          </Button>
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
          {parts.length > 0 && (
            <InvoicesMenu
              companyId={companyId}
              jobId={jobId}
              refreshKey={invoicesRefreshKey}
              onCreate={() => setPushDialogOpen(true)}
              disabled={actionLoading}
            />
          )}

          {/* The negative cluster sits at the right, after the benign + invoice
              actions: the lifecycle toggle (Reopen/Cancel) then Delete last. */}
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

      <JobStatusBlock job={job} parts={parts} />

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Compact details + billing, side by side (mirrors the edit view). */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job Details
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Stack spacing={1.5}>
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
                {job.customer_po_number && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer PO
                    </Typography>
                    <Typography fontWeight={500}>{job.customer_po_number}</Typography>
                  </Box>
                )}
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
                {/* Attachments (customer PO PDF, drawings) live here with the rest of the
                    job metadata — read-only; adding/removing is on the Edit screen. */}
                <JobAttachmentsCard jobId={jobId} companyId={companyId} readOnly embedded />
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <JobBillingShippingCard job={job} companyId={companyId} onUpdated={fetchJob} readOnly />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <CollapsibleSection
            title="Production"
            defaultExpanded
            summary={
              <Typography variant="body2" color="text.secondary">
                {parts.length} {parts.length === 1 ? 'part' : 'parts'}
              </Typography>
            }
          >
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
                            onOperationUpdate={fetchJob}
                            disabled={actionLoading}
                            notesByOperation={notesByOperation}
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
                          <JobPartMaterialsCard partId={part.part_id} orderQuantity={part.quantity} />
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              )}
          </CollapsibleSection>
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
          <Typography>
            Are you sure you want to delete <strong>{job.job_number}</strong>? This permanently
            removes the job and all of its parts, operations, notes, and attachments. This
            cannot be undone.
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
          getQuickBooksInvoiceLinkForJob(companyId, jobId)
            .then(setQbInvoiceLink)
            .catch(() => {});
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
    </Box>
  );
}
