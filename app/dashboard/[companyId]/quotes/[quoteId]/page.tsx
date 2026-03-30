'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import DownloadIcon from '@mui/icons-material/Download';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import Chip from '@mui/material/Chip';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';

import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SaveIcon from '@mui/icons-material/Save';

import {
  getQuoteWithRelations,
  markQuoteAsPendingApproval,
  markQuoteAsApproved,
  markQuoteAsRejected,
  deleteQuote,
  getQuoteAttachmentUrl,
  deleteQuoteAttachment,
  refreshQuoteCost,
  updateQuote,
} from '@/utils/quotesAccess';
import { quoteToFormData, calculateUnitPriceFromMarkup, calculateTotalPrice } from '@/types/quote';
import type { QuoteWithRelations, QuoteAttachment } from '@/types/quote';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import type { RoutingCostBreakdown } from '@/utils/routingCostCalculation';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import QuoteForm from '@/components/quotes/QuoteForm';
import ConvertToJobModal from '@/components/quotes/ConvertToJobModal';

export default function QuoteDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const quoteId = params.quoteId as string;

  const [quote, setQuote] = useState<QuoteWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [convertModalOpen, setConvertModalOpen] = useState(
    searchParams.get('convert') === 'true'
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [costBreakdown, setCostBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [costOutdated, setCostOutdated] = useState(false);
  const [refreshingCost, setRefreshingCost] = useState(false);

  // Markup editing state (for pending_approval status)
  const [editingMarkup, setEditingMarkup] = useState(false);
  const [markupDraft, setMarkupDraft] = useState('');
  const [savingMarkup, setSavingMarkup] = useState(false);

  useEffect(() => {
    fetchQuote();
  }, [quoteId]);

  const fetchQuote = async () => {
    try {
      setLoading(true);
      const data = await getQuoteWithRelations(quoteId, companyId);
      setQuote(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quote');
    } finally {
      setLoading(false);
    }
  };

  // Check if routing cost is outdated for pending_approval/rejected quotes
  useEffect(() => {
    if (!quote || !quote.part_id || !quote.base_cost) return;
    if (quote.status !== 'pending_approval' && quote.status !== 'rejected') return;
    if (quote.cost_source !== 'routing') return;

    calculateRoutingCost(quote.part_id).then((breakdown) => {
      setCostBreakdown(breakdown);
      if (breakdown && Math.abs(breakdown.total_cost - (quote.base_cost ?? 0)) > 0.01) {
        setCostOutdated(true);
      } else {
        setCostOutdated(false);
      }
    }).catch(() => {
      setCostBreakdown(null);
      setCostOutdated(false);
    });
  }, [quote]);

  const handleRefreshCost = async () => {
    if (!quote) return;
    setRefreshingCost(true);
    setError(null);
    try {
      await refreshQuoteCost(quoteId, companyId);
      await fetchQuote();
      setCostOutdated(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh cost');
    } finally {
      setRefreshingCost(false);
    }
  };

  const handleStartEditMarkup = () => {
    if (!quote) return;
    setMarkupDraft(quote.markup_percent !== null ? String(quote.markup_percent) : '');
    setEditingMarkup(true);
  };

  const handleSaveMarkup = async () => {
    if (!quote) return;
    setSavingMarkup(true);
    setError(null);
    try {
      const markupNum = parseFloat(markupDraft);
      const baseCost = quote.base_cost ?? 0;
      const newUnitPrice = !isNaN(markupNum) ? calculateUnitPriceFromMarkup(baseCost, markupNum) : quote.unit_price;
      const newTotal = calculateTotalPrice(quote.quantity, newUnitPrice);

      const formData = quoteToFormData(quote);
      formData.markup_percent = markupDraft;
      formData.unit_price = newUnitPrice !== null ? String(newUnitPrice) : '';
      await updateQuote(quoteId, formData);
      setEditingMarkup(false);
      await fetchQuote();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update markup');
    } finally {
      setSavingMarkup(false);
    }
  };

  const handleAction = async (action: () => Promise<unknown>) => {
    setActionLoading(true);
    setError(null);
    try {
      await action();
      await fetchQuote();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteQuote(quoteId, companyId);
      router.push(`/dashboard/${companyId}/quotes`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete quote');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDownloadAttachment = async (attachment: QuoteAttachment) => {
    try {
      const url = await getQuoteAttachmentUrl(attachment.file_path);
      window.open(url, '_blank');
    } catch (err) {
      setError('Failed to download attachment');
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    setActionLoading(true);
    try {
      await deleteQuoteAttachment(attachmentId, companyId);
      await fetchQuote();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete attachment');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!quote) {
    return (
      <Box>
        <Alert severity="error">Quote not found</Alert>
      </Box>
    );
  }

  // If in edit mode and quote is pending_approval or rejected, show the form
  if (editMode && (quote.status === 'pending_approval' || quote.status === 'rejected')) {
    const handleSaveSuccess = async () => {
      setEditMode(false);
      await fetchQuote();
    };

    return (
      <QuoteForm
        mode="edit"
        initialData={quoteToFormData(quote)}
        quoteId={quote.id}
        onCancel={() => setEditMode(false)}
        onSave={handleSaveSuccess}
      />
    );
  }

  return (
    <Box>
      {/* Back Button */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/quotes`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Quotes
      </Button>

      {/* Header with Actions */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          mb: 3,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" component="h1" gutterBottom sx={{ fontSize: { xs: '1.5rem', md: '2.125rem' } }}>
            {quote.quote_number || 'Quote'}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <QuoteStatusChip status={quote.status} size="medium" />
            <Typography variant="body2" color="text.secondary">
              Created {formatDate(quote.created_at)}
            </Typography>
          </Box>
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {quote.status === 'pending_approval' && (
            <>
              <Button
                variant="outlined"
                startIcon={<EditIcon />}
                onClick={() => setEditMode(true)}
                disabled={actionLoading}
              >
                Edit
              </Button>
              <Button
                variant="contained"
                color="success"
                startIcon={<CheckIcon />}
                onClick={() => handleAction(() => markQuoteAsApproved(quoteId))}
                disabled={actionLoading}
              >
                Approve
              </Button>
              <Button
                variant="contained"
                color="warning"
                startIcon={<CloseIcon />}
                onClick={() => handleAction(() => markQuoteAsRejected(quoteId))}
                disabled={actionLoading}
                sx={{ color: 'white' }}
              >
                Reject
              </Button>
            </>
          )}

          {quote.status === 'rejected' && (
            <>
              <Button
                variant="outlined"
                startIcon={<EditIcon />}
                onClick={() => setEditMode(true)}
                disabled={actionLoading}
              >
                Edit
              </Button>
              <Button
                variant="contained"
                startIcon={<SendIcon />}
                onClick={() => handleAction(() => markQuoteAsPendingApproval(quoteId))}
                disabled={actionLoading}
              >
                Re-submit for Approval
              </Button>
            </>
          )}

          {quote.status === 'approved' && !quote.converted_to_job_id && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PlayArrowIcon />}
              onClick={() => setConvertModalOpen(true)}
              disabled={actionLoading}
            >
              Convert to Job
            </Button>
          )}

          {/* Spacer to push delete to far right */}
          <Box sx={{ flex: 1 }} />

          {/* Delete Icon Button */}
          <Tooltip title="Delete Quote">
            <IconButton
              onClick={() => setDeleteDialogOpen(true)}
              disabled={actionLoading}
              sx={{
                color: 'text.secondary',
                '&:hover': {
                  color: 'error.main',
                  bgcolor: 'rgba(239, 68, 68, 0.1)',
                },
              }}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Converted to Job Banner */}
      {quote.converted_to_job_id && quote.jobs && (
        <Alert severity="success" sx={{ mb: 3 }}>
          This quote was converted to{' '}
          <MuiLink
            component={Link}
            href={`/dashboard/${companyId}/jobs/${quote.converted_to_job_id}`}
            sx={{ fontWeight: 600 }}
          >
            Job {quote.jobs.job_number}
          </MuiLink>{' '}
          on {formatDate(quote.converted_at)}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Customer Info */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Customer
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {quote.customers ? (
                <>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/customers/${quote.customer_id}`}
                    sx={{ fontWeight: 500 }}
                  >
                    {quote.customers.name}
                  </MuiLink>
                </>
              ) : (
                <Typography color="text.secondary">Customer not found</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Part Info */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Part
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {quote.parts ? (
                <>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/parts/${quote.part_id}`}
                    sx={{ fontWeight: 500 }}
                  >
                    {quote.parts.part_number}
                  </MuiLink>
                  {quote.parts.description && (
                    <Typography variant="body2" color="text.secondary">
                      {quote.parts.description}
                    </Typography>
                  )}
                </>
              ) : (
                <Typography color="text.secondary">No part specified</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Description */}
        {quote.description && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Description
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                  {quote.description}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        )}

        {/* Attachments */}
        {quote.quote_attachments && quote.quote_attachments.length > 0 && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Attachments
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {quote.quote_attachments.map((attachment) => (
                  <Box
                    key={attachment.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 2,
                      p: 2,
                      bgcolor: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: 1,
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      mb: 1,
                      '&:last-child': { mb: 0 },
                    }}
                  >
                    <PictureAsPdfIcon sx={{ fontSize: 40, color: 'error.main' }} />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body1" fontWeight={500}>
                        {attachment.file_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatFileSize(attachment.file_size)} • Uploaded{' '}
                        {formatDate(attachment.uploaded_at)}
                      </Typography>
                    </Box>
                    <Button
                      variant="outlined"
                      startIcon={<DownloadIcon />}
                      onClick={() => handleDownloadAttachment(attachment)}
                      disabled={actionLoading}
                    >
                      Download
                    </Button>
                    {(quote.status === 'pending_approval' || quote.status === 'rejected') && (
                      <IconButton
                        color="error"
                        onClick={() => handleDeleteAttachment(attachment.id)}
                        disabled={actionLoading}
                        title="Delete attachment"
                      >
                        <DeleteIcon />
                      </IconButton>
                    )}
                  </Box>
                ))}
              </CardContent>
            </Card>
          </Grid>
        )}

        {/* Cost & Pricing */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Cost & Pricing
                </Typography>
                {quote.cost_source && (
                  <Chip
                    label={
                      quote.cost_source === 'routing'
                        ? 'From Routing'
                        : quote.cost_source === 'manual'
                          ? 'Manual Estimate'
                          : 'Estimate'
                    }
                    size="small"
                    color={quote.cost_source === 'routing' ? 'primary' : 'default'}
                    variant="outlined"
                  />
                )}
                {(quote.status === 'pending_approval' || quote.status === 'rejected') && quote.cost_source === 'routing' && (
                  <Button
                    size="small"
                    startIcon={refreshingCost ? <CircularProgress size={14} /> : <RefreshIcon />}
                    onClick={handleRefreshCost}
                    disabled={refreshingCost}
                  >
                    Refresh Cost
                  </Button>
                )}
              </Box>
              <Divider sx={{ mb: 2 }} />

              {costOutdated && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  The routing for this part has changed since this quote was created. Click &quot;Refresh Cost&quot; to update.
                </Alert>
              )}

              <Grid container spacing={2}>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    Base Cost
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatCurrency(quote.base_cost)}
                  </Typography>
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Markup
                    </Typography>
                    {quote.status === 'pending_approval' && !editingMarkup && (
                      <Tooltip title="Edit markup">
                        <IconButton size="small" onClick={handleStartEditMarkup} sx={{ color: 'text.secondary' }}>
                          <EditIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                  {editingMarkup && quote.status === 'pending_approval' ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <TextField
                        size="small"
                        type="number"
                        value={markupDraft}
                        onChange={(e) => setMarkupDraft(e.target.value)}
                        disabled={savingMarkup}
                        sx={{ width: 100 }}
                        slotProps={{
                          input: {
                            endAdornment: <InputAdornment position="end">%</InputAdornment>,
                          },
                          htmlInput: { step: 0.1 },
                        }}
                      />
                      <Button
                        size="small"
                        variant="contained"
                        onClick={handleSaveMarkup}
                        disabled={savingMarkup}
                        startIcon={savingMarkup ? <CircularProgress size={14} /> : <SaveIcon sx={{ fontSize: 14 }} />}
                      >
                        Save
                      </Button>
                      <Button
                        size="small"
                        onClick={() => setEditingMarkup(false)}
                        disabled={savingMarkup}
                      >
                        Cancel
                      </Button>
                    </Box>
                  ) : (
                    <Typography variant="body1" fontWeight={500}>
                      {quote.markup_percent !== null ? `${quote.markup_percent}%` : '—'}
                    </Typography>
                  )}
                  {/* Live preview of recalculated values when editing */}
                  {editingMarkup && markupDraft && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                      Unit price: {formatCurrency(calculateUnitPriceFromMarkup(quote.base_cost ?? 0, parseFloat(markupDraft)))}
                      {' · '}
                      Total: {formatCurrency(calculateTotalPrice(quote.quantity, calculateUnitPriceFromMarkup(quote.base_cost ?? 0, parseFloat(markupDraft))))}
                    </Typography>
                  )}
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    Unit Price
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatCurrency(quote.unit_price)}
                  </Typography>
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    Quantity
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {quote.quantity}
                  </Typography>
                </Grid>
              </Grid>

              <Divider sx={{ my: 2 }} />

              <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Total
                </Typography>
                <Typography variant="h5" color="primary" fontWeight={600}>
                  {formatCurrency(quote.total_price)}
                </Typography>
              </Box>

              {/* Cost Breakdown (if routing-based) */}
              {costBreakdown && (costBreakdown.labor_items.length > 0 || costBreakdown.material_items.length > 0) && (
                <Accordion sx={{ mt: 2, bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
                    <Typography variant="body2" fontWeight={500}>
                      Cost Breakdown
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ px: 0 }}>
                    {costBreakdown.labor_items.length > 0 && (
                      <>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Labor</Typography>
                        <Table size="small" sx={{ mb: 2 }}>
                          <TableHead>
                            <TableRow>
                              <TableCell>Operation</TableCell>
                              <TableCell align="right">Time (min)</TableCell>
                              <TableCell align="right">Rate ($/hr)</TableCell>
                              <TableCell align="right">Cost</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {costBreakdown.labor_items.map((item, i) => (
                              <TableRow key={i}>
                                <TableCell>{item.operation_name}</TableCell>
                                <TableCell align="right">{item.run_time_minutes}</TableCell>
                                <TableCell align="right">{formatCurrency(item.labor_rate)}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                              </TableRow>
                            ))}
                            <TableRow>
                              <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                              <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(costBreakdown.total_labor_cost)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </>
                    )}
                    {costBreakdown.material_items.length > 0 && (
                      <>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Materials</Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>Item</TableCell>
                              <TableCell align="right">Qty</TableCell>
                              <TableCell align="right">Unit Cost</TableCell>
                              <TableCell align="right">Cost</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {costBreakdown.material_items.map((item, i) => (
                              <TableRow key={i}>
                                <TableCell>{item.item_name}</TableCell>
                                <TableCell align="right">{item.quantity} {item.unit}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost_per_unit)}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                              </TableRow>
                            ))}
                            <TableRow>
                              <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                              <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(costBreakdown.total_material_cost)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </AccordionDetails>
                </Accordion>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Convert to Job Modal */}
      <ConvertToJobModal
        open={convertModalOpen}
        onClose={() => setConvertModalOpen(false)}
        quote={quote}
        onConverted={(jobId) => {
          router.push(`/dashboard/${companyId}/jobs/${jobId}`);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Quote?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{quote.quote_number}</strong>? This action
            cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={
              actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
