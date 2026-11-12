'use client';

/**
 * "To buy" — the hub's buy list (plan §3.10, criterion B3). It ONLY PROPOSES: nothing writes until
 * a person presses a group's "Create draft PO" / "Add to draft PO-…", and that is one PO write.
 *
 * The shop-wide half of J4 and the whole of J10. A job card compares ONE job to the whole shop's
 * stock, so two jobs each needing 10 against 15 on hand both read "not short" there; only a roll-up
 * shows the conflict — this one, with on order and on draft netted and reorder points topped up.
 * The rule is `lib/purchasing/buyList.ts`, pinned by `__tests__/fixtures/buyListCases.json`; the
 * reads are `utils/buyListAccess.ts` (a fixed number, none per row).
 *
 * WHAT IT KEEPS FROM 87df208's shortages page, and why: on hand counted once, materials it cannot
 * compare kept in their own section (never "fine"), the top-level-only caveat on screen, and a
 * failed load that says so. WHAT IT DROPS: the date window — its "this week" default usually
 * reported nothing — so rows are sorted by need date instead, every open job counted.
 *
 * STATE THAT SURVIVES A REFRESH (interaction-standards Invariant 1). The list is rebuilt from a
 * loaded snapshot; what a person typed is not part of it. Edited quantities and ticks are kept by
 * row key (part + vendor), "Buy from" choices by part, and a refresh — after an order, or Retry —
 * re-derives the rows without re-seeding any of them. "Buy from" re-groups WITHOUT a read: the
 * snapshot already holds every vendor's price inputs.
 *
 * `?job=` narrows the list to one job's needs, with a chip that clears it. The quantities still
 * cover every open job — a part is bought once for all of them — and the page says so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';

import LoadFailedState from '@/components/common/LoadFailedState';
import { useLoad } from '@/hooks/useLoad';
import { todayLocalISODate } from '@/lib/localDate';
import { vendorPoLineAmount } from '@/lib/purchasing/amount';
import { isValidQuantityValue } from '@/lib/quantityInput';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import { buildBuyListFromSnapshot, loadBuyListSnapshot, priceBuyListRowAt } from '@/utils/buyListAccess';
import { createVendorPo, updateVendorPo } from '@/utils/vendorPoAccess';
import type { BuyListPricedGroup, BuyListPricedRow, BuyListSource, BuyListVendorChoice } from '@/types/buyList';
import type { VendorPoNewLineInput } from '@/types/vendorPo';
import BuyListVendorGroup, { ANOTHER_VENDOR, type BuyListRowView } from './BuyListVendorGroup';
import BuyListVendorPicker from './BuyListVendorPicker';
import { vendorPoCreatedShape } from './vendorPoCreatedShape';

/** What a capped read was reading, in the shop's words. */
const SOURCE_WORDS: Record<BuyListSource, string> = {
  job_parts: 'open job parts',
  parts: 'bought parts',
  issued: 'stock issued to jobs',
  on_order: 'parts on order',
  drafts: 'draft POs',
  last_purchases: 'past PO prices',
};

/** What the last order did, said once at the top: the group itself may drop off the list. */
type OrderNotice = { kind: 'created' | 'added'; poId: string; poNumber: string; vendorName: string; lineCount: number };

const groupKey = (group: Pick<BuyListPricedGroup, 'vendorId'>) => group.vendorId ?? 'none';

/**
 * A row as a new PO line. The description and the vendor part number are left to the RPC, which
 * fills them from the part and this vendor's list row. A job is linked only when exactly one job
 * needs the part (and its bought job part, when that is the whole need) — the rule is the lib's.
 */
function poLineFor(view: BuyListRowView): VendorPoNewLineInput {
  const { row } = view;
  return {
    lineKind: 'part',
    partId: row.partId,
    quantity: view.quantity ?? row.suggestedQuantity,
    unit: row.purchaseUnit,
    unitPrice: view.price.unitPrice,
    priceSource: view.price.priceSource,
    ...(row.jobLink ? { jobId: row.jobLink.jobId } : {}),
    ...(row.jobLink?.jobPartId ? { jobPartId: row.jobLink.jobPartId } : {}),
  };
}

