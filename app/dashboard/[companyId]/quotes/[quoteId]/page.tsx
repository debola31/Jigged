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
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import PrintIcon from '@mui/icons-material/Print';
import DownloadIcon from '@mui/icons-material/Download';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import {
  getQuoteWithRelations,
  deleteQuote,
  getQuoteAttachmentUrl,
  deleteQuoteAttachment,
} from '@/utils/quotesAccess';
import { getCompany } from '@/utils/companyAccess';
import { generateQuotePdf } from '@/utils/quotePdf';
import {
  quoteToFormData,
  isQuoteExpired,
  daysUntilExpiration,
} from '@/types/quote';
import type { QuoteWithRelations, QuoteAttachment } from '@/types/quote';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import QuoteForm from '@/components/quotes/QuoteForm';
import ConvertToJobModal from '@/components/quotes/ConvertToJobModal';
import QuoteCostBreakdownAccordion from '@/components/quotes/QuoteCostBreakdown';

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
  const [printing, setPrinting] = useState(false);

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
    } catch {
      setError('Failed to download attachment');
    }
  };

  const handlePrintPdf = async () => {
    if (!quote) return;
    setError(null);
    setPrinting(true);
    try {
      const company = await getCompany(companyId);
      if (!company) {
        throw new Error('Company info unavailable — cannot generate PDF.');
      }
      await generateQuotePdf(quote, company);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate PDF');
    } finally {
      setPrinting(false);
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

  const expired = isQuoteExpired(quote);
  const convertedLocked = !!quote.converted_at;
  const isEditable = !convertedLocked && quote.status === 'active';
  const daysLeft = daysUntilExpiration(quote.expiration_date);
  const linkedJobs = quote.jobs ?? [];
  const lineItems = [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);
  const lineItemsByPart = new Map<string, typeof lineItems>();
  for (const li of lineItems) {
    const list = lineItemsByPart.get(li.part_id) ?? [];
    list.push(li);
    lineItemsByPart.set(li.part_id, list);
  }

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
        <Button
          variant="contained"
          color="primary"
          startIcon={printing ? <CircularProgress size={16} color="inherit" /> : <PrintIcon />}
          onClick={handlePrintPdf}
          disabled={printing || actionLoading}
        >
          Print PDF
        </Button>
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

          <Box sx={{ flex: 1 }} />

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
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Customer
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {quote.customers ? (
                <MuiLink
                  component={Link}
                  href={`/dashboard/${companyId}/customers/${quote.customer_id}`}
                  sx={{ fontWeight: 500 }}
                >
                  {quote.customers.name}
                </MuiLink>
              ) : (
                <Typography color="text.secondary">Customer not found</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Parts & tiers */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Parts
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {lineItemsByPart.size === 0 ? (
                <Typography color="text.secondary">No parts on this quote</Typography>
              ) : (
                Array.from(lineItemsByPart.entries()).map(([partId, items]) => {
                  const partName = items[0]?.parts?.part_name ?? 'Part';
                  const description = items[0]?.parts?.description;
                  return (
                    <Box key={partId} sx={{ mb: 2 }}>
                      <MuiLink
                        component={Link}
                        href={`/dashboard/${companyId}/parts/${partId}`}
                        sx={{ fontWeight: 500 }}
                      >
                        {partName}
                      </MuiLink>
                      {description && (
                        <Typography variant="body2" color="text.secondary">
                          {description}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.secondary">
                        {items.length} tier{items.length === 1 ? '' : 's'}
                      </Typography>
                    </Box>
                  );
                })
              )}
            </CardContent>
          </Card>
        </Grid>

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
                    {isEditable && (
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
                      '& th, & td': { textAlign: 'left', py: 1, px: 1, borderBottom: '1px solid', borderColor: 'divider' },
                      '& th.num, & td.num': { textAlign: 'right' },
                    }}
                  >
                    <thead>
                      <tr>
                        <th>Part</th>
                        <th className="num">Qty</th>
                        <th className="num">Unit price</th>
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((li) => (
                        <tr key={li.id}>
                          <td>{li.parts?.part_name ?? 'Part'}</td>
                          <td className="num">{li.quantity}</td>
                          <td className="num">{formatCurrency(li.unit_price)}</td>
                          <td className="num">{formatCurrency(li.total_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Box>
                  {lineItems.length > 1 && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      Multiple tiers — grand total is withheld until the customer picks a quantity per part.
                    </Typography>
                  )}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Cost breakdown accordion */}
        <Grid size={{ xs: 12 }}>
          <QuoteCostBreakdownAccordion
            quoteId={quote.id}
            companyId={companyId}
          />
        </Grid>
      </Grid>

      {/* Convert to Job Modal */}
      <ConvertToJobModal
        open={convertModalOpen}
        onClose={() => setConvertModalOpen(false)}
        quote={quote}
        onConverted={(jobIds) => {
          const first = jobIds[0];
          if (first) router.push(`/dashboard/${companyId}/jobs/${first}`);
          else router.push(`/dashboard/${companyId}/jobs`);
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
