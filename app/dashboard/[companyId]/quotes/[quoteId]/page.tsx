'use client';

import { useState, useEffect, useCallback } from 'react';
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
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import VisibilityIcon from '@mui/icons-material/Visibility';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Chip from '@mui/material/Chip';

import { getQuoteWithRelations, deleteQuote } from '@/utils/quotesAccess';
import { getCompany } from '@/utils/companyAccess';
import type { Company } from '@/utils/companyAccess';
import QuotePdfPreviewDialog from '@/components/quotes/QuotePdfPreviewDialog';
import SendQuoteEmailDialog from '@/components/quotes/SendQuoteEmailDialog';
import EmailIcon from '@mui/icons-material/Email';
import Snackbar from '@mui/material/Snackbar';
import {
  quoteToFormData,
  isQuoteExpired,
  daysUntilExpiration,
} from '@/types/quote';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import QuoteForm from '@/components/quotes/QuoteForm';
import ConvertToJobModal from '@/components/quotes/ConvertToJobModal';
import AddressDisplay from '@/components/common/AddressDisplay';

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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [company, setCompany] = useState<Company | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);
  const fetchQuote = useCallback(async () => {
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
  }, [quoteId, companyId]);

  useEffect(() => {
    fetchQuote();
  }, [fetchQuote]);

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

  const handleOpenPreview = async () => {
    if (!quote) return;
    setError(null);
    setPreviewLoading(true);
    try {
      // Fetch (or reuse) the company so the preview dialog can render the
      // shop header without doing its own data fetch.
      const c = company ?? (await getCompany(companyId));
      if (!c) {
        throw new Error('Company info unavailable — cannot generate PDF.');
      }
      setCompany(c);
      setPreviewOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpenEmailDialog = async () => {
    if (!quote) return;
    setError(null);
    setPreviewLoading(true);
    try {
      const c = company ?? (await getCompany(companyId));
      if (!c) {
        throw new Error('Company info unavailable — cannot draft email.');
      }
      setCompany(c);
      setEmailDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open email dialog');
    } finally {
      setPreviewLoading(false);
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

  const expired = isQuoteExpired(quote);
  const convertedLocked = !!quote.converted_at;
  const isEditable = !convertedLocked && quote.status === 'active';
  const daysLeft = daysUntilExpiration(quote.expiration_date);
  const linkedJobs = quote.jobs ?? [];
  const lineItems = [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);
  const grandTotal = lineItems.reduce(
    (sum, li) => sum + (li.total_price ?? li.unit_price * li.quantity),
    0,
  );

  // Group line items by part (first-appearance order). A part with a single
  // quantity is a firm line; 2+ quantities is a price-options menu. The whole
  // quote is "firm" (grand total shown) only when EVERY part has one quantity.
  const partGroups: {
    part_id: string;
    part_name: string;
    description: string | null;
    items: QuoteLineItem[];
  }[] = [];
  const partGroupIndex = new Map<string, number>();
  for (const li of lineItems) {
    let gi = partGroupIndex.get(li.part_id);
    if (gi === undefined) {
      gi = partGroups.length;
      partGroupIndex.set(li.part_id, gi);
      partGroups.push({
        part_id: li.part_id,
        part_name: li.parts?.part_name ?? 'Part',
        description: li.parts?.description ?? null,
        items: [],
      });
    }
    partGroups[gi].items.push(li);
  }
  const isFirmQuote = partGroups.length > 0 && partGroups.every((g) => g.items.length === 1);

  // Resolve the quote's frozen address/contact FKs against the customer's
  // address book for display. These were captured at quote creation.
  const customerAddresses = quote.customers?.addresses ?? [];
  const customerContacts = quote.customers?.customer_contacts ?? [];
  const shippingAddress = customerAddresses.find((a) => a.id === quote.shipping_address_id) ?? null;
  const billingAddress = customerAddresses.find((a) => a.id === quote.billing_address_id) ?? null;
  const quoteContact = customerContacts.find((c) => c.id === quote.contact_id) ?? null;
  // When billing points at the same address as shipping, don't repeat it —
  // just flag the match.
  const billingSameAsShipping =
    !!quote.shipping_address_id && quote.billing_address_id === quote.shipping_address_id;

  if (editMode && isEditable) {
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
      {/* Top toolbar: Back + document-level actions */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/quotes`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Quotes
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<EmailIcon />}
            onClick={handleOpenEmailDialog}
            disabled={previewLoading || actionLoading}
          >
            Email
          </Button>
          <Button
            variant="contained"
            color="primary"
            startIcon={previewLoading ? <CircularProgress size={16} color="inherit" /> : <VisibilityIcon />}
            onClick={handleOpenPreview}
            disabled={previewLoading || actionLoading}
          >
            View PDF
          </Button>
        </Box>
      </Box>

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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <QuoteStatusChip status={quote.status} size="medium" />
            <Typography variant="body2" color="text.secondary">
              Created {formatDate(quote.created_at)}
            </Typography>
            {(quote.created_by_member?.name || quote.created_by_member?.email) && (
              <Typography variant="body2" color="text.secondary">
                Created by{' '}
                <Typography component="span" variant="body2" color="text.primary" sx={{ fontWeight: 500 }}>
                  {quote.created_by_member.name || quote.created_by_member.email}
                </Typography>
              </Typography>
            )}
            {quote.expiration_date && (
              <Typography
                variant="body2"
                color={expired ? 'warning.main' : daysLeft !== null && daysLeft <= 3 ? 'warning.main' : 'text.secondary'}
              >
                {expired
                  ? `Expired ${formatDate(quote.expiration_date)}`
                  : daysLeft !== null && daysLeft >= 0
                  ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${formatDate(quote.expiration_date)})`
                  : `Expires ${formatDate(quote.expiration_date)}`}
              </Typography>
            )}
            {quote.lead_time_days !== null && (
              <Typography variant="body2" color="text.secondary">
                Lead time: {quote.lead_time_days} day{quote.lead_time_days === 1 ? '' : 's'}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {isEditable && (
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => setEditMode(true)}
              disabled={actionLoading}
            >
              Edit
            </Button>
          )}

          {!convertedLocked && (
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

          {/* Invoicing lives on the Job now (job-keyed). The converted-jobs
              banner below links through to the job, where invoices are created. */}

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Delete Quote">
            <IconButton
              onClick={() => setDeleteDialogOpen(true)}
              disabled={actionLoading}
              sx={{
                color: 'error.main',
                '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)' },
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

      {/* Converted to Jobs Banner */}
      {convertedLocked && linkedJobs.length > 0 && (
        <Alert severity="success" sx={{ mb: 3 }}>
          This quote was converted to{' '}
          {linkedJobs.map((j, i) => (
            <span key={j.id}>
              {i > 0 && ', '}
              <MuiLink
                component={Link}
                href={`/dashboard/${companyId}/jobs/${j.id}`}
                sx={{ fontWeight: 600 }}
              >
                Job {j.job_number}
              </MuiLink>
            </span>
          ))}{' '}
          on {formatDate(quote.converted_at)}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Customer Info */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Customer
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {quote.customers ? (
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12 }}>
                    <Typography variant="body2" color="text.secondary">
                      Customer
                    </Typography>
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/customers/${quote.customer_id}`}
                      sx={{ fontWeight: 500 }}
                    >
                      {quote.customers.name}
                    </MuiLink>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                    <Typography variant="body2" color="text.secondary">
                      Contact
                    </Typography>
                    {quoteContact ? (
                      <Box>
                        <Typography variant="body1" sx={{ fontWeight: 500 }}>
                          {quoteContact.name}
                        </Typography>
                        {quoteContact.email && (
                          <Typography variant="body2" color="text.secondary">
                            {quoteContact.email}
                          </Typography>
                        )}
                        {quoteContact.phone && (
                          <Typography variant="body2" color="text.secondary">
                            {quoteContact.phone}
                          </Typography>
                        )}
                      </Box>
                    ) : (
                      <Typography variant="body1" color="text.secondary">
                        Not set
                      </Typography>
                    )}
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <Typography variant="body2" color="text.secondary">
                      Shipping address
                    </Typography>
                    <AddressDisplay address={shippingAddress} />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <Typography variant="body2" color="text.secondary">
                      Billing address
                    </Typography>
                    {billingSameAsShipping ? (
                      <Typography variant="body1" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                        Same as shipping
                      </Typography>
                    ) : (
                      <AddressDisplay address={billingAddress} />
                    )}
                  </Grid>
                </Grid>
              ) : (
                <Typography color="text.secondary">Customer not found</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Line items table */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Line items
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {lineItems.length === 0 ? (
                <Typography color="text.secondary">No line items on this quote.</Typography>
              ) : (
                <Box sx={{ overflowX: 'auto' }}>
                  <Box
                    component="table"
                    sx={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      '& th, & td': {
                        textAlign: 'left',
                        py: 1,
                        px: 1,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        verticalAlign: 'top',
                      },
                      '& th.num, & td.num': { textAlign: 'right' },
                    }}
                  >
                    <thead>
                      <tr>
                        <th>Part</th>
                        <th>Description</th>
                        <th className="num">Order qty</th>
                        <th className="num">Unit price</th>
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* One table for the whole quote. A part with several
                          quantities shows its name + description once (spanning
                          its quantity rows); each quantity gets its own line. */}
                      {partGroups.map((group) => {
                        const rows = [...group.items].sort((a, b) => a.quantity - b.quantity);
                        return rows.map((li, i) => (
                          <tr key={li.id}>
                            {i === 0 && (
                              <td rowSpan={rows.length} style={{ fontWeight: 600 }}>
                                {group.part_name}
                              </td>
                            )}
                            {i === 0 && (
                              <td rowSpan={rows.length}>{group.description ?? ''}</td>
                            )}
                            <td className="num">{li.quantity}</td>
                            <td className="num">
                              {formatCurrency(li.unit_price)}
                              {li.is_quote_override && (
                                <Chip
                                  size="small"
                                  label="custom"
                                  color="success"
                                  variant="outlined"
                                  sx={{ ml: 1, height: 18 }}
                                />
                              )}
                            </td>
                            <td className="num">
                              {formatCurrency(li.total_price ?? li.unit_price * li.quantity)}
                            </td>
                          </tr>
                        ));
                      })}
                      {isFirmQuote && (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>
                            Total
                          </td>
                          <td className="num" style={{ fontWeight: 700, paddingTop: 12 }}>
                            {formatCurrency(grandTotal)}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </Box>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Preview PDF Dialog */}
      {company && (
        <QuotePdfPreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          quote={quote}
          company={company}
          onEmail={() => setEmailDialogOpen(true)}
        />
      )}

      {/* Send Quote Email Dialog */}
      {company && (
        <SendQuoteEmailDialog
          open={emailDialogOpen}
          onClose={() => setEmailDialogOpen(false)}
          onSent={(toEmail) => {
            setEmailDialogOpen(false);
            setEmailSuccess(toEmail);
          }}
          quote={quote}
          company={company}
        />
      )}

      <Snackbar
        open={!!emailSuccess}
        autoHideDuration={5000}
        onClose={() => setEmailSuccess(null)}
        message={emailSuccess ? `Quote emailed to ${emailSuccess}` : ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      />

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