export function BuyList({ companyId }: { companyId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const jobFilter = searchParams.get('job');

  // The caller's local date, fixed for the visit: sheet validity and the PO's order date.
  const [today] = useState(todayLocalISODate);
  const { data: snapshot, loading, error, reload, refresh } = useLoad(
    () => loadBuyListSnapshot(companyId),
    [companyId],
  );

  const [choices, setChoices] = useState<Record<string, BuyListVendorChoice>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<{ partId: string; partName: string } | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [groupErrors, setGroupErrors] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState<OrderNotice | null>(null);

  const result = useMemo(
    () => (snapshot ? buildBuyListFromSnapshot(snapshot, { today, chosenVendors: choices }) : null),
    [snapshot, today, choices],
  );

  /**
   * `buy list loaded` — the shape of what this visit was shown, ONCE: the first snapshot that lands
   * (a Retry that succeeds counts), never the refresh after this page's own write. It measures what
   * 87df208 never could: how often the list has anything on it. Counts over the default grouping
   * (no "Buy from" picks), and never a part, a vendor or a quantity.
   */
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!snapshot || reportedRef.current) return;
    reportedRef.current = true;
    const shape = buildBuyListFromSnapshot(snapshot, { today });
    posthog.capture('buy list loaded', {
      row_count: shape.rowCount,
      job_row_count: shape.jobRowCount,
      reorder_row_count: shape.reorderRowCount,
      no_vendor_row_count: shape.noVendorRowCount,
      incomparable_count: shape.incomparableCount,
      truncated: shape.truncated,
    });
  }, [snapshot, today]);

  const viewFor = (row: BuyListPricedRow): BuyListRowView => {
    const edited = quantities[row.key];
    const quantityText = edited ?? String(row.suggestedQuantity);
    const parsed = quantityText.trim() === '' ? null : Number(quantityText);
    const quantity = parsed !== null && isValidQuantityValue(parsed) ? parsed : null;
    // A TYPED quantity is re-priced (a price break can move with it) by the list's own rule, from
    // the snapshot's inputs: no request.
    const price =
      !snapshot || quantity === null || quantity === row.suggestedQuantity
        ? row.price
        : priceBuyListRowAt(snapshot, row, row.vendor, quantity, today);
    return {
      row,
      quantityText,
      quantity,
      price,
      amount: quantity === null ? null : vendorPoLineAmount(quantity, price.unitPrice),
      ticked: ticks[row.key] ?? true,
    };
  };

  const jobNumber = jobFilter
    ? (snapshot?.demand.find((d) => d.jobId === jobFilter)?.jobNumber ?? 'this job')
    : null;
  const visibleGroups = (result?.groups ?? [])
    .map((group) => ({
      group,
      views: group.rows.filter((r) => !jobFilter || r.jobs.some((j) => j.jobId === jobFilter)).map(viewFor),
    }))
    .filter((g) => g.views.length > 0);
  const incomparable = (result?.incomparable ?? []).filter(
    (b) => !jobFilter || b.jobs.some((j) => j.jobId === jobFilter),
  );

  const clearJobFilter = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('job');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const handleBuyFrom = (row: BuyListPricedRow, value: string) => {
    if (value === ANOTHER_VENDOR) {
      setPicker({ partId: row.partId, partName: row.partName });
      return;
    }
    const option = row.vendorPrices.find((v) => v.vendorId === value);
    const name = option?.vendorName ?? (row.vendor?.vendorId === value ? row.vendor.vendorName : null);
    if (!name) return;
    setChoices((prev) => ({ ...prev, [row.partId]: { vendorId: value, vendorName: name } }));
  };

  const orderGroup = async (group: BuyListPricedGroup, views: BuyListRowView[]) => {
    const key = groupKey(group);
    const chosen = views.filter((v) => v.ticked);
    if (!group.vendorId || chosen.length === 0 || chosen.some((v) => v.quantity === null)) return;
    const lines = chosen.map(poLineFor);
    const vendorName = group.vendorName ?? '';

    setBusyGroup(key);
    setGroupErrors((prev) => ({ ...prev, [key]: null }));
    setNotice(null);
    try {
      if (group.draft) {
        // A draft already exists for this vendor: add to it rather than leave two drafts to merge.
        const saved = await updateVendorPo(group.draft.vendorPurchaseOrderId, { today, lines });
        posthog.capture('vendor po updated', {
          surface: 'buy_list',
          revision_bumped: saved.revisionBumped,
          added_line_count: lines.length,
          removed_line_count: 0,
          changed_line_count: 0,
          header_changed: false,
        });
        setNotice({ kind: 'added', poId: saved.id, poNumber: saved.poNumber, vendorName, lineCount: lines.length });
      } else {
        const created = await createVendorPo({ vendorId: group.vendorId, orderedOn: today, today, lines });
        const shape = vendorPoCreatedShape(lines);
        posthog.capture('vendor po created', {
          surface: 'buy_list',
          part_line_count: shape.partLineCount,
          outside_line_count: shape.outsideLineCount,
          other_line_count: shape.otherLineCount,
          job_linked_line_count: shape.jobLinkedLineCount,
          price_sheet_line_count: shape.priceSheetLineCount,
          last_po_price_line_count: shape.lastPoPriceLineCount,
          estimate_price_line_count: shape.estimatePriceLineCount,
          vendor_service_price_line_count: shape.vendorServicePriceLineCount,
          rfq_price_line_count: shape.rfqPriceLineCount,
          typed_price_line_count: shape.typedPriceLineCount,
          unpriced_line_count: shape.unpricedLineCount,
        });
        setNotice({ kind: 'created', poId: created.id, poNumber: created.poNumber, vendorName, lineCount: lines.length });
      }
      // In place, no spinner: the rows now on the draft drop off, typed quantities stay.
      await refresh();
    } catch (err) {
      setGroupErrors((prev) => ({ ...prev, [key]: err }));
    } finally {
      setBusyGroup(null);
    }
  };

  if (loading && !snapshot) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !snapshot) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <LoadFailedState error={error} entity="the buy list" onRetry={() => void reload()} />
      </Box>
    );
  }

  const pickerPart = picker ? snapshot?.parts.find((p) => p.partId === picker.partId) : undefined;

  return (
    <Box>
      {jobFilter && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
          <Chip label={`For ${jobNumber}`} onDelete={clearJobFilter} color="primary" variant="outlined" />
          <Typography variant="body2" color="text.secondary">
            Showing what {jobNumber} needs. Quantities cover every open job.
          </Typography>
        </Box>
      )}

      {notice && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setNotice(null)}
          action={
            <Button component={NextLink} href={vendorPoPath(companyId, notice.poId)} color="inherit" size="small">
              Open {notice.poNumber}
            </Button>
          }
        >
          {notice.kind === 'created'
            ? `Draft ${notice.poNumber} created for ${notice.vendorName}.`
            : `Added ${notice.lineCount} ${notice.lineCount === 1 ? 'line' : 'lines'} to draft ${notice.poNumber} (${notice.vendorName}).`}
        </Alert>
      )}

      {Boolean(error) && (
        // A refresh that failed keeps the list it had; it says so rather than looking current.
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void reload()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t refresh the list — what you see may be out of date.
        </Alert>
      )}

      {result?.truncated && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          This list may be incomplete: there are more{' '}
          {result.truncatedSources.map((s) => SOURCE_WORDS[s]).join(', ')} than one read holds, so some
          needs may be missing.
        </Alert>
      )}

      {visibleGroups.length === 0 ? (
        <Card>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CheckCircleOutlineIcon color="success" />
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {jobFilter ? `Nothing to buy for ${jobNumber}.` : 'Nothing to buy.'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Open jobs&apos; materials are covered by stock or orders, and nothing is at its reorder
                point.
              </Typography>
            </Box>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={2}>
          {visibleGroups.map(({ group, views }) => {
            const key = groupKey(group);
            return (
              <BuyListVendorGroup
                key={key}
                companyId={companyId}
                group={group}
                rows={views}
                busy={busyGroup === key}
                disabled={busyGroup !== null && busyGroup !== key}
                error={groupErrors[key] ?? null}
                onQuantityChange={(rowKey, text) => setQuantities((prev) => ({ ...prev, [rowKey]: text }))}
                onTickChange={(rowKey, ticked) => setTicks((prev) => ({ ...prev, [rowKey]: ticked }))}
                onBuyFrom={handleBuyFrom}
                onOrder={() => void orderGroup(group, views)}
              />
            );
          })}
        </Stack>
      )}

      {/* Below the list and never folded into it: "we can't tell" is not "you have enough". */}
      {incomparable.length > 0 && (
        <Box component="section" aria-label={`Can't compare units (${incomparable.length})`} sx={{ mt: 4 }}>
          <Typography variant="overline" color="text.secondary">
            Can&apos;t compare units ({incomparable.length})
          </Typography>
          <Card sx={{ mt: 0.5 }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                These are measured differently on the BOM than in stock, so we can&apos;t say whether you
                have enough. Add a unit conversion on the part to fix it.
              </Typography>
              {incomparable.map((b, i) => (
                <Box key={b.partId}>
                  {i > 0 && <Divider sx={{ my: 1 }} />}
                  <MuiLink
                    component={NextLink}
                    href={`/dashboard/${companyId}/parts/${b.partId}`}
                    underline="hover"
                    sx={{ fontWeight: 500, color: 'text.primary' }}
                  >
                    {b.partName}
                  </MuiLink>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {b.incomparableJobCount} {b.incomparableJobCount === 1 ? 'job' : 'jobs'} affected
                  </Typography>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Box>
      )}

      <Box sx={{ mt: 3 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Top-level materials only — sub-assemblies are not exploded.
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Only POs in Jigged count as on order — one still open only in QuickBooks isn&apos;t seen here.
        </Typography>
      </Box>

      {picker && (
        <BuyListVendorPicker
          companyId={companyId}
          partName={picker.partName}
          doNotUseVendorIds={(pickerPart?.vendors ?? []).filter((v) => v.status === 'disapproved').map((v) => v.vendorId)}
          onClose={() => setPicker(null)}
          onPick={(choice) => {
            setChoices((prev) => ({ ...prev, [picker.partId]: choice }));
            setPicker(null);
          }}
        />
      )}
    </Box>
  );
}

export default BuyList;
