'use client';

/**
 * A bought part's approved vendor list (AVL) with each vendor's price sheet (plan §3.8; criteria
 * V1, V2, L4).
 *
 * Each row: the status in words (Approved / Conditional / Do not use), the preferred star, the
 * vendor's part number, the unit it is bought in with its factor ("1 bar = 144 in"), lead time,
 * minimum order, quoted and good-until dates with an Expired chip, the price breaks, and the Last
 * PO price — the newest price on a PO actually sent to that vendor, never a bill.
 *
 * THE STAR IS `parts.preferred_vendor_id`, not a flag of its own: starring a vendor goes through
 * `save_part_vendor` (`makePreferred`), which the database refuses for a "Do not use" vendor in its
 * own words; the filled star clears the preference through the same writer the Workspace picker
 * uses. The star is a change to the part, so the workspace refreshes the part afterwards.
 *
 * Rows edit inline (PriceSheetRowEditor, Save/Cancel). Removing a vendor ARCHIVES its row and asks
 * first — the row comes back, price sheet and all, when the vendor is added again, which is why the
 * dialog says so. A "Do not use" vendor offers no "New PO": the PO form would refuse it.
 */
import { useCallback, useState } from 'react';
import NextLink from 'next/link';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MuiLink from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';

import DeleteIconButton from '@/components/common/DeleteIconButton';
import ErrorAlert from '@/components/common/ErrorAlert';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import StatusChip from '@/components/common/StatusChip';
import { formatUnitPrice } from '@/lib/money';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { PART_VENDOR_STATUS_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import { vendorPoPath } from '@/lib/purchasingRoutes';
import { updatePartPreferredVendor } from '@/utils/partsAccess';
import { archivePartVendor, savePartVendor } from '@/utils/partVendorsAccess';
import type { PartVendorList, PartVendorRow } from '@/types/partVendor';

import PriceSheetRowEditor, { type PriceSheetSubmit } from './PriceSheetRowEditor';
import UseAsPartCostDialog from './UseAsPartCostDialog';

export interface ApprovedVendorsCardProps {
  companyId: string;
  partId: string;
  partName: string;
  list: PartVendorList;
  /** The reader's local date (the preview and the expiry rule use it). */
  today: string;
  /** After a write. `partChanged`: the part's own record moved (its preferred vendor). */
  onChanged: (opts: { partChanged: boolean }) => void;
  /** "Use as part cost" was applied: the part's cost changed. */
  onCostApplied: () => void;
  /** An open editor holding changes, for the workspace's exit guard. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** `/purchasing/orders/new?vendor=…&part=…` — the PO form's id-only prefill. */
export function newVendorPoHref(companyId: string, partId: string, vendorId: string | null): string {
  const query = new URLSearchParams();
  if (vendorId) query.set('vendor', vendorId);
  query.set('part', partId);
  return `${vendorPoPath(companyId, 'new')}?${query.toString()}`;
}

function sheetFacts(row: PartVendorRow): string[] {
  const facts: string[] = [];
  if (row.vendorPartNumber) facts.push(`Their part # ${row.vendorPartNumber}`);
  let unit = `Bought in ${row.purchaseUnit}`;
  if (row.factorLabel) unit += ` (${row.factorLabel})`;
  else if (row.purchaseFactor === null) unit += " (this unit no longer converts to the part's stock unit)";
  facts.push(unit);
  if (row.leadTimeDays !== null) facts.push(`Lead time ${row.leadTimeDays} ${row.leadTimeDays === 1 ? 'day' : 'days'}`);
  if (row.minimumOrderQuantity !== null) {
    facts.push(`Minimum order ${formatUnitQuantity(row.minimumOrderQuantity)} ${unitLabel(row.purchaseUnit)}`);
  }
  if (row.quotedOn) facts.push(`Quoted ${formatShortDate(row.quotedOn)}`);
  if (row.validUntil) facts.push(`Good until ${formatShortDate(row.validUntil)}`);
  return facts;
}

export default function ApprovedVendorsCard({
  companyId,
  partId,
  partName,
  list,
  today,
  onChanged,
  onCostApplied,
  onDirtyChange,
}: ApprovedVendorsCardProps) {
  // null: closed; 'add': the new-vendor editor; otherwise the id of the row being edited.
  const [editor, setEditor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<unknown>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<PartVendorRow | null>(null);
  const [costFor, setCostFor] = useState<PartVendorRow | null>(null);

  const reportDirty = useCallback((dirty: boolean) => onDirtyChange?.(dirty), [onDirtyChange]);
  const stockUnit = list.part.stockUnit;
  const listed = list.rows.map((r) => ({ vendorId: r.vendorId, vendorName: r.vendorName }));

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
  };

  const handleSave = async (submit: PriceSheetSubmit) => {
    const row = list.rows.find((r) => r.vendorId === submit.vendorId);
    const { vendorName, ...input } = submit;
    setSaving(true);
    setEditorError(null);
    setSaveState('saving');
    setNotice(null);
    try {
      const result = await savePartVendor({ partId, ...input });
      const c = input.changes;
      posthog.capture('part vendor saved', {
        is_new: result.created || result.revived,
        status: c.status ?? row?.status ?? 'approved',
        break_count: input.priceBreaks ? input.priceBreaks.length : (row?.breaks.length ?? 0),
        has_vendor_part_number: c.vendorPartNumber !== undefined ? Boolean(c.vendorPartNumber) : Boolean(row?.vendorPartNumber),
        has_lead_time: c.leadTimeDays !== undefined ? c.leadTimeDays !== null : Boolean(row && row.leadTimeDays !== null),
        has_valid_until: c.validUntil !== undefined ? Boolean(c.validUntil) : Boolean(row?.validUntil),
      });
      if (result.revived) {
        setNotice(
          `${vendorName} was on this list before, so its row came back${input.priceBreaks ? '' : ', with its earlier price sheet'}. Check its details below.`,
        );
      }
      setSaveState('saved');
      closeEditor();
      onChanged({ partChanged: false });
    } catch (err) {
      setEditorError(err);
      setSaveState('error');
    } finally {
      setSaving(false);
    }
  };

  const handleStar = async (row: PartVendorRow) => {
    setBusy(true);
    setActionError(null);
    setSaveState('saving');
    try {
      if (row.isPreferred) await updatePartPreferredVendor(partId, null);
      else await savePartVendor({ partId, vendorId: row.vendorId, makePreferred: true });
      setSaveState('saved');
      onChanged({ partChanged: true });
    } catch (err) {
      setActionError(err);
      setSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    if (!pendingArchive) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await archivePartVendor(pendingArchive.id);
      posthog.capture('part vendor archived');
      setPendingArchive(null);
      onChanged({ partChanged: result.clearedPreferred });
    } catch (err) {
      setActionError(err);
      setPendingArchive(null);
    } finally {
      setBusy(false);
    }
  };

  const editorOpen = editor !== null;

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Approved vendors
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <SaveStatus state={saveState} />
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => {
                setNotice(null);
                setEditor('add');
              }}
              disabled={editorOpen || saving || busy}
            >
              Add vendor
            </Button>
          </Box>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
          Who you buy {partName} from, and at what price. The star is the preferred vendor. A vendor marked Do not use
          can&apos;t go on a purchase order.
        </Typography>

        {list.preferredVendorMissing && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This part&apos;s preferred vendor is archived, so it isn&apos;t listed here. Star another vendor to replace
            it.
          </Alert>
        )}
        {notice && (
          <Alert severity="info" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        <ErrorAlert error={actionError} entity="vendor" onClose={() => setActionError(null)} sx={{ mb: 2 }} />

        {list.rows.length === 0 && editor !== 'add' && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            No vendors on this part&apos;s list yet. Add the vendors you buy it from, with their prices.
          </Typography>
        )}

        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {list.rows.map((row) => {
            if (editor === row.id) {
              return (
                <Box component="li" key={row.id}>
                  <PriceSheetRowEditor
                    companyId={companyId}
                    row={row}
                    stockUnit={stockUnit}
                    conversions={list.part.conversions}
                    listedVendors={listed}
                    saving={saving}
                    error={editorError}
                    onSave={handleSave}
                    onCancel={closeEditor}
                    onDirtyChange={reportDirty}
                  />
                </Box>
              );
            }
            const status = PART_VENDOR_STATUS_CONFIG[row.status];
            const breaks = row.breaks.map(
              (b) => `${formatUnitQuantity(b.minQuantity)}+ ${unitLabel(row.purchaseUnit)} ${formatUnitPrice(b.unitPrice)}`,
            );
            return (
              <Box
                component="li"
                key={row.id}
                aria-label={row.vendorName}
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1,
                  p: 1,
                  mb: 1,
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              >
                <Tooltip title={row.isPreferred ? 'Preferred vendor — press to clear' : 'Make this the preferred vendor'}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={() => handleStar(row)}
                      disabled={busy || editorOpen}
                      aria-label={
                        row.isPreferred
                          ? `${row.vendorName} is the preferred vendor. Clear the preference`
                          : `Make ${row.vendorName} the preferred vendor`
                      }
                      sx={{ color: row.isPreferred ? 'primary.light' : 'text.secondary' }}
                    >
                      {row.isPreferred ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                    </IconButton>
                  </span>
                </Tooltip>

                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <MuiLink
                      component={NextLink}
                      href={`/dashboard/${companyId}/vendors/${row.vendorId}`}
                      underline="hover"
                      color="inherit"
                      sx={{ fontWeight: 600 }}
                    >
                      {row.vendorName}
                    </MuiLink>
                    <StatusChip label={status.label} color={status.color} />
                    {row.isPreferred && (
                      <Typography variant="caption" color="text.secondary">
                        Preferred
                      </Typography>
                    )}
                    {row.isExpired && <StatusChip label="Expired" color="warning" />}
                    {row.statusNote && (
                      <Typography variant="caption" color="text.secondary">
                        {row.statusNote}
                      </Typography>
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
                    {sheetFacts(row).join(' · ')}
                  </Typography>
                  <Typography variant="body2" component="div" sx={{ mt: 0.5 }}>
                    {breaks.length > 0 ? `Prices: ${breaks.join(' · ')}` : 'No prices yet'}
                  </Typography>
                  {row.lastPurchase && (
                    <Typography variant="caption" color="text.secondary" component="div">
                      Last PO price {formatUnitPrice(row.lastPurchase.unitPrice)} / {unitLabel(row.lastPurchase.unit)} on{' '}
                      <MuiLink
                        component={NextLink}
                        href={vendorPoPath(companyId, row.lastPurchase.vendorPurchaseOrderId)}
                        underline="hover"
                      >
                        {row.lastPurchase.poNumber}
                      </MuiLink>
                      {row.lastPurchase.orderedOn ? ` (${formatShortDate(row.lastPurchase.orderedOn)})` : ''}
                    </Typography>
                  )}
                  {row.notes && (
                    <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: 'pre-wrap' }}>
                      {row.notes}
                    </Typography>
                  )}
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {row.status !== 'disapproved' && (
                    <Button
                      variant="outlined"
                      size="small"
                      component={NextLink}
                      href={newVendorPoHref(companyId, partId, row.vendorId)}
                    >
                      New PO
                    </Button>
                  )}
                  <Button variant="outlined" size="small" onClick={() => setCostFor(row)} disabled={busy || editorOpen}>
                    Use as part cost
                  </Button>
                  <Tooltip title={`Edit ${row.vendorName}`}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Edit ${row.vendorName}`}
                        onClick={() => {
                          setNotice(null);
                          setEditor(row.id);
                        }}
                        disabled={busy || editorOpen}
                      >
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <DeleteIconButton
                    ariaLabel={`Remove ${row.vendorName} from this part's vendors`}
                    onClick={() => setPendingArchive(row)}
                    disabled={busy || editorOpen}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>

        {editor === 'add' && (
          <PriceSheetRowEditor
            companyId={companyId}
            stockUnit={stockUnit}
            conversions={list.part.conversions}
            listedVendors={listed}
            saving={saving}
            error={editorError}
            onSave={handleSave}
            onCancel={closeEditor}
            onDirtyChange={reportDirty}
          />
        )}
      </CardContent>

      <Dialog open={pendingArchive !== null} onClose={() => !busy && setPendingArchive(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Remove {pendingArchive?.vendorName} from {partName}&apos;s vendors?
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: pendingArchive?.isPreferred ? 1.5 : 0 }}>
            It comes off this part&apos;s vendor list. Its price sheet is kept: adding {pendingArchive?.vendorName} again
            brings it back.
          </Typography>
          {pendingArchive?.isPreferred && (
            <Typography variant="body2">
              {pendingArchive.vendorName} is the preferred vendor, so the part will have no preferred vendor.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingArchive(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleArchive} disabled={busy}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      {costFor && (
        <UseAsPartCostDialog
          key={costFor.id}
          open
          partVendorId={costFor.id}
          partId={partId}
          partName={partName}
          vendorName={costFor.vendorName}
          today={today}
          onClose={() => setCostFor(null)}
          onApplied={onCostApplied}
        />
      )}
    </Card>
  );
}
