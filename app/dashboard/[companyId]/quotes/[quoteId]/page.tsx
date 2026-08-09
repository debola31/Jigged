'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
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

import {
  getQuoteWithRelations,
  deleteQuote,
  detectQuoteLineDrift,
  repriceQuoteDriftedLinesToCurrent,
  getQuoteConversionState,
  type QuoteLineDriftInfo,
  type QuoteLineConversion,
} from '@/utils/quotesAccess';
import { hasTermDrift } from '@/utils/customerAccess';
import { getCompany } from '@/utils/companyAccess';
import type { Company } from '@/utils/companyAccess';
import { readQuoteValidityDays } from '@/lib/companyDefaults';
import QuotePdfPreviewDialog from '@/components/quotes/QuotePdfPreviewDialog';
import {
  quoteToFormData,
  isQuoteExpired,
  daysUntilExpiration,
  defaultExpirationDate,
} from '@/types/quote';
import type { QuoteLineItem } from '@/types/quote';
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

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [convertModalOpen, setConvertModalOpen] = useState(
    searchParams.get('convert') === 'true'
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [company, setCompany] = useState<Company | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Which line items are already on a live job, and the job/PO that owns each.
  // A quote is converted in one or more passes (one job per customer PO), so this
  // drives the remaining-lines logic, the Convert button, the converted-jobs
  // banner, and the per-line "now N on the job" note (a job quantity edited after
  // conversion; the quote keeps its quoted figures).
  const [conversions, setConversions] = useState<QuoteLineConversion[]>([]);
  // Lines whose price has drifted from the part's current tier table, keyed by
  // line-item id (override lines are never included). Surfaced read-only on the
  // detail page; the "Update prices to current" action reprices them all.
  const [driftByLine, setDriftByLine] = useState<Map<string, QuoteLineDriftInfo>>(new Map());
  const [repriceDialogOpen, setRepriceDialogOpen] = useState(false);
  const [repricing, setRepricing] = useState(false);
  // useLoad keeps every setState inside the async callback, so the load effect
  // can't trip set-state-in-effect. `fetchQuote` (its reload) is reused after an
  // inline edit save below.
  const {
    data: quote,
    loading,
    reload: fetchQuote,
  } = useLoad(() => getQuoteWithRelations(quoteId, companyId), [quoteId, companyId], {
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Failed to load quote'),
  });

  // Load the company eagerly so reactivating an expired quote can honor the
  // company's configured quote-validity window, and the PDF preview can reuse
  // it without a second fetch. Fallback (still loading / failed) is null, which
  // readQuoteValidityDays resolves to the default validity.
  const { data: loadedCompany } = useLoad(
    () => getCompany(companyId),
    [companyId],
  );

  // Load which lines are already on a job (plain Supabase reads — no AI, safe on
  // mount). Re-runs whenever the quote reloads (e.g. after creating a job), so
  // the remaining-lines set and the banner stay current. Keyed by line-item id
  // (unique per quote), so a stale entry from another quote can never match.
  useEffect(() => {
    if (!quote) return;
    let cancelled = false;
    getQuoteConversionState(quoteId)
      .then((rows) => {
        if (cancelled) return;
        setConversions(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [quote, quoteId]);

  // Detect price drift once the quote is loaded (plain Supabase reads — no AI,
  // safe on mount). Runs for converted/expired quotes too so the "was → now"
  // indicator shows read-only; only the update action is gated by isEditable.
  // Depending on `quote` re-runs this after fetchQuote() (useLoad returns a
  // fresh object), so repricing clears the alert without a manual re-detect.
  useEffect(() => {
    if (!quote) return;
    let cancelled = false;
    detectQuoteLineDrift(quoteId)
      .then((rows) => {
        if (cancelled) return;
        setDriftByLine(new Map(rows.map((r) => [r.line_item_id, r])));
      })
      .catch((err) => console.warn('Quote detail: drift detection failed', err));
    return () => {
      cancelled = true;
    };
  }, [quote, quoteId]);

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

  const handleReprice = async () => {
    setRepricing(true);
    try {
      await repriceQuoteDriftedLinesToCurrent(quoteId, companyId);
      setRepriceDialogOpen(false);
      // fetchQuote() returns a fresh quote object → the drift effect re-runs and
      // clears the alert + per-line indicators once prices are current.
      await fetchQuote();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update prices');
      setRepriceDialogOpen(false);
    } finally {
      setRepricing(false);
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
      const c = company ?? loadedCompany ?? (await getCompany(companyId));
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
  // Converting is the only hard lock. Expired quotes stay editable — saving the
  // edit form with a today-or-later expiration date reactivates them (see the
  // edit-mode block below and updateQuote's status recompute).
  const isEditable = !convertedLocked;
  const daysLeft = daysUntilExpiration(quote.expiration_date);
  const lineItems = [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);
  const grandTotal = lineItems.reduce(
    (sum, li) => sum + (li.total_price ?? li.unit_price * li.quantity),
    0,
  );

  // Conversion state: which lines are already on a job, plus a job→PO lookup for
  // the banner. A quote may still have PARTS left to convert even after its first
  // job (one job per customer PO), so the Convert action follows the remaining
  // parts — not the binary converted_at lock.
  const convertedByLine = new Map(conversions.map((c) => [c.line_item_id, c]));
  // A part is "handled" when ANY of its line items is on a live job — a
  // price-options part converts one of its quantity lines and the OTHER quantity
  // options aren't pending work. Match the Convert-to-Job modal, which groups by
  // part, so the banner and the modal never disagree.
  const partIdsWithConversion = new Set(
    lineItems.filter((li) => convertedByLine.has(li.id)).map((li) => li.part_id),
  );
  const hasUnconvertedParts = lineItems.some((li) => !partIdsWithConversion.has(li.part_id));
  const someConverted = convertedByLine.size > 0;
  // Distinct live jobs off this quote (deduped by job_id), each with its PO.
  const jobsFromConversions = Array.from(
    new Map(
      conversions.map((c) => [
        c.job_id,
        { id: c.job_id, job_number: c.job_number, po: c.customer_po_number },
      ]),
    ).values(),
  );

  // Standing-terms drift: which of this quote's terms no longer match the
  // customer's CURRENT defaults. Comparison only — a difference is reported,
  // never applied, because the quote is an offer that was already sent.
  // A customer with no standing value for a field can't drift on it
  // (hasTermDrift returns false), so a shop that never fills these sees nothing.
  //
  // DELIBERATELY CUSTOMER-SCOPED. The shop-wide default payment terms are NOT
  // compared here, and must not be added: a quote that inherited the house term
  // would then chip on every open quote the day the shop changes its house term.
  // Shop policy moving is not a per-customer promise changing, and a chip that
  // fires on everything at once is a chip people learn to ignore.
  const termDrift = quote.customers
    ? (
        [
          { label: 'Payment terms', onQuote: quote.payment_terms, current: quote.customers.default_payment_terms },
        ] as const
      )
        .filter((f) => hasTermDrift(f.onQuote, f.current))
        .map((f) => ({ label: f.label, onQuote: f.onQuote ?? '', current: f.current ?? '' }))
    : [];

  // Price-drift summary. detectQuoteLineDrift already excludes override lines, so
  // every entry here is a real, repriceable change. The projected total applies
  // each drifted line's current price; non-drifted lines keep theirs.
  const driftCount = driftByLine.size;
  const driftedNewTotal = lineItems.reduce((sum, li) => {
    const d = driftByLine.get(li.id);
    const unit =
      d && !li.is_quote_override && d.current_unit_price !== null
        ? d.current_unit_price
        : li.unit_price;
    return sum + unit * li.quantity;
  }, 0);

  // Group line items by part (first-appearance order). A part with a single
  // quantity is a firm line; 2+ quantities is a price-options menu. The whole
  // quote is "firm" (grand total shown) only when EVERY part has one quantity.
  const partGroups: {
    part_id: string;
    part_name: string;
    description: string | null;
    // Effective lead time for this part (its own value, else the quote-level
    // lead time). Only rendered when hasPerItemLeadTimes.
    lead_time: string;
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
        // Lead time is per-part, so the group's first item carries it; fall
        // back to the quote-level lead time when this item has none.
        lead_time: (li.lead_time_text ?? '').trim() || (quote.lead_time_text ?? ''),
        items: [],
      });
    }
    partGroups[gi].items.push(li);
  }
  const isFirmQuote = partGroups.length > 0 && partGroups.every((g) => g.items.length === 1);
  // When any line has its own lead time, show lead time per item in the table
  // (below) instead of one quote-level line in the header — see the PDF, which
  // applies the same rule.
  const hasPerItemLeadTimes = lineItems.some(
    (li) => (li.lead_time_text ?? '').trim() !== '',
  );

  // Display the quote's frozen customer/address/contact snapshots (Document
  // Snapshot Standard), not the live address book — so the view matches the PDF
  // and survives the master address/contact being edited or deleted.
  const shippingAddress = quote.ship_to_address;
  const billingAddress = quote.bill_to_address;
  const quoteContact = quote.contact_snapshot;
  // Ship-to is its own column only when a distinct shipping address snapshot is
  // set (compared by value, so it survives the master address being deleted).
  const showShippingColumn =
    shippingAddress !== null &&
    JSON.stringify(shippingAddress) !== JSON.stringify(billingAddress);

  if (editMode && isEditable) {
    const handleSaveSuccess = async () => {
      setEditMode(false);
      await fetchQuote();
    };

    // Opening an expired quote for edit pre-fills a fresh future expiration date
    // so the default action (save without touching the date) reactivates it.
    // The field stays editable if the user wants a different date; saving a
    // still-past date leaves it expired (updateQuote derives status from it).
    const initialData = quoteToFormData(quote);
    if (expired) {
      initialData.expiration_date = defaultExpirationDate(
        readQuoteValidityDays(loadedCompany),
      );
    }

    return (
      <Box>
        {expired && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This quote is expired. It has a new expiration date — save to
            reactivate it, or pick a different future date.
          </Alert>
        )}
        <QuoteForm
          mode="edit"
          initialData={initialData}
          quoteId={quote.id}
          onCancel={() => setEditMode(false)}
          onSave={handleSaveSuccess}
        />
      </Box>
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
        {/* One action row of standalone buttons following the design-system
            hierarchy: Convert to Job is the primary (contained) action; Edit and
            View PDF are secondary (outlined); Delete is a red icon button. Labelled
            buttons (not a hidden icon menu) read better for the shop-floor tablet /
            older-user audience. */}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {hasUnconvertedParts && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PlayArrowIcon />}
              onClick={() => setConvertModalOpen(true)}
              disabled={actionLoading}
            >
              {someConverted ? 'Create Another Job' : 'Convert to Job'}
            </Button>
          )}
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
          <Button
            variant="outlined"
            startIcon={
              previewLoading ? <CircularProgress size={18} color="inherit" /> : <VisibilityIcon />
            }
            onClick={handleOpenPreview}
            disabled={actionLoading || previewLoading}
          >
            View PDF
          </Button>
          <Tooltip title="Delete quote">
            <span>
              <IconButton
                color="error"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading}
                aria-label="Delete quote"
                sx={{ minWidth: 48, minHeight: 48 }}
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
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
            {/* "Created by" moved lower (see "Prepared by" below the line items),
                mirroring the PDF now that acceptance no longer needs a signature. */}
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
            {quote.lead_time_text && !hasPerItemLeadTimes && (
              <Typography variant="body2" color="text.secondary">
                Lead time: {quote.lead_time_text}
              </Typography>
            )}
            {quote.payment_terms && (
              <Typography variant="body2" color="text.secondary">
                Payment terms: {quote.payment_terms}
              </Typography>
            )}
          </Box>
          {/* STANDING-TERMS DRIFT. This quote was issued with the terms above;
              the customer's standing terms have since changed. We say so and
              stop there — the quote is an offer already sent as a PDF, so its
              terms are never rewritten from the customer record. Same discipline
              as the price-drift banner below, and the reason these defaults are
              not a repeat of the read-time inheritance that got markup_rates
              deleted. There is deliberately no "update to current" action:
              re-agreeing terms is a conversation, not a button. */}
          {termDrift.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
              {termDrift.map((d) => (
                <Tooltip
                  key={d.label}
                  title={`This quote says “${d.onQuote || '—'}”. ${quote.customers?.name ?? 'The customer'} is now set to “${d.current}”. The quote keeps what it was issued with.`}
                >
                  <Chip
                    size="small"
                    variant="outlined"
                    color="warning"
                    label={`${d.label} differs from standing terms`}
                  />
                </Tooltip>
              ))}
            </Box>
          )}
        </Box>
        {/* Document-level + lifecycle actions moved to the single top toolbar
            row (primary "Convert to Job" + overflow menu). Invoicing lives on
            the Job (job-keyed); the converted-jobs banner below links through. */}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Converted to Jobs Banner. Built from live conversions (cancelled /
          archived jobs excluded), each shown with its customer PO. A quote can be
          converted in several passes, so it may still have lines left to convert. */}
      {someConverted && (
        <Alert severity={hasUnconvertedParts ? 'info' : 'success'} sx={{ mb: 3 }}>
          Jobs from this quote:{' '}
          {jobsFromConversions.map((j, i) => (
            <span key={j.id}>
              {i > 0 && ', '}
              <MuiLink
                component={Link}
                href={`/dashboard/${companyId}/jobs/${j.id}`}
                sx={{ fontWeight: 600 }}
              >
                Job {j.job_number}
              </MuiLink>
              {j.po ? ` (PO ${j.po})` : ''}
            </span>
          ))}
          {hasUnconvertedParts && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              Some parts on this quote aren&apos;t on a job yet — use{' '}
              <strong>Create Another Job</strong> to add them under a new PO.
            </Typography>
          )}
          {lineItems.some((li) => {
            const j = convertedByLine.get(li.id);
            return j && j.quantity !== li.quantity;
          }) && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              Some order quantities changed on the job after conversion — the quoted
              figures below are unchanged; current job quantities are noted inline.
            </Typography>
          )}
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
                  {/* Customer — name + billing address. Ship-to gets its own
                      column only when it differs; otherwise just Customer +
                      Contact (two columns). */}
                  <Grid size={{ xs: 12, sm: 6, md: showShippingColumn ? 4 : 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      Customer
                    </Typography>
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/customers/${quote.customer_id}`}
                      sx={{ fontWeight: 500, display: 'block' }}
                    >
                      {quote.customers.name}
                    </MuiLink>
                    <Box sx={{ mt: 0.5 }}>
                      <AddressDisplay address={billingAddress} />
                    </Box>
                  </Grid>
                  {showShippingColumn && (
                    <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                      <Typography variant="body2" color="text.secondary">
                        Ship to
                      </Typography>
                      <AddressDisplay address={shippingAddress} />
                    </Grid>
                  )}
                  <Grid size={{ xs: 12, sm: 6, md: showShippingColumn ? 4 : 6 }} sx={{ minWidth: 0 }}>
                    <Typography variant="body2" color="text.secondary">
                      Contact
                    </Typography>
                    {quoteContact ? (
                      <Box>
                        <Typography variant="body1" sx={{ fontWeight: 500 }}>
                          {quoteContact.name}
                        </Typography>
                        {quoteContact.email && (
                          <MuiLink
                            href={`mailto:${quoteContact.email}`}
                            variant="body2"
                            sx={{ display: 'block', overflowWrap: 'anywhere' }}
                          >
                            {quoteContact.email}
                          </MuiLink>
                        )}
                        {quoteContact.phone && (
                          <MuiLink
                            href={`tel:${quoteContact.phone}`}
                            variant="body2"
                            sx={{ display: 'block' }}
                          >
                            {quoteContact.phone}
                          </MuiLink>
                        )}
                      </Box>
                    ) : (
                      <Typography variant="body1" color="text.secondary">
                        Not set
                      </Typography>
                    )}
                  </Grid>
                </Grid>
              ) : (
                <Typography color="text.secondary">Customer not found</Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Price-drift notice — surfaced read-only on the detail page; the
            single explicit action reprices all drifted lines (per-line keep/
            replace nuance stays on the edit page). */}
        {driftCount > 0 && (
          <Grid size={{ xs: 12 }}>
            <Alert
              severity="info"
              data-testid="quote-drift-summary"
              action={
                isEditable ? (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => setRepriceDialogOpen(true)}
                  >
                    Update prices to current
                  </Button>
                ) : (
                  // Only reachable for converted quotes now — expired quotes are
                  // editable, so they hit the enabled button above.
                  <Tooltip title="This quote is converted — update prices on the job instead.">
                    <span>
                      <Button color="inherit" size="small" disabled>
                        Update prices to current
                      </Button>
                    </span>
                  </Tooltip>
                )
              }
            >
              {driftCount === 1
                ? '1 line has a price change since this quote was created.'
                : `${driftCount} lines have price changes since this quote was created.`}
            </Alert>
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
                              <td rowSpan={rows.length}>
                                <MuiLink
                                  component={Link}
                                  href={`/dashboard/${companyId}/parts/${group.part_id}`}
                                  sx={{
                                    color: 'inherit',
                                    fontWeight: 600,
                                    textDecoration: 'none',
                                    '&:hover': { textDecoration: 'underline' },
                                  }}
                                >
                                  {group.part_name}
                                </MuiLink>
                                {hasPerItemLeadTimes && group.lead_time && (
                                  <Box
                                    component="span"
                                    sx={{
                                      display: 'block',
                                      fontSize: '0.75rem',
                                      color: 'text.secondary',
                                      fontWeight: 400,
                                      mt: 0.5,
                                    }}
                                  >
                                    Lead time: {group.lead_time}
                                  </Box>
                                )}
                              </td>
                            )}
                            {i === 0 && (
                              <td rowSpan={rows.length}>{group.description ?? ''}</td>
                            )}
                            <td className="num">
                              {li.quantity}
                              {(() => {
                                const jobQ = convertedByLine.get(li.id);
                                if (!jobQ || jobQ.quantity === li.quantity) return null;
                                return (
                                  <Tooltip
                                    title={`Order quantity was changed to ${jobQ.quantity} on Job ${jobQ.job_number} after this quote was converted. The quote keeps the originally quoted figure.`}
                                  >
                                    <Box
                                      component="span"
                                      sx={{
                                        display: 'block',
                                        fontSize: '0.7rem',
                                        fontWeight: 600,
                                        color: 'warning.main',
                                      }}
                                    >
                                      now {jobQ.quantity} on job
                                    </Box>
                                  </Tooltip>
                                );
                              })()}
                            </td>
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
                              {(() => {
                                const d = driftByLine.get(li.id);
                                if (!d || li.is_quote_override) return null;
                                return (
                                  <Tooltip title="The part's tier pricing changed after this quote was created. The quote keeps its original price until you update it.">
                                    <Box
                                      component="span"
                                      data-testid={`quote-line-drift-${li.id}`}
                                      sx={{
                                        display: 'block',
                                        fontSize: '0.7rem',
                                        fontWeight: 600,
                                        color: 'warning.main',
                                      }}
                                    >
                                      was {formatCurrency(d.snapshotted_unit_price)} → now{' '}
                                      {formatCurrency(d.current_unit_price)}
                                    </Box>
                                  </Tooltip>
                                );
                              })()}
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

      {/* Prepared by — relocated from the header, mirroring the PDF footer. */}
      {(quote.created_by_member?.name || quote.created_by_member?.email) && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
          Prepared by{' '}
          <Typography component="span" variant="body2" color="text.primary" sx={{ fontWeight: 500 }}>
            {quote.created_by_member.name || quote.created_by_member.email}
          </Typography>
        </Typography>
      )}

      {/* Preview PDF Dialog */}
      {company && (
        <QuotePdfPreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          quote={quote}
          company={company}
        />
      )}

      {/* Convert to Job Modal */}
      <ConvertToJobModal
        open={convertModalOpen}
        onClose={() => setConvertModalOpen(false)}
        quote={quote}
        conversions={conversions}
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

      {/* Update-prices-to-current Confirmation Dialog */}
      <Dialog
        open={repriceDialogOpen}
        onClose={repricing ? undefined : () => setRepriceDialogOpen(false)}
      >
        <DialogTitle>Update prices to current?</DialogTitle>
        <DialogContent>
          <Typography>
            {driftCount === 1
              ? 'Update 1 line to its current tier price?'
              : `Update ${driftCount} lines to their current tier prices?`}
            {isFirmQuote && (
              <>
                {' '}
                Quote total {formatCurrency(grandTotal)} → {formatCurrency(driftedNewTotal)}.
              </>
            )}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This rewrites each line&apos;s price and pricing snapshot and can&apos;t be undone
            from here. Use Edit quote for per-line control (keep some, update others).
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRepriceDialogOpen(false)} disabled={repricing}>
            Cancel
          </Button>
          <Button
            onClick={handleReprice}
            color="primary"
            variant="contained"
            disabled={repricing}
            startIcon={repricing ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {repricing ? 'Updating…' : 'Update prices'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
