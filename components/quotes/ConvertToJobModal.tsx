'use client';

import ErrorAlert from '@/components/common/ErrorAlert';
import { useState, useMemo } from 'react';
import posthog from 'posthog-js';
import Link from 'next/link';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import BusyButton from '@/components/common/BusyButton';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import {
  convertQuoteToJobs,
  type ConvertQuoteToJobsResult,
  type QuoteLineConversion,
} from '@/utils/quotesAccess';
import { resolveJobPartUnitPrice, type JobPartPricingBasis } from '@/utils/quotePricingResolver';
import { unitShortLabel } from '@/lib/standardUnits';
import { uploadJobAttachment } from '@/utils/jobAttachmentsAccess';
import AttachmentUploadField from '@/components/jobs/AttachmentUploadField';

/** Parse a positive-number quantity input, or null if blank/invalid. */
function parseQty(s: string | undefined): number | null {
  if (s == null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Repriced order figures for a line at a (possibly changed) quantity.
 *
 * `crossesBreak` is true only when the ordered quantity lands in a DIFFERENT
 * snapshot tier than the quoted quantity — i.e. a real price-break crossing.
 * That's the only case where a reprice is meaningful; a single-tier part (or an
 * unchanged qty) never crosses a break, so no reprice is offered and the agreed
 * price is kept. (A drift between the line's stored price and the current tier
 * table is a separate concern, surfaced on the quote detail page — not here.)
 */
function priceLineAtQty(
  line: QuoteLineItem,
  qty: number,
  useTierPrice: boolean,
): { unitPrice: number | null; total: number | null; tierPrice: number | null; crossesBreak: boolean } {
  const basis: JobPartPricingBasis = {
    isOverride: line.is_quote_override ?? false,
    basisUnknown: line.basis_unknown ?? false,
    snapshot: line.pricing_basis_snapshot ?? null,
  };
  const { keepUnitPrice, tierUnitPrice } = resolveJobPartUnitPrice(line.unit_price, basis, qty);
  const tierAtQuoted = resolveJobPartUnitPrice(line.unit_price, basis, line.quantity).tierUnitPrice;
  const crossesBreak =
    qty !== line.quantity &&
    tierUnitPrice !== null &&
    tierAtQuoted !== null &&
    tierUnitPrice !== tierAtQuoted;
  const unitPrice = crossesBreak && useTierPrice ? tierUnitPrice : keepUnitPrice;
  const total = unitPrice != null ? Math.round(unitPrice * qty * 100) / 100 : null;
  return { unitPrice, total, tierPrice: tierUnitPrice, crossesBreak };
}

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  /**
   * Line items already consumed by a live job (with their job/PO). A quote can
   * be converted in several passes — one PO at a time — so these parts are shown
   * as already-done and excluded from this pass's selection.
   */
  conversions?: QuoteLineConversion[];
  /**
   * The pass created at least one job. `navigateToJobId` is set only when there
   * is exactly one job and nothing to report; otherwise the modal keeps itself
   * open to show the summary and the page should just refresh underneath.
   */
  onConverted: (created: { jobIds: string[]; navigateToJobId: string | null }) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString();
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

/** Today as a local ISO date string (yyyy-mm-dd) — the min for the picker. */
function todayLocalISODate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A due date is required and may not be in the past. */
function dueDateIsValid(value: string | undefined, today: string): boolean {
  if (!value) return false;
  if (Number.isNaN(new Date(value).getTime())) return false;
  return value >= today;
}

export default function ConvertToJobModal({
  open,
  onClose,
  quote,
  conversions,
  onConverted,
}: ConvertToJobModalProps) {
  const [loading, setLoading] = useState(false);
  // Holds the caught error, not a formatted string — ErrorAlert needs the object to tell
  // a billing block from an ordinary failure.
  const [error, setError] = useState<unknown>(null);

  // Customer PO is captured at conversion (when the customer has accepted
  // and issued a PO), not at quote-creation. Stored on jobs.customer_po_number
  // (migration 20260526), so the modal always starts empty — the quote
  // never carries one. REQUIRED to convert (the work-order authorization).
  // ONE PO authorizes the whole pass, however many jobs it creates.
  const [customerPoInput, setCustomerPoInput] = useState<string>('');
  // Optional PO PDF, staged here and attached to every job the pass creates.
  const [attachment, setAttachment] = useState<File | null>(null);

  // The finished pass. While this is set the form is replaced by a summary, so
  // a second submit is structurally impossible rather than merely disabled.
  const [result, setResult] = useState<ConvertQuoteToJobsResult | null>(null);
  // Jobs whose PO PDF failed to attach — noted per row, never demoting a created
  // job to a failure.
  const [attachmentFailedJobIds, setAttachmentFailedJobIds] = useState<string[]>([]);
  // "Creating job 2 of 3…" — a fan-out crosses the 1s threshold where
  // docs/interaction-standards.md §5 requires the control to name its wait.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  // Part display data keyed by id, built from EVERY line rather than from
  // partGroups: the summary panel has to keep naming the parts it just converted,
  // and by then the parent has refetched and moved them into convertedGroups.
  const partDisplayById = useMemo(() => {
    const m = new Map<string, { name: string; unit: string }>();
    for (const li of lineItems) {
      if (m.has(li.part_id)) continue;
      m.set(li.part_id, {
        name: li.parts?.part_name ?? 'Part',
        unit: unitShortLabel(li.parts?.primary_unit) ?? 'ea',
      });
    }
    return m;
  }, [lineItems]);

  // A quote is converted in one or more passes. Lines already on a live job are
  // locked; the whole part is "done" once any of its lines is converted (only one
  // line per part ever converts).
  const convertedByLine = useMemo(
    () => new Map((conversions ?? []).map((c) => [c.line_item_id, c])),
    [conversions],
  );
  const convertedPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const li of lineItems) {
      if (convertedByLine.has(li.id)) ids.add(li.part_id);
    }
    return ids;
  }, [lineItems, convertedByLine]);
  const isFirstConversion = convertedPartIds.size === 0;

  // Group line items by part (first-appearance order). A part with one
  // quantity converts as-is; a part with several quantities (price options)
  // needs the salesperson to pick the accepted quantity before converting.
  // Split into the parts still available to convert this pass vs the ones
  // already on a job (shown read-only so the user sees the full picture).
  // When ANY line carries its own lead time, lead time is shown per part below
  // and the single quote-level value is suppressed — the same all-or-nothing
  // rule the PDF (`quotePdf.ts`) and the quote detail page apply, so the three
  // surfaces can't contradict each other.
  const hasPerItemLeadTimes = useMemo(
    () => lineItems.some((li) => (li.lead_time_text ?? '').trim() !== ''),
    [lineItems],
  );

  const { partGroups, convertedGroups } = useMemo(() => {
    const groups: {
      part_id: string;
      part_name: string;
      unit: string;
      /** Effective lead time: the part's own value, else the quote-level one. */
      lead_time: string;
      items: QuoteLineItem[];
    }[] = [];
    const index = new Map<string, number>();
    for (const li of lineItems) {
      let gi = index.get(li.part_id);
      if (gi === undefined) {
        gi = groups.length;
        index.set(li.part_id, gi);
        groups.push({
          part_id: li.part_id,
          part_name: li.parts?.part_name ?? 'Part',
          // Real unit so a fractional order reads "0.32 in" not "0.32 ea";
          // count parts still show "ea". Falls back to "ea" for a unitless part.
          unit: unitShortLabel(li.parts?.primary_unit) ?? 'ea',
          lead_time: (li.lead_time_text ?? '').trim() || (quote.lead_time_text ?? ''),
          items: [],
        });
      }
      groups[gi].items.push(li);
    }
    return {
      partGroups: groups.filter((g) => !convertedPartIds.has(g.part_id)),
      convertedGroups: groups.filter((g) => convertedPartIds.has(g.part_id)),
    };
  }, [lineItems, convertedPartIds, quote.lead_time_text]);

  // part_id → the "base" line item this part converts from. Every part has one
  // (defaults to the lowest-quantity line). For a price-options part its quoted
  // quantities are quick-pick chips that set this base + the qty; whatever the
  // base line is, the price re-resolves from its (shared) tier snapshot at the
  // ordered quantity, so any base yields the same price.
  const [selectedByPart, setSelectedByPart] = useState<Record<string, string>>({});
  // part_id → include this part in THIS pass. A quote is converted in one or more
  // passes, so the user checks the subset this PO covers; unchecked parts stay on
  // the quote for a later pass. Defaults to all-in (the common case: one PO for
  // the whole quote is a single click).
  const [includedByPart, setIncludedByPart] = useState<Record<string, boolean>>({});
  // part_id → the ORDERED quantity for this part's job (editable string). Every
  // part gets an editable field (defaults to the quoted / lowest-break quantity);
  // the customer can order any quantity (partial acceptance / a qty between
  // breaks), and the price follows the tier at that quantity.
  const [qtyByPart, setQtyByPart] = useState<Record<string, string>>({});
  // part_id → that part's ship-by date. Each checked part becomes its own job, so
  // each carries its own date — a quote whose parts have different lead times
  // converts into jobs genuinely due on different days. The single "Due date"
  // field below fills every row at once, which keeps the common case (one PO, one
  // date) a single entry.
  const [dueDateByPart, setDueDateByPart] = useState<Record<string, string>>({});
  // part_id → opt into the tier price re-resolved at the ordered quantity (vs
  // keeping the agreed price). Applies only to FIRM (single-tier) parts, which
  // have one committed price; price-options parts always price at the tier.
  const [useTierByPart, setUseTierByPart] = useState<Record<string, boolean>>({});
  const includedGroups = partGroups.filter((g) => includedByPart[g.part_id]);
  const anyIncluded = includedGroups.length > 0;
  // Every INCLUDED part must have a valid (>0) ordered quantity.
  const allQtysValid = includedGroups.every((g) => parseQty(qtyByPart[g.part_id]) !== null);

  const today = todayLocalISODate();
  // Every INCLUDED part must have a valid, not-in-the-past due date. Replaces the
  // old single dueDateValid now that a pass creates one job per part.
  const allDueDatesValid = includedGroups.every((g) =>
    dueDateIsValid(dueDateByPart[g.part_id], today),
  );

  // Reset the form each time the modal opens (house convention: onEnter,
  // not a reset useEffect, which would trip set-state-in-effect).
  const handleEnter = () => {
    setCustomerPoInput('');
    setAttachment(null);
    setResult(null);
    setAttachmentFailedJobIds([]);
    setProgress(null);
    setError(null);
    const initialSel: Record<string, string> = {};
    const initialInc: Record<string, boolean> = {};
    const initialQty: Record<string, string> = {};
    for (const g of partGroups) {
      initialInc[g.part_id] = true; // default: this PO covers the whole quote
      // Base = the lowest-quantity line; qty defaults to its quantity.
      const base = [...g.items].sort((a, b) => a.quantity - b.quantity)[0];
      initialSel[g.part_id] = base.id;
      initialQty[g.part_id] = String(base.quantity);
    }
    setSelectedByPart(initialSel);
    setIncludedByPart(initialInc);
    setQtyByPart(initialQty);
    setDueDateByPart({});
    setUseTierByPart({});
  };

  /**
   * The "Due date" field is a set-all control: it writes into every included
   * part's own date. Individual rows can then diverge. Keeping one entry point
   * for the common case (one PO, one date) is why the shared field survives at
   * all now that the date is genuinely per-part.
   */
  const setAllDueDates = (value: string) => {
    setDueDateByPart((prev) => {
      const next = { ...prev };
      for (const g of partGroups) {
        if (includedByPart[g.part_id]) next[g.part_id] = value;
      }
      return next;
    });
  };
  // Shown in the set-all field: the common value when every included part agrees,
  // blank once one has been changed on its own. Derived, never latched.
  const sharedDueDate = (() => {
    if (includedGroups.length === 0) return '';
    const first = dueDateByPart[includedGroups[0].part_id] ?? '';
    return includedGroups.every((g) => (dueDateByPart[g.part_id] ?? '') === first) ? first : '';
  })();

  const poValid = customerPoInput.trim() !== '';

  // The first job off a quote keeps the mirror number (Q-0141 → J-0141); the rest
  // draw suffixes we can't predict here, because isFirstConversion is derived
  // from LIVE conversions and an archived or cancelled sibling silently shifts
  // every suffix. So promise the mirror only when this pass creates exactly one
  // job on a fresh quote; otherwise say the count.
  const expectedJobNumber = quote.quote_number.replace(/^Q-/, 'J-');
  const createLabel =
    includedGroups.length > 1
      ? `Create ${includedGroups.length} Jobs`
      : isFirstConversion
        ? `Create ${expectedJobNumber}`
        : 'Create Job';
  const nothingToConvert = partGroups.length === 0;

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: includedGroups.length });
    try {
      const selectedLineItemIds = includedGroups
        .map((g) => selectedByPart[g.part_id])
        .filter((id): id is string => !!id);
      // Per-part quantity, due date and reprice override, keyed by the base line.
      // A firm (single-tier) part keeps its committed price unless the user opts
      // into the tier reprice; a price-options part always prices at the tier for
      // the ordered quantity (useTierPrice = true), which is what its quoted
      // breaks are.
      const lineOverrides: Record<
        string,
        { quantity: number; useTierPrice?: boolean; dueDate?: string }
      > = {};
      for (const g of includedGroups) {
        const baseId = selectedByPart[g.part_id];
        const q = parseQty(qtyByPart[g.part_id]);
        if (!baseId || q === null) continue;
        const isMultiTier = g.items.length > 1;
        lineOverrides[baseId] = {
          quantity: q,
          useTierPrice: isMultiTier ? true : !!useTierByPart[g.part_id],
          dueDate: dueDateByPart[g.part_id],
        };
      }
      const converted = await convertQuoteToJobs(quote.id, {
        // Every included part carries its own date, so this only ever covers a
        // programmatic caller that omitted one. Sent so the option stays
        // satisfied rather than relying on the per-line value being present.
        dueDate: sharedDueDate || dueDateByPart[includedGroups[0]?.part_id] || '',
        customerPoNumber: customerPoInput,
        selectedLineItemIds,
        lineOverrides,
        onProgress: (done, total) => setProgress({ done, total }),
      });

      // Attach the PO PDF to EVERY job this pass created — one PO authorizes all
      // of them, and a job showing a PO number with no document (and no pointer
      // to one) is the worse failure. Sequential, not Promise.all: parallel
      // uploads of the same file are a worse experience on an office connection.
      // Non-fatal per job — a failed attach never demotes a created job.
      const failedAttachments: string[] = [];
      if (attachment) {
        for (const job of converted.jobs) {
          try {
            await uploadJobAttachment(quote.company_id, job.job_id, attachment);
          } catch (uploadErr) {
            console.error('PO PDF upload failed:', uploadErr);
            failedAttachments.push(job.job_id);
          }
        }
      }

      posthog.capture('quote converted to job', {
        quote_id: quote.id,
        part_count: includedGroups.length,
        failed_count: converted.failures.length,
      });

      setAttachmentFailedJobIds(failedAttachments);
      setResult(converted);

      // Hand off only when there is exactly one job and nothing to report;
      // anything else stays open so the summary can say what happened.
      const clean =
        converted.failures.length === 0 &&
        failedAttachments.length === 0 &&
        converted.jobs.length === 1;
      onConverted({
        jobIds: converted.jobs.map((j) => j.job_id),
        navigateToJobId: clean ? converted.jobs[0].job_id : null,
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setError(null);
      onClose();
    }
  };

  const expired = isQuoteExpired(quote);
  const companyId = quote.company_id;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>Convert to Jobs</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          {error != null && (
            <ErrorAlert
              error={error}
              entity="job"
              fallback="Couldn't convert this quote to a job. Please try again."
              onClose={() => setError(null)}
              sx={{ mb: 2 }}
            />
          )}

          {/* ── The finished pass. Replaces the form entirely, so a second submit
                is impossible rather than merely disabled. ─────────────────── */}
          {result ? (
            <Box>
              <Typography variant="body1" gutterBottom>
                {result.failures.length === 0
                  ? `Created ${result.jobs.length} job${result.jobs.length === 1 ? '' : 's'} from ${quote.quote_number}`
                  : `Created ${result.jobs.length} of ${result.jobs.length + result.failures.length} jobs from ${quote.quote_number}`}
              </Typography>

              <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {result.jobs.map((job) => {
                  const display = partDisplayById.get(job.part_id);
                  return (
                    <Box key={job.job_id}>
                      <Typography variant="body2">
                        <MuiLink
                          component={Link}
                          href={`/dashboard/${companyId}/jobs/${job.job_id}`}
                          sx={{ fontWeight: 700 }}
                        >
                          {job.job_number}
                        </MuiLink>
                        {' — '}
                        {display?.name ?? 'Part'} · {job.quantity} {display?.unit ?? 'ea'} · due{' '}
                        {formatDate(job.due_date)}
                      </Typography>
                      {attachmentFailedJobIds.includes(job.job_id) && (
                        <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                          PDF not attached — open the job to add it.
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>

              {result.failures.length > 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {result.failures.map((f) => (
                    <Typography key={f.source_quote_line_item_id} variant="body2">
                      {partDisplayById.get(f.part_id)?.name ?? 'Part'} — {f.message}
                    </Typography>
                  ))}
                  {result.failures.some((f) => f.retryable) && (
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      Those parts are still on the quote — use{' '}
                      <strong>Create Another Job</strong> to try again.
                    </Typography>
                  )}
                </Alert>
              )}
            </Box>
          ) : (
            <>
              {expired && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  This quote expired on <strong>{formatDate(quote.expiration_date)}</strong>.
                  Pricing may no longer be accurate — double-check before creating the job.
                </Alert>
              )}

              <Typography variant="body1">
                {isFirstConversion ? 'Convert ' : 'Create more jobs from '}
                <strong>{quote.quote_number}</strong> — each checked part becomes its own job.
              </Typography>

              {convertedGroups.length > 0 && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Already on a job:
                  </Typography>
                  {convertedGroups.map((group) => {
                    const conv = group.items
                      .map((li) => convertedByLine.get(li.id))
                      .find((c): c is QuoteLineConversion => !!c);
                    return (
                      <Typography key={group.part_id} variant="body2" color="text.secondary">
                        • {group.part_name}
                        {conv
                          ? ` — Job ${conv.job_number}${
                              conv.customer_po_number ? ` (PO ${conv.customer_po_number})` : ''
                            }`
                          : ' — converted'}
                      </Typography>
                    );
                  })}
                </Box>
              )}

              <Divider sx={{ my: 2 }} />

              {partGroups.length > 0 && (
                <>
                  <Typography variant="caption" color="text.secondary">
                    Parts to convert — one job each
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    {partGroups.map((group, gi) => {
                      const included = !!includedByPart[group.part_id];
                      const toggle = (checked: boolean) => {
                        setIncludedByPart((prev) => ({ ...prev, [group.part_id]: checked }));
                        // Checking a part on seeds its date from whatever the
                        // other included parts already agree on, so the set-all
                        // field doesn't have to be re-entered.
                        if (checked && !dueDateByPart[group.part_id] && sharedDueDate) {
                          setDueDateByPart((prev) => ({
                            ...prev,
                            [group.part_id]: sharedDueDate,
                          }));
                        }
                      };
                      const isMultiTier = group.items.length > 1;
                      const sortedItems = [...group.items].sort((a, b) => a.quantity - b.quantity);
                      const baseLine =
                        group.items.find((li) => li.id === selectedByPart[group.part_id]) ??
                        sortedItems[0];
                      const orderedQty = parseQty(qtyByPart[group.part_id]);
                      // Firm part: keep the committed price unless the user opts into the
                      // tier. Price-options part: always price at the tier for the qty —
                      // that's what its quoted breaks are.
                      const useTier = isMultiTier ? true : !!useTierByPart[group.part_id];
                      const priced =
                        orderedQty !== null
                          ? priceLineAtQty(baseLine, orderedQty, useTier)
                          : { unitPrice: null, total: null, tierPrice: null, crossesBreak: false };
                      const qtyChanged = orderedQty !== null && orderedQty !== baseLine.quantity;
                      const partDue = dueDateByPart[group.part_id] ?? '';
                      const partDueBad = included && partDue !== '' && !dueDateIsValid(partDue, today);
                      return (
                        <Box
                          key={group.part_id}
                          sx={{
                            py: 1.5,
                            borderTop: gi === 0 ? 'none' : '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          {/* Part header: checkbox + name, with the price-options breaks as
                              one-tap chips inline to the right of the name (wrapping below the
                              name when they're too long for the row). */}
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Checkbox
                              size="small"
                              edge="start"
                              checked={included}
                              onChange={(e) => toggle(e.target.checked)}
                              inputProps={{ 'aria-label': `Include ${group.part_name}` }}
                              sx={{ p: 0.5, alignSelf: 'flex-start', mt: 0.25 }}
                            />
                            <Box
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1,
                                flexWrap: 'wrap',
                                minWidth: 0,
                                opacity: included ? 1 : 0.45,
                              }}
                            >
                              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                                {group.part_name}
                              </Typography>
                              {isMultiTier &&
                                sortedItems.map((li) => {
                                  const active = orderedQty === li.quantity;
                                  return (
                                    <Chip
                                      key={li.id}
                                      size="small"
                                      label={`${li.quantity} ${group.unit} · ${formatCurrency(li.unit_price)}`}
                                      color={active ? 'primary' : 'default'}
                                      variant={active ? 'filled' : 'outlined'}
                                      onClick={
                                        included
                                          ? () => {
                                              setSelectedByPart((prev) => ({
                                                ...prev,
                                                [group.part_id]: li.id,
                                              }));
                                              setQtyByPart((prev) => ({
                                                ...prev,
                                                [group.part_id]: String(li.quantity),
                                              }));
                                            }
                                          : undefined
                                      }
                                    />
                                  );
                                })}
                            </Box>
                          </Box>

                          {/* Quantity, this part's due date, and price — indented
                              under the name; dimmed when excluded. */}
                          <Box sx={{ pl: 4.5, mt: 1.25, opacity: included ? 1 : 0.45 }}>
                            <Box
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1.5,
                                flexWrap: 'wrap',
                              }}
                            >
                              <TextField
                                size="small"
                                label="Order qty"
                                value={qtyByPart[group.part_id] ?? ''}
                                onChange={(e) =>
                                  setQtyByPart((prev) => ({
                                    ...prev,
                                    [group.part_id]: e.target.value,
                                  }))
                                }
                                disabled={!included || loading}
                                inputMode="decimal"
                                error={included && orderedQty === null}
                                sx={{ width: 104 }}
                                slotProps={{ inputLabel: { shrink: true } }}
                              />
                              <TextField
                                size="small"
                                type="date"
                                label={`Due date — ${group.part_name}`}
                                value={partDue}
                                onChange={(e) =>
                                  setDueDateByPart((prev) => ({
                                    ...prev,
                                    [group.part_id]: e.target.value,
                                  }))
                                }
                                disabled={!included || loading}
                                error={partDueBad}
                                sx={{ width: 200 }}
                                slotProps={{
                                  inputLabel: { shrink: true },
                                  htmlInput: { min: today },
                                }}
                              />
                              <Typography variant="body2" color="text.secondary">
                                {group.unit} @ {formatCurrency(priced.unitPrice)} ={' '}
                                <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
                                  {formatCurrency(priced.total)}
                                </Box>
                              </Typography>
                            </Box>

                            {/* Per-part lead time, shown only when the quote actually
                                carries differing ones — otherwise the single value
                                below covers every part and repeating it is noise. */}
                            {hasPerItemLeadTimes && group.lead_time !== '' && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ display: 'block', mt: 0.75 }}
                              >
                                Lead time: {group.lead_time}
                              </Typography>
                            )}

                            {/* Firm part only: committed-qty note + reprice opt-in on a break
                                crossing. Price-options parts always price at the tier. */}
                            {!isMultiTier && qtyChanged && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ display: 'block', mt: 0.75 }}
                              >
                                Quoted {baseLine.quantity} {group.unit}
                                {priced.crossesBreak ? '' : ' — price kept from the quote'}
                              </Typography>
                            )}
                            {!isMultiTier && included && priced.crossesBreak && (
                              <FormControlLabel
                                sx={{ mt: 0.25, ml: 0 }}
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={!!useTierByPart[group.part_id]}
                                    onChange={(e) =>
                                      setUseTierByPart((prev) => ({
                                        ...prev,
                                        [group.part_id]: e.target.checked,
                                      }))
                                    }
                                    sx={{ p: 0.5 }}
                                  />
                                }
                                label={
                                  <Typography variant="caption" color="text.secondary">
                                    Reprice to the qty-{orderedQty} tier (
                                    {formatCurrency(priced.tierPrice)}/{group.unit})
                                  </Typography>
                                }
                              />
                            )}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                </>
              )}

              {lineItems.length === 0 && (
                <Alert severity="warning">
                  This quote has no line items — add at least one before converting.
                </Alert>
              )}

              {lineItems.length > 0 && nothingToConvert && (
                <Alert severity="info">Every part on this quote is already on a job.</Alert>
              )}

              <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {!hasPerItemLeadTimes && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Quoted lead time
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {quote.lead_time_text ?? 'Not specified'}
                    </Typography>
                  </Box>
                )}
                {/* Set-all convenience, shown only when there is more than one
                    part to set. With a single part its own field above IS the
                    due date, and a second control that does the same thing would
                    be noise. */}
                {includedGroups.length > 1 && (
                  <TextField
                    label="Due date (all parts)"
                    type="date"
                    size="small"
                    fullWidth
                    value={sharedDueDate}
                    onChange={(e) => setAllDueDates(e.target.value)}
                    disabled={loading}
                    helperText="Fills the due date for every checked part. Change any part's own date above to differ."
                    slotProps={{
                      inputLabel: { shrink: true },
                      htmlInput: { min: today },
                    }}
                  />
                )}
                <TextField
                  label="Customer PO #"
                  size="small"
                  fullWidth
                  value={customerPoInput}
                  onChange={(e) => setCustomerPoInput(e.target.value)}
                  disabled={loading}
                />
                <AttachmentUploadField
                  file={attachment}
                  onChange={setAttachment}
                  disabled={loading}
                />
              </Box>
            </>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {result ? (
          <Button variant="contained" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <BusyButton
              variant="contained"
              onClick={handleConvert}
              pending={loading}
              pendingLabel={
                progress && progress.total > 1
                  ? `Creating job ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                  : 'Creating…'
              }
              disabled={
                loading ||
                lineItems.length === 0 ||
                nothingToConvert ||
                !anyIncluded ||
                !allDueDatesValid ||
                !allQtysValid ||
                !poValid
              }
            >
              {createLabel}
            </BusyButton>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
