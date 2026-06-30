'use client';

import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import PrintIcon from '@mui/icons-material/Print';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import EditIcon from '@mui/icons-material/Edit';
import LockIcon from '@mui/icons-material/Lock';
import DeleteIcon from '@mui/icons-material/Delete';
import Snackbar from '@mui/material/Snackbar';

import { getJobWithRelations, cancelJob, reopenJob, deleteJob, type UpdateJobPartQuantityResult } from '@/utils/jobsAccess';
import { getCompany, type Company } from '@/utils/companyAccess';
import { getJobPartShipmentSummaries, countShipmentsForJob } from '@/utils/shipmentsAccess';
import { addJobNote, getCurrentOperator } from '@/utils/operatorAccess';
import type { JobWithRelations, JobPartWithRelations } from '@/types/job';
import type { JobPartShipmentSummary } from '@/types/shipment';
import {
  ProductionStatusChip,
  FulfillmentStatusChip,
} from '@/components/jobs/JobStatusChip';
import { OperationsPanel, JobTravelerPreviewDialog, JobBillingShippingCard, JobPartMaterialsCard, EditJobPartQuantityModal } from '@/components/jobs';
import JobOverdueBadge from '@/components/jobs/JobOverdueBadge';
import JobStatusBlock from '@/components/jobs/JobStatusBlock';
import ShipmentHistoryCard from '@/components/jobs/ShipmentHistoryCard';
import { CreateShipmentModal } from '@/components/shipments';
import { isShipmentsEnabled } from '@/lib/featureFlags';
import PushToQuickBooksDialog from '@/components/jobs/PushToQuickBooksDialog';
import JobAttachmentsCard from '@/components/jobs/JobAttachmentsCard';
import { getQuickBooksInvoiceLinkForJob, type QuickBooksInvoiceLink } from '@/utils/quickbooksAccess';

