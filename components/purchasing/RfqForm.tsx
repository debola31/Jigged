'use client';

/**
 * Create or edit a request for quotation (plan §3.9 "Form"; criterion Q1).
 *
 * Lines are a part, or ad-hoc text for anything else ("Other item"), each with up to four
 * quantities in ONE unit — the unit every vendor's price on that line is per. Vendors are
 * suggested from the parts' approved-vendor lists first (a "Do not use" vendor never is), and any
 * vendor can be added.
 *
 * Prefill takes ids only (`?part=`, `?vendor=`), resolved here, so a stale or tampered id fails to
 * load rather than seeding a line from URL contents (the rule at quotes/new).
 *
 * A part line's unit is the stock unit, one of the part's conversions, a same-kind preset, or
 * "Another unit…" with its factor — an award turns the line into a PO line, which needs one factor
 * for the unit, and `vendorRfqAccess` stores a preset or a new unit as the part's conversion first.
 * Editing sends only what changed, with the `updated_at` it read; a line with quotes keeps its part
 * and unit, which the database refuses to change.
 */
import { memo, useCallback, useMemo, useState } from 'react';
import posthog from 'posthog-js';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import DeleteIconButton from '@/components/common/DeleteIconButton';
import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { useLoad } from '@/hooks/useLoad';
import { todayLocalISODate } from '@/lib/localDate';
import { isValidQuantityInput } from '@/lib/quantityInput';
import {
  defaultPurchaseUnit,
  factorLabel,
  purchaseUnitOptions,
  unitLabel,
  type UnitConversionRow,
} from '@/lib/purchasing/purchaseUnits';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import { listPartVendors } from '@/utils/partVendorsAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import { createVendorRfq, saveVendorRfq } from '@/utils/vendorRfqAccess';
import type { PartVendorRow } from '@/types/partVendor';
import type { Vendor } from '@/types/vendor';
import {
  VENDOR_RFQ_MAX_QUANTITIES,
  type VendorRfqChanges,
  type VendorRfqDetail,
  type VendorRfqLineInput,
  type VendorRfqLinePatch,
  type VendorRfqLineWrite,
} from '@/types/vendorRfq';

export interface RfqFormProps {
  companyId: string;
  /** Edit this RFQ. Leave out for a new one. */
  rfq?: VendorRfqDetail;
  /** New RFQ prefill, ids only (`?part=`). */
  initialPartIds?: readonly string[];
  /** New RFQ prefill, ids only (`?vendor=`). */
  initialVendorIds?: readonly string[];
  /** Started from the buy list's "Ask for prices" — telemetry only. */
  fromBuyList?: boolean;
  onSaved: (rfqId: string) => void;
  onCancel: () => void;
}

/** What a part line needs to offer units and suggest vendors. */
interface PartInfo {
  stockUnit: string | null;
  conversions: UnitConversionRow[];
  rows: PartVendorRow[];
}

const ANOTHER_UNIT = '__another_unit__';

interface FormLine {
  key: string;
  /** The existing line's id when editing. */
  id: string | null;
  kind: 'part' | 'other';
  part: PartSelectOption | null;
  description: string;
  /** A part line: a unit spelling, or ANOTHER_UNIT. An other line: free text. */
  unit: string;
  customUnit: string;
  customFactor: string;
  quantities: string[];
  certRequired: boolean;
  notes: string;
  /** Has quotes: the part and unit are fixed, and it can't be removed. */
  quoted: boolean;
}

interface Header {
  title: string;
  respondByOn: string;
  neededByOn: string;
  notesToVendors: string;
  internalNotes: string;
}

interface Loaded {
  vendors: Vendor[];
  lines: FormLine[];
  infos: Record<string, PartInfo | null>;
  vendorIds: string[];
}

let keySeq = 0;
const newKey = () => `line-${++keySeq}`;

const trimOrNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

function toInfo(list: Awaited<ReturnType<typeof listPartVendors>>): PartInfo | null {
  if (!list) return null;
  return { stockUnit: list.part.stockUnit, conversions: list.part.conversions, rows: list.rows };
}