const fmtUsd = (v: number | null): string =>
  v === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<JobWithRelations | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [partSummaries, setPartSummaries] = useState<JobPartShipmentSummary[]>([]);
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
  const [editQtyPart, setEditQtyPart] = useState<JobPartWithRelations | null>(null);
  const [qtySuccess, setQtySuccess] = useState<string | null>(null);
  // Anchors for the top-bar Edit-Quantity / Print-Traveler part pickers
  // (only shown when a job has more than one part).
  const [qtyMenuAnchor, setQtyMenuAnchor] = useState<null | HTMLElement>(null);
  const [travelerMenuAnchor, setTravelerMenuAnchor] = useState<null | HTMLElement>(null);

  const shipmentsEnabled = useMemo(() => isShipmentsEnabled(company), [company]);

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
    (async () => {
      try {
        const c = await getCompany(companyId);
        setCompany(c);
      } catch (err) {
        console.warn('Job detail: company fetch failed', err);
      }
    })();
  }, [fetchJob, companyId]);

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

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
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
    shipmentsEnabled &&
    job.production_status !== 'cancelled' &&
    job.fulfillment_status !== 'fully_shipped' &&
    parts.length > 0;

  const summariesByPart = new Map(partSummaries.map((s) => [s.job_part_id, s]));
  const editableParts = parts.filter((p) => p.production_status !== 'cancelled');

  // Edit Quantity / Print Traveler are per-part actions surfaced in the top
  // action bar for discoverability. With one part they act directly; with
  // several they open a small picker menu.
  const handleEditQtyClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (editableParts.length === 1) {
      setEditQtyPart(editableParts[0]);
    } else {
      setQtyMenuAnchor(e.currentTarget);
    }
  };
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

  const handleLineConfirmed = async (result: UpdateJobPartQuantityResult) => {
    const edited = editQtyPart;
    setEditQtyPart(null);
    const qtyChanged = result.oldQuantity !== result.newQuantity;
    const priceChanged = result.oldUnitPrice !== result.newUnitPrice;
    // Audit trail: log the change to the job feed. Best-effort — a note failure
    // must never undo the (already-committed) edit. authorId is the
    // user_company_access id (RLS requirement), resolved via getCurrentOperator.
    try {
      const me = await getCurrentOperator(companyId);
      if (me) {
        const partName = edited?.parts?.part_name ?? 'part';
        const changes: string[] = [];
        if (qtyChanged)
          changes.push(`order quantity ${result.oldQuantity} → ${result.newQuantity}`);
        if (priceChanged)
          changes.push(`unit price ${fmtUsd(result.oldUnitPrice)} → ${fmtUsd(result.newUnitPrice)}`);
        if (changes.length > 0) {
          await addJobNote(
            jobId,
            companyId,
            me.id,
            `Changed ${changes.join(' and ')} for ${partName}`,
            { jobPartId: result.jobPart.id, noteType: 'event' },
          );
        }
      }
    } catch (err) {
      console.warn('Job detail: failed to log line-change note', err);
    }
    const toast: string[] = [];
    if (qtyChanged) toast.push(`qty ${result.oldQuantity} → ${result.newQuantity}`);
    if (priceChanged) toast.push(`unit price ${fmtUsd(result.newUnitPrice)}`);
    setQtySuccess(toast.length ? `Line updated · ${toast.join(' · ')}` : 'Line updated');
    // Re-pull so the parts row, status block, and fulfillment chip reflect the edit.
    await fetchJob();
  };

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
          <JobOverdueBadge job={job} size="medium" />
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {parts.length > 0 &&
            (qbInvoiceLink ? (
              <Tooltip
                title={`Invoiced in QuickBooks${
                  qbInvoiceLink.docNumber ? ` (${qbInvoiceLink.docNumber})` : ''
                } — price & quantity locked. Revise the invoice in QuickBooks to change it.`}
              >
                <span>
                  <Button variant="outlined" startIcon={<LockIcon />} disabled>
                    Edit line
                  </Button>
                </span>
              </Tooltip>
            ) : (
              editableParts.length > 0 && (
                <Button
                  variant="outlined"
                  startIcon={<EditIcon />}
                  onClick={handleEditQtyClick}
                  disabled={actionLoading}
                >
                  Edit line
                </Button>
              )
            ))}
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
          {canShip && (
            <Button
              variant="outlined"
              startIcon={<LocalShippingIcon />}
              onClick={() => setShipModalOpen(true)}
              disabled={actionLoading}
            >
              Create Shipment
            </Button>
          )}
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

          {qbInvoiceLink ? (
            <Button
              variant="outlined"
              startIcon={<OpenInNewIcon />}
              href={qbInvoiceLink.url}
              target="_blank"
              rel="noopener"
            >
              View invoice
            </Button>
          ) : (
            <Button
              variant="outlined"
              startIcon={<ReceiptLongIcon />}
              onClick={() => setPushDialogOpen(true)}
              disabled={actionLoading}
            >
              Create Invoice in QuickBooks
            </Button>
          )}
        </Box>
      </Box>

      <JobStatusBlock job={job} parts={parts} />

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {job.quote_id && job.quotes && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Created from{' '}
          <MuiLink
            component={Link}
            href={`/dashboard/${companyId}/quotes/${job.quote_id}`}
            sx={{ fontWeight: 600 }}
          >
            Quote {job.quotes.quote_number}
          </MuiLink>
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job Details
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Stack spacing={2}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Customer
                  </Typography>
                  {job.customers ? (
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/customers/${job.customer_id}`}
                      sx={{ fontWeight: 500 }}
                    >
                      {job.customers.name}
                    </MuiLink>
                  ) : (
                    <Typography variant="body1" color="text.secondary">—</Typography>
                  )}
                </Box>
                {job.customer_po_number && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Customer PO
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {job.customer_po_number}
                    </Typography>
                  </Box>
                )}
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatDate(job.created_at)}
                  </Typography>
                </Box>
                {job.due_date && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Due
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {formatDate(job.due_date)}
                    </Typography>
                  </Box>
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12 }}>
          <JobBillingShippingCard job={job} companyId={companyId} onUpdated={fetchJob} />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <JobAttachmentsCard jobId={jobId} companyId={companyId} />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Parts ({parts.length})
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {parts.length === 0 ? (
                <Typography color="text.secondary">No parts on this job.</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {parts.map((part) => {
                    const summary = summariesByPart.get(part.id);
                    return (
                      <Box key={part.id}>
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            flexWrap: 'wrap',
                            gap: 1,
                            mb: 1,
                          }}
                        >
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'baseline',
                              gap: 1.5,
                              flexWrap: 'wrap',
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
                            {shipmentsEnabled && summary && summary.qty_shipped > 0 && (
                              <Typography variant="body2" color="text.secondary">
                                {summary.qty_shipped} of {summary.qty_ordered} shipped
                                {summary.qty_remaining > 0
                                  ? ` · ${summary.qty_remaining} remaining`
                                  : ''}
                              </Typography>
                            )}
                          </Box>
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                            <ProductionStatusChip
                              status={part.production_status}
                              size="small"
                            />
                            {shipmentsEnabled && (
                              <FulfillmentStatusChip
                                status={part.fulfillment_status}
                                size="small"
                              />
                            )}
                          </Box>
                        </Box>
                        {part.job_operations && part.job_operations.length > 0 ? (
                          <OperationsPanel
                            job={job}
                            operations={part.job_operations}
                            onOperationUpdate={fetchJob}
                            disabled={actionLoading}
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
                          <JobPartMaterialsCard partId={part.part_id} />
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {shipmentsEnabled && (
          <Grid size={{ xs: 12 }}>
            <ShipmentHistoryCard
              jobId={jobId}
              refreshKey={historyRefreshKey}
              initialPreviewShipmentId={pendingPreviewShipmentId}
              onShipmentVoided={fetchJob}
            />
          </Grid>
        )}
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

      {shipmentsEnabled && (
        <CreateShipmentModal
          open={shipModalOpen}
          jobId={jobId}
          companyId={companyId}
          onClose={() => setShipModalOpen(false)}
          onCreated={handleCreated}
        />
      )}

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
          getQuickBooksInvoiceLinkForJob(companyId, jobId)
            .then(setQbInvoiceLink)
            .catch(() => {});
        }}
      />

      <EditJobPartQuantityModal
        key={editQtyPart?.id ?? 'none'}
        open={editQtyPart !== null}
        jobPart={editQtyPart}
        qtyShipped={
          editQtyPart ? summariesByPart.get(editQtyPart.id)?.qty_shipped ?? 0 : 0
        }
        onClose={() => setEditQtyPart(null)}
        onConfirmed={handleLineConfirmed}
      />

      <Menu
        anchorEl={qtyMenuAnchor}
        open={!!qtyMenuAnchor}
        onClose={() => setQtyMenuAnchor(null)}
      >
        {editableParts.map((p) => (
          <MenuItem
            key={p.id}
            onClick={() => {
              setQtyMenuAnchor(null);
              setEditQtyPart(p);
            }}
          >
            {p.parts?.part_name ?? 'Part'} · qty {p.quantity}
          </MenuItem>
        ))}
      </Menu>

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

      <Snackbar
        open={!!qtySuccess}
        autoHideDuration={5000}
        onClose={() => setQtySuccess(null)}
        message={qtySuccess ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      />
    </Box>
  );
}