/** The unit a new part line asks in: the preferred vendor's sheet unit, else the stock unit. */
function defaultUnitFor(info: PartInfo | null, part: PartSelectOption | null): string {
  if (!info) return part?.primary_unit ?? '';
  const preferred = info.rows.find((r) => r.isPreferred && r.status !== 'disapproved');
  return (
    defaultPurchaseUnit({
      sheetUnit: preferred?.purchaseUnit ?? null,
      lastOrderedUnit: null,
      stockUnit: info.stockUnit,
      conversions: info.conversions,
    }) ?? ''
  );
}

function blankLine(kind: 'part' | 'other'): FormLine {
  return {
    key: newKey(),
    id: null,
    kind,
    part: null,
    description: '',
    unit: kind === 'other' ? 'each' : '',
    customUnit: '',
    customFactor: '',
    quantities: [''],
    certRequired: false,
    notes: '',
    quoted: false,
  };
}

/** Parsed quantities (blanks dropped), or null when one is not a positive number. */
function parseQuantities(values: readonly string[]): number[] | null {
  const out: number[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t === '') continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;
    out.push(n);
  }
  return out;
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

async function loadForm(
  companyId: string,
  today: string,
  rfq: VendorRfqDetail | undefined,
  partIds: readonly string[],
  vendorIds: readonly string[],
): Promise<Loaded> {
  const vendorsPromise = getAllVendors(companyId);
  let lines: FormLine[];
  let ids: string[];
  if (rfq) {
    ids = [...new Set(rfq.lines.map((l) => l.partId).filter((id): id is string => Boolean(id)))];
    lines = [...rfq.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        key: newKey(),
        id: l.id,
        kind: l.partId ? 'part' : 'other',
        part: l.partId
          ? {
              id: l.partId,
              part_name: l.partName ?? l.description,
              description: l.description,
              has_routing: false,
              source: 'bought',
              primary_unit: null,
              quantity: 0,
            }
          : null,
        description: l.partId ? '' : l.description,
        unit: l.unit,
        customUnit: '',
        customFactor: '',
        quantities: l.quantities.map(String),
        certRequired: l.certRequired,
        notes: l.notes ?? '',
        quoted: rfq.responses.some((r) => r.lineId === l.id),
      }));
  } else {
    ids = [...new Set(partIds.filter(Boolean))];
    const parts = ids.length > 0 ? await getPartsForSelectByIds(ids) : [];
    lines = parts.map((p) => ({ ...blankLine('part'), part: p, unit: p.primary_unit ?? '' }));
  }

  const infoList = await Promise.all(
    ids.map((id) =>
      listPartVendors(id, { today })
        .then(toInfo)
        .catch(() => null),
    ),
  );
  const infos: Record<string, PartInfo | null> = Object.fromEntries(ids.map((id, i) => [id, infoList[i]]));
  if (!rfq) {
    lines = lines.map((l) => (l.part ? { ...l, unit: defaultUnitFor(infos[l.part.id] ?? null, l.part) } : l));
  }
  if (lines.length === 0) lines = [blankLine('part')];

  const vendors = await vendorsPromise;
  const known = new Set(vendors.map((v) => v.id));
  const chosen = rfq
    ? rfq.invitations.map((i) => i.vendorId)
    : [...new Set(vendorIds.filter((id) => known.has(id)))];
  return { vendors, lines, infos, vendorIds: chosen };
}

export default function RfqForm(props: RfqFormProps) {
  const { companyId, rfq, initialPartIds, initialVendorIds } = props;
  const [today] = useState(() => todayLocalISODate());
  const partKey = (initialPartIds ?? []).join(',');
  const vendorKey = (initialVendorIds ?? []).join(',');
  const rfqKey = rfq ? `${rfq.header.id}:${rfq.header.updatedAt}` : '';

  const { data, loading, error, reload } = useLoad(
    () => loadForm(companyId, today, rfq, partKey ? partKey.split(',') : [], vendorKey ? vendorKey.split(',') : []),
    // Primitive deps only (useLoad's rule); `rfq` is captured through rfqKey.
    [companyId, today, rfqKey, partKey, vendorKey],
  );

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <LoadFailedState error={error} entity="the RFQ form" onRetry={() => void reload()} />
        </CardContent>
      </Card>
    );
  }
  return <RfqFormBody {...props} today={today} loaded={data} />;
}

function RfqFormBody({
  companyId,
  rfq,
  fromBuyList,
  onSaved,
  onCancel,
  today,
  loaded,
}: RfqFormProps & { today: string; loaded: Loaded }) {
  const editing = Boolean(rfq);
  const initialHeader: Header = useMemo(
    () => ({
      title: rfq?.header.title ?? '',
      respondByOn: rfq?.header.respondByOn ?? '',
      neededByOn: rfq?.header.neededByOn ?? '',
      notesToVendors: rfq?.header.notesToVendors ?? '',
      internalNotes: rfq?.header.internalNotes ?? '',
    }),
    [rfq],
  );
  const [header, setHeader] = useState<Header>(initialHeader);
  const [lines, setLines] = useState<FormLine[]>(loaded.lines);
  const [infos, setInfos] = useState<Record<string, PartInfo | null | 'loading'>>(loaded.infos);
  const [vendorIds, setVendorIds] = useState<string[]>(loaded.vendorIds);
  const [vendorPick, setVendorPick] = useState<Vendor | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const vendorsById = useMemo(() => new Map(loaded.vendors.map((v) => [v.id, v])), [loaded.vendors]);
  /** Vendors whose invitation already has quotes: they can't be taken off. */
  const lockedVendorIds = useMemo(() => {
    const out = new Set<string>();
    for (const inv of rfq?.invitations ?? []) {
      if (rfq?.responses.some((r) => r.invitationId === inv.id)) out.add(inv.vendorId);
    }
    return out;
  }, [rfq]);
  const nameOf = (vendorId: string) =>
    vendorsById.get(vendorId)?.name ?? rfq?.invitations.find((i) => i.vendorId === vendorId)?.vendorName ?? 'Vendor';

  // Stable per-line handlers (keyed by the line), so typing in one line re-renders that line only.
  const changeLine = useCallback(
    (key: string, change: Partial<FormLine>) =>
      setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...change } : l))),
    [],
  );
  const removeLine = useCallback((key: string) => setLines((prev) => prev.filter((x) => x.key !== key)), []);

  const loadPartInfo = useCallback(
    async (lineKey: string, part: PartSelectOption) => {
      setInfos((prev) => (part.id in prev ? prev : { ...prev, [part.id]: 'loading' }));
      let info: PartInfo | null = null;
      try {
        info = toInfo(await listPartVendors(part.id, { today }));
      } catch {
        info = null;
      }
      setInfos((prev) => ({ ...prev, [part.id]: info }));
      setLines((prev) =>
        prev.map((l) => (l.key === lineKey && l.part?.id === part.id ? { ...l, unit: defaultUnitFor(info, part) } : l)),
      );
    },
    [today],
  );
  const pickPart = useCallback(
    (key: string, part: PartSelectOption | null) => {
      changeLine(key, { part, unit: '', customUnit: '', customFactor: '' });
      if (part) void loadPartInfo(key, part);
    },
    [changeLine, loadPartInfo],
  );

  // ---------- Suggested vendors: each part line's approved list, Do not use never ----------
  const partLines = useMemo(() => lines.filter((l) => l.kind === 'part' && l.part), [lines]);
  const suggestions = useMemo(() => {
    const counts = new Map<string, { vendorId: string; vendorName: string; approved: number; conditional: number }>();
    for (const l of partLines) {
      const info = l.part ? infos[l.part.id] : null;
      if (!info || info === 'loading') continue;
      for (const row of info.rows) {
        if (row.status === 'disapproved') continue;
        const entry = counts.get(row.vendorId) ?? { vendorId: row.vendorId, vendorName: row.vendorName, approved: 0, conditional: 0 };
        if (row.status === 'approved') entry.approved += 1;
        else entry.conditional += 1;
        counts.set(row.vendorId, entry);
      }
    }
    return [...counts.values()]
      .filter((s) => vendorsById.has(s.vendorId))
      .sort(
        (a, b) =>
          b.approved + b.conditional - (a.approved + a.conditional) ||
          a.vendorName.localeCompare(b.vendorName, undefined, { sensitivity: 'base' }),
      );
  }, [partLines, infos, vendorsById]);
  const suggestedIds = new Set(suggestions.map((s) => s.vendorId));
  const suggestionText = (s: (typeof suggestions)[number]) => {
    const m = partLines.length;
    const of = `of ${m} part ${m === 1 ? 'line' : 'lines'}`;
    return s.approved > 0 ? `approved for ${s.approved} ${of}` : `conditional for ${s.conditional} ${of}`;
  };
  const pickerOptions = useMemo(() => {
    const rank = new Map(suggestions.map((s, i) => [s.vendorId, i]));
    return loaded.vendors
      .filter((v) => !vendorIds.includes(v.id))
      .sort((a, b) => {
        const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
        const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }, [loaded.vendors, vendorIds, suggestions]);

  // ---------- Validation: the reasons Save is unavailable, in words ----------
  const problems = useMemo(() => {
    const out: string[] = [];
    if (lines.length === 0) out.push('Add at least one line.');
    lines.forEach((l, i) => {
      const n = i + 1;
      if (l.kind === 'part' && !l.part) out.push(`Line ${n} needs a part.`);
      if (l.kind === 'other' && l.description.trim() === '') out.push(`Line ${n} needs a description of what you need.`);
      const qs = parseQuantities(l.quantities);
      if (qs === null) out.push(`Line ${n}: quantities must be more than zero.`);
      else if (qs.length === 0) out.push(`Line ${n} needs a quantity.`);
      else if (new Set(qs).size !== qs.length) out.push(`Line ${n} asks for the same quantity twice.`);
      if (l.kind === 'part' && l.unit === ANOTHER_UNIT) {
        const factor = Number(l.customFactor);
        if (l.customUnit.trim() === '' || !Number.isFinite(factor) || factor <= 0) {
          out.push(`Line ${n}: name the new unit and say how much of the stock unit is in one.`);
        }
      }
      if (l.kind === 'part' && l.part && l.unit === '') out.push(`Line ${n} needs a unit.`);
    });
    if (vendorIds.length === 0) out.push('Choose at least one vendor to ask.');
    return out;
  }, [lines, vendorIds]);

  // ---------- Payload ----------
  const lineInput = (l: FormLine): VendorRfqLineInput => {
    const quantities = parseQuantities(l.quantities) ?? [];
    const common = { quantities, certRequired: l.certRequired, notes: trimOrNull(l.notes) };
    if (l.kind === 'other') {
      return { description: l.description.trim(), unit: l.unit.trim() || 'each', ...common };
    }
    const custom = l.unit === ANOTHER_UNIT;
    return {
      partId: l.part?.id ?? null,
      unit: custom ? l.customUnit.trim() : l.unit,
      ...(custom ? { unitFactor: Number(l.customFactor) } : {}),
      ...common,
    };
  };

  const linePatch = (l: FormLine): VendorRfqLinePatch | null => {
    const before = rfq?.lines.find((x) => x.id === l.id);
    if (!before || !l.id) return null;
    const next = lineInput(l);
    const patch: VendorRfqLinePatch = { id: l.id };
    if (l.kind === 'part' && (next.partId ?? null) !== before.partId) patch.partId = next.partId ?? null;
    if (l.kind === 'other' && (next.description ?? '') !== before.description) patch.description = next.description;
    if ((next.unit ?? '') !== before.unit || l.unit === ANOTHER_UNIT) {
      patch.unit = next.unit;
      if (next.unitFactor !== undefined) patch.unitFactor = next.unitFactor;
    }
    if (!sameNumbers(next.quantities, before.quantities)) patch.quantities = next.quantities;
    if (next.certRequired !== before.certRequired) patch.certRequired = next.certRequired;
    if ((next.notes ?? null) !== (before.notes ?? null)) patch.notes = next.notes ?? null;
    return Object.keys(patch).length > 1 ? patch : null;
  };

  const headerValues = (h: Header) => ({
    title: trimOrNull(h.title),
    respondByOn: h.respondByOn || null,
    neededByOn: h.neededByOn || null,
    notesToVendors: trimOrNull(h.notesToVendors),
    internalNotes: trimOrNull(h.internalNotes),
  });

  const handleSave = async () => {
    if (problems.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      if (!rfq) {
        const input = { header: headerValues(header), lines: lines.map(lineInput), vendorIds };
        const result = await createVendorRfq(companyId, input);
        posthog.capture('vendor rfq created', {
          line_count: input.lines.length,
          adhoc_line_count: input.lines.filter((l) => !l.partId).length,
          quantity_count: input.lines.reduce((n, l) => n + l.quantities.length, 0),
          vendor_count: vendorIds.length,
          from_buy_list: Boolean(fromBuyList),
        });
        onSaved(result.id);
        return;
      }

      const now = headerValues(header);
      const was = headerValues(initialHeader);
      const changes: VendorRfqChanges = {};
      for (const k of Object.keys(now) as (keyof typeof now)[]) {
        if (now[k] !== was[k]) changes[k] = now[k];
      }
      const writes: VendorRfqLineWrite[] = [];
      for (const l of lines) {
        if (!l.id) writes.push(lineInput(l));
        else {
          const patch = linePatch(l);
          if (patch) writes.push(patch);
        }
      }
      const kept = new Set(lines.map((l) => l.id).filter(Boolean));
      const initialVendors = new Set(rfq.invitations.map((i) => i.vendorId));
      await saveVendorRfq(rfq.header.id, {
        changes,
        lines: writes,
        removedLineIds: rfq.lines.filter((l) => !kept.has(l.id)).map((l) => l.id),
        addVendorIds: vendorIds.filter((id) => !initialVendors.has(id)),
        removedInvitationIds: rfq.invitations.filter((i) => !vendorIds.includes(i.vendorId)).map((i) => i.id),
        expectedUpdatedAt: rfq.header.updatedAt,
      });
      onSaved(rfq.header.id);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const addVendor = (vendorId: string) => setVendorIds((prev) => (prev.includes(vendorId) ? prev : [...prev, vendorId]));

  return (
    <Box>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            {editing ? `Edit ${rfq?.header.rfqNumber}` : 'New request for quote'}
          </Typography>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '2fr 1fr 1fr' } }}>
            <TextField
              label="Title (optional)"
              value={header.title}
              onChange={(e) => setHeader((h) => ({ ...h, title: e.target.value }))}
              helperText="A few words your team will recognise, like the job or the part family."
              disabled={saving}
            />
            <TextField
              label="Respond by"
              type="date"
              value={header.respondByOn}
              onChange={(e) => setHeader((h) => ({ ...h, respondByOn: e.target.value }))}
              helperText="Prints on every vendor's copy."
              slotProps={{ inputLabel: { shrink: true } }}
              disabled={saving}
            />
            <TextField
              label="Needed by"
              type="date"
              value={header.neededByOn}
              onChange={(e) => setHeader((h) => ({ ...h, neededByOn: e.target.value }))}
              helperText="When you need it in the shop. Optional."
              slotProps={{ inputLabel: { shrink: true } }}
              disabled={saving}
            />
          </Box>
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            What you want priced
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Up to {VENDOR_RFQ_MAX_QUANTITIES} quantities per line, all in the line&apos;s unit. Vendors price each line
            per that unit.
          </Typography>

          {lines.map((l, index) => (
            <RfqLineEditor
              key={l.key}
              companyId={companyId}
              line={l}
              number={index + 1}
              info={l.part ? infos[l.part.id] : undefined}
              disabled={saving}
              onChange={changeLine}
              onPart={pickPart}
              onRemove={removeLine}
            />
          ))}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setLines((prev) => [...prev, blankLine('part')])}
              disabled={saving}
            >
              Part
            </Button>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setLines((prev) => [...prev, blankLine('other')])}
              disabled={saving}
            >
              Other item
            </Button>
          </Box>
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Vendors to ask
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each vendor gets its own copy, with its own part numbers.
          </Typography>

          {suggestions.some((s) => !vendorIds.includes(s.vendorId)) && (
            <Box role="group" aria-label="Suggested vendors" sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                Suggested from the parts&apos; approved vendors
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {suggestions
                  .filter((s) => !vendorIds.includes(s.vendorId))
                  .map((s) => (
                    <Chip
                      key={s.vendorId}
                      icon={<AddIcon />}
                      variant="outlined"
                      label={`${s.vendorName} · ${suggestionText(s)}`}
                      aria-label={`Add ${s.vendorName}`}
                      onClick={() => addVendor(s.vendorId)}
                      disabled={saving}
                    />
                  ))}
              </Box>
            </Box>
          )}

          <Autocomplete<Vendor>
            openOnFocus
            options={pickerOptions}
            value={vendorPick}
            onChange={(_, v) => {
              if (v) addVendor(v.id);
              setVendorPick(null);
            }}
            groupBy={(v) => (suggestedIds.has(v.id) ? "On these parts' approved lists" : 'All vendors')}
            getOptionLabel={(v) => v.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            disabled={saving}
            renderInput={(params) => (
              <TextField {...params} label="Vendors to ask" helperText="Pick each vendor you want a price from." />
            )}
            sx={{ maxWidth: 480, mb: 2 }}
          />

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {vendorIds.map((id) => (
              <Chip
                key={id}
                label={nameOf(id)}
                onDelete={lockedVendorIds.has(id) || saving ? undefined : () => setVendorIds((prev) => prev.filter((x) => x !== id))}
              />
            ))}
          </Box>
          {lockedVendorIds.size > 0 && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
              A vendor that has quoted stays on the RFQ.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Notes
          </Typography>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
            <TextField
              label="Notes to vendors"
              value={header.notesToVendors}
              onChange={(e) => setHeader((h) => ({ ...h, notesToVendors: e.target.value }))}
              helperText="Printed on every vendor's copy."
              multiline
              minRows={3}
              disabled={saving}
            />
            <TextField
              label="Internal notes"
              value={header.internalNotes}
              onChange={(e) => setHeader((h) => ({ ...h, internalNotes: e.target.value }))}
              helperText="Only your team sees these. Never printed."
              multiline
              minRows={3}
              disabled={saving}
            />
          </Box>
        </CardContent>
      </Card>

      <ErrorAlert error={error} entity="RFQ" onClose={() => setError(null)} sx={{ mb: 2 }} />
      <MissingFieldsNotice items={problems} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || problems.length > 0}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create RFQ'}
        </Button>
      </Box>
    </Box>
  );
}

// ------------------------------------------------------------------------------------------------
// One line
// ------------------------------------------------------------------------------------------------

/** Memoised: its handlers are stable and keyed, so only the line being edited re-renders. */
const RfqLineEditor = memo(function RfqLineEditor({
  companyId,
  line,
  number,
  info,
  disabled,
  onChange: changeLine,
  onPart: pickPart,
  onRemove: removeLine,
}: {
  companyId: string;
  line: FormLine;
  number: number;
  info: PartInfo | null | 'loading' | undefined;
  disabled: boolean;
  onChange: (key: string, change: Partial<FormLine>) => void;
  onPart: (key: string, part: PartSelectOption | null) => void;
  /** Not offered for a line with quotes: it stays. */
  onRemove: (key: string) => void;
}) {
  const onChange = (change: Partial<FormLine>) => changeLine(line.key, change);
  const onPart = (part: PartSelectOption | null) => pickPart(line.key, part);
  const onRemove = line.quoted ? null : () => removeLine(line.key);
  const loadingInfo = info === 'loading';
  const partInfo = info && info !== 'loading' ? info : null;
  const stockUnit = partInfo?.stockUnit ?? line.part?.primary_unit ?? null;
  const options = useMemo(
    () => (partInfo ? purchaseUnitOptions(partInfo.stockUnit, partInfo.conversions) : []),
    [partInfo],
  );
  const optionValues = options.map((o) => o.unit);
  const showCurrent = line.unit !== '' && line.unit !== ANOTHER_UNIT && !optionValues.includes(line.unit);
  const currentBasis = options.find((o) => o.unit === line.unit) ?? null;
  let unitHelp = (currentBasis && factorLabel(currentBasis)) || ' ';
  if (loadingInfo) unitHelp = 'Loading units…';
  else if (info === null) unitHelp = "Couldn't load this part's units.";
  const title = line.kind === 'part' ? 'Part' : 'Other item';

  const setQuantity = (i: number, value: string) => {
    if (!isValidQuantityInput(value)) return;
    onChange({ quantities: line.quantities.map((q, j) => (j === i ? value : q)) });
  };

  return (
    <Box
      role="group"
      aria-label={`Line ${number}`}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Line {number} · {title}
        </Typography>
        {onRemove && <DeleteIconButton ariaLabel={`Remove line ${number}`} onClick={onRemove} disabled={disabled} />}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {line.kind === 'part' ? (
          line.quoted ? (
            <Box sx={{ minWidth: 240 }}>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {line.part?.part_name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Asked in {unitLabel(line.unit)}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ flex: '1 1 260px', minWidth: 240 }}>
              <PartAutocomplete
                companyId={companyId}
                value={line.part}
                onChange={onPart}
                label="Part"
                required
                disabled={disabled}
              />
            </Box>
          )
        ) : (
          <TextField
            label="What you need"
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value })}
            required
            multiline
            size="small"
            disabled={disabled}
            sx={{ flex: '1 1 260px', minWidth: 240 }}
          />
        )}

        {line.kind === 'part' && !line.quoted && line.part && (
          <TextField
            select
            label="Unit"
            size="small"
            value={line.unit}
            onChange={(e) => onChange({ unit: e.target.value })}
            disabled={disabled || loadingInfo}
            helperText={unitHelp}
            sx={{ width: 220 }}
          >
            {options.map((o) => (
              <MenuItem key={o.unit} value={o.unit}>
                {o.unit}
                {o.kind === 'same' ? ' (stock unit)' : ''}
              </MenuItem>
            ))}
            {showCurrent && <MenuItem value={line.unit}>{line.unit}</MenuItem>}
            {!partInfo && line.unit === '' && stockUnit && <MenuItem value={stockUnit}>{stockUnit}</MenuItem>}
            {partInfo && <MenuItem value={ANOTHER_UNIT}>Another unit…</MenuItem>}
          </TextField>
        )}

        {line.kind === 'other' &&
          (line.quoted ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Asked in {line.unit}
            </Typography>
          ) : (
            <TextField
              label="Unit"
              size="small"
              value={line.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              helperText="Each, box, foot…"
              disabled={disabled}
              sx={{ width: 160 }}
            />
          ))}
      </Box>

      {line.kind === 'part' && line.unit === ANOTHER_UNIT && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}>
          <TextField
            label="New unit name"
            size="small"
            value={line.customUnit}
            onChange={(e) => onChange({ customUnit: e.target.value })}
            helperText="Bar, box, roll…"
            disabled={disabled}
            sx={{ width: 200 }}
          />
          <TextField
            label={`How many ${stockUnit ? unitLabel(stockUnit) : 'stock units'} in one`}
            size="small"
            value={line.customFactor}
            onChange={(e) => {
              if (isValidQuantityInput(e.target.value)) onChange({ customFactor: e.target.value });
            }}
            helperText="Saved on the part, so every vendor prices the same amount."
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
            disabled={disabled}
            sx={{ width: 280 }}
          />
        </Box>
      )}

      {line.quoted && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          {line.kind === 'part'
            ? "Has quotes, so its part and unit can't change."
            : "Has quotes, so its unit can't change."}
        </Typography>
      )}

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mt: 2 }}>
        {line.quantities.map((q, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center' }}>
            <TextField
              label={`Quantity ${i + 1}`}
              size="small"
              value={q}
              onChange={(e) => setQuantity(i, e.target.value)}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              disabled={disabled}
              sx={{ width: 130 }}
            />
            {line.quantities.length > 1 && (
              <DeleteIconButton
                ariaLabel={`Remove quantity ${i + 1}`}
                onClick={() => onChange({ quantities: line.quantities.filter((_, j) => j !== i) })}
                disabled={disabled}
              />
            )}
          </Box>
        ))}
        {line.quantities.length < VENDOR_RFQ_MAX_QUANTITIES && (
          <Button
            startIcon={<AddIcon />}
            onClick={() => onChange({ quantities: [...line.quantities, ''] })}
            disabled={disabled}
          >
            Add a quantity
          </Button>
        )}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mt: 1.5 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={line.certRequired}
              onChange={(e) => onChange({ certRequired: e.target.checked })}
              disabled={disabled}
            />
          }
          label="Certs required"
        />
        <TextField
          label="Note for the vendor"
          size="small"
          value={line.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          helperText="Printed on this line."
          disabled={disabled}
          sx={{ flex: '1 1 280px' }}
        />
      </Box>
    </Box>
  );
});
