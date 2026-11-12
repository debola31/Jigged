'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import AddressDisplay from '@/components/common/AddressDisplay';
import ErrorAlert from '@/components/common/ErrorAlert';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';
import { loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import type { PartSelectOption } from '@/components/parts/PartAutocomplete';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import { SAVED_PRICE_SOURCE_CAPTION } from '@/components/purchasing/PriceSourceCaption';
import { isUsableUnitFactor } from '@/components/purchasing/PurchaseUnitField';
import ShipToPicker, { SHOP_SHIP_TO, type ShipToState } from '@/components/purchasing/ShipToPicker';
import VendorPoLineRow, { type FormLine, type LineView } from '@/components/purchasing/VendorPoLineRow';
import { vendorPoCreatedShape } from '@/components/purchasing/vendorPoCreatedShape';
import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, todayLocalISODate } from '@/lib/localDate';
import { formatMoney } from '@/lib/money';
import { isValidUnitPriceInput, vendorPoLineAmount, vendorPoTotal } from '@/lib/purchasing/amount';
import { NO_PRICE_CAPTION, TYPED_PRICE_CAPTION } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, resolvePurchaseUnit, unitLabel, unitNameKey } from '@/lib/purchasing/purchaseUnits';
import { diffVendorVisible, predictVendorPoRevision, type VendorPoDocumentSnapshot } from '@/lib/purchasing/vendorPoVisibleFields';
import { purchasingHubPath, vendorPoPath } from '@/lib/purchasingRoutes';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import { getAddressesForVendor } from '@/utils/vendorAddressesAccess';
import { getContactsForVendor } from '@/utils/vendorContactsAccess';
import { getVendor } from '@/utils/vendorsAccess';
import {
  createVendorPo,
  getPriceDefaultInputs,
  listOpenOutsideOpsForVendor,
  resolveLinePriceDefault,
  updateVendorPo,
} from '@/utils/vendorPoAccess';
import type { Vendor, VendorAddress } from '@/types/vendor';
import type { VendorContact } from '@/types/vendorContact';
import type {
  OpenOutsideOperation,
  VendorPoDetail,
  VendorPoHeaderChanges,
  VendorPoHeaderInput,
  VendorPoLine,
  VendorPoLineKind,
  VendorPoLinePatch,
  VendorPoNewLineInput,
  VendorPoPriceDefaultInputs,
  VendorPoPriceSource,
} from '@/types/vendorPo';

/** Ids only, from the new-PO page's query string (`?vendor= &part= &job= &jobPart= &jobOperation= &workCenter=`). */
export interface VendorPoFormPrefill {
  vendorId?: string | null;
  partId?: string | null;
  jobId?: string | null;
  jobPartId?: string | null;
  jobOperationId?: string | null;
  workCenterId?: string | null;
}

export type VendorPoFormProps =
  | { mode: 'create'; companyId: string; prefill?: VendorPoFormPrefill }
  | { mode: 'edit'; companyId: string; po: VendorPoDetail; onCancel: () => void; onSaved: () => void | Promise<void> };

interface VendorChoice {
  id: string;
  name: string;
  defaultPaymentTerms: string | null;
}

let keySeq = 0;
const nextKey = () => `new-${++keySeq}`;

function blankLine(kind: VendorPoLineKind): FormLine {
  return {
    key: nextKey(),
    id: null,
    lineKind: kind,
    part: null,
    jobOperationId: null,
    jobId: null,
    jobNumber: null,
    jobPartId: null,
    workCenterId: null,
    description: '',
    descriptionTouched: false,
    vendorPartNumber: '',
    vendorPartNumberTouched: false,
    quantity: kind === 'outside_service' ? '' : '1',
    unit: kind === 'other' ? 'each' : '',
    unitTouched: kind === 'other',
    unitFactor: '',
    unitPrice: '',
    priceTouched: kind === 'other',
    needByOn: '',
    certRequired: false,
    expectsReceipt: true,
    saved: null,
  };
}

/** A saved line, as the form edits it: every value is the saved one, so nothing re-defaults. */
function fromSaved(line: VendorPoLine): FormLine {
  return {
    key: line.id,
    id: line.id,
    lineKind: line.lineKind,
    part:
      line.lineKind === 'part' && line.partId
        ? {
            id: line.partId,
            part_name: line.partName ?? line.description,
            description: null,
            has_routing: false,
            source: 'bought',
            primary_unit: line.stockUnit,
            quantity: 0,
          }
        : null,
    jobOperationId: line.jobOperationId,
    jobId: line.jobId,
    jobNumber: line.jobNumber,
    jobPartId: line.jobPartId,
    workCenterId: line.workCenterId,
    description: line.description,
    descriptionTouched: true,
    vendorPartNumber: line.vendorPartNumber ?? '',
    vendorPartNumberTouched: true,
    quantity: String(line.quantity),
    unit: line.unit,
    unitTouched: true,
    unitFactor: '',
    unitPrice: line.unitPrice === null ? '' : String(line.unitPrice),
    priceTouched: true,
    needByOn: line.needByOn ?? '',
    certRequired: line.certRequired,
    expectsReceipt: line.expectsReceipt,
    saved: line,
  };
}

/** Fill a new outside line from the step it pays for. */
function fillFromOp(line: FormLine, op: OpenOutsideOperation): FormLine {
  const left = op.leftToSendQuantity > 0 ? op.leftToSendQuantity : op.orderedQuantity;
  return {
    ...line,
    jobOperationId: op.jobOperationId,
    jobId: op.jobId,
    jobNumber: op.jobNumber,
    jobPartId: op.jobPartId,
    quantity: String(left),
    unit: op.stockUnit ?? '',
    description: op.defaultDescription,
    priceTouched: false,
    unitPrice: '',
  };
}

/** The DB's default contact: a sales contact (the primary one first), else the primary contact. */
function defaultContactId(contacts: readonly VendorContact[]): string | null {
  const ranked = contacts
    .filter((c) => c.role === 'sales' || c.is_primary)
    .sort(
      (a, b) =>
        Number(b.role === 'sales') - Number(a.role === 'sales') ||
        Number(b.is_primary) - Number(a.is_primary) ||
        String(a.created_at).localeCompare(String(b.created_at)),
    );
  return ranked[0]?.id ?? null;
}

/** The default address, or the only one. With several and no default, the form asks. */
function defaultAddressId(addresses: readonly VendorAddress[]): string | null {
  return addresses.find((a) => a.is_default)?.id ?? (addresses.length === 1 ? addresses[0].id : null);
}

function addressLabel(a: VendorAddress): string {
  return [a.address_line1, a.city, a.state].filter(Boolean).join(', ') || 'Address';
}

const text = (v: string | null | undefined) => (v ?? '').trim();
const textOrNull = (v: string | null | undefined) => text(v) || null;

function sameShipTo(a: ShipToState, b: ShipToState): boolean {
  return (
    a.kind === b.kind &&
    (a.vendorId ?? null) === (b.vendorId ?? null) &&
    (a.vendorAddressId ?? null) === (b.vendorAddressId ?? null) &&
    (a.customerId ?? null) === (b.customerId ?? null) &&
    (a.customerAddressId ?? null) === (b.customerAddressId ?? null)
  );
}

/**
 * The purchase order form — create, and edit in place of the PO page (plan §3.13 "PO form").
 *
 * THE FORM HOLDS ONLY WHAT THE VENDOR SEES. Internal notes and promised dates auto-save on the PO
 * page instead, so on a sent PO "unsaved" always means "the vendor's copy will change" — which is
 * why the save button can predict "Save as Rev N+1" from the one shared field list
 * (lib/purchasing/vendorPoVisibleFields.ts); the database decides the real number.
 *
 * DEFAULTS FILL ONLY WHAT IS UNTOUCHED. Picking the vendor fills its sales contact, its default
 * address and its standing terms; a price, unit, vendor part number or description the person typed
 * is never overwritten by a later default. Defaults are DERIVED each render from
 * lib/purchasing/priceDefault (through `resolveLinePriceDefault`), never copied into state, so a
 * caption can never describe a different number than the field shows.
 *
 * Saving is explicit; unsaved is computed against what was loaded, and `beforeunload` is armed only
 * while something is. Save is blocked only by what `MissingFieldsNotice` lists. Removing a line is
 * staged until Save, so it asks nothing. A line with receipts keeps its part and unit.
 *
 * QuickBooks: the terms picker loads QuickBooks' terms only when it is opened (lazy), so opening
 * this form makes no QuickBooks call (criterion QB1).
 */
export default function VendorPoForm(props: VendorPoFormProps) {
  const router = useRouter();
  const { companyId } = props;
  const po = props.mode === 'edit' ? props.po : null;
  const header = po?.header ?? null;
  const prefill = props.mode === 'create' ? props.prefill : undefined;
  const [today] = useState(() => todayLocalISODate());
  const sent = header !== null && header.issuedAt !== null;

  // ---------------------------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------------------------
  const [vendor, setVendor] = useState<VendorChoice | null>(() =>
    header ? { id: header.vendorId, name: header.vendorName, defaultPaymentTerms: null } : null,
  );
  const [vendorPrefillId] = useState(() => prefill?.vendorId ?? null);
  const [contactId, setContactId] = useState<string | null>(() => header?.vendorContactId ?? null);
  const [addressId, setAddressId] = useState<string | null>(() => header?.vendorAddressId ?? null);
  const [contacts, setContacts] = useState<VendorContact[] | null>(null);
  const [addresses, setAddresses] = useState<VendorAddress[] | null>(null);
  const [paymentTerms, setPaymentTerms] = useState(() => header?.paymentTerms ?? '');
  const [termsTouched, setTermsTouched] = useState(() => header !== null);
  const [shipTo, setShipTo] = useState<ShipToState>(() =>
    header
      ? {
          kind: header.shipToKind,
          vendorId: header.shipToVendorId,
          vendorAddressId: header.shipToVendorAddressId,
          customerId: header.shipToCustomerId,
          customerAddressId: header.shipToCustomerAddressId,
        }
      : SHOP_SHIP_TO,
  );
  const [orderedOn, setOrderedOn] = useState(() => header?.orderedOn ?? today);
  const [needByOn, setNeedByOn] = useState(() => header?.needByOn ?? '');
  const [shipVia, setShipVia] = useState(() => header?.shipVia ?? '');
  const [notesToVendor, setNotesToVendor] = useState(() => header?.notesToVendor ?? '');

  // The vendor whose defaults should land once its contacts and addresses arrive — set by a pick
  // (or a prefilled vendor), never by the initial load of an existing PO, whose saved choices stand.
  const defaultsFor = useRef<string | null>(prefill?.vendorId ?? null);
  const vendorId = vendor?.id ?? vendorPrefillId;

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    Promise.all([getContactsForVendor(vendorId), getAddressesForVendor(vendorId)])
      .then(([c, a]) => {
        if (cancelled) return;
        setContacts(c);
        setAddresses(a);
        if (defaultsFor.current === vendorId) {
          defaultsFor.current = null;
          setContactId(defaultContactId(c));
          setAddressId(defaultAddressId(a));
        }
      })
      .catch(() => {
        if (cancelled) return;
        // The pickers go empty; the database still defaults the contact and address on create.
        setContacts([]);
        setAddresses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  const pickVendor = (v: Vendor | null) => {
    setVendor(v ? { id: v.id, name: v.name, defaultPaymentTerms: v.default_payment_terms ?? null } : null);
    // A contact and an address belong to ONE vendor, so they always follow it; the terms are the
    // person's once touched.
    setContactId(null);
    setAddressId(null);
    setContacts(null);
    setAddresses(null);
    defaultsFor.current = v?.id ?? null;
    if (!termsTouched) setPaymentTerms(v?.default_payment_terms ?? '');
  };

  // A prefilled vendor (an operation card's "Create PO"): read its name and standing terms, so the
  // terms default exactly as a pick would, and the save never sends "no terms" in their place.
  useEffect(() => {
    if (!vendorPrefillId) return;
    let cancelled = false;
    getVendor(vendorPrefillId)
      .then((v) => {
        if (cancelled || !v) return;
        setVendor((current) => current ?? { id: v.id, name: v.name, defaultPaymentTerms: v.default_payment_terms ?? null });
        // Only into an untouched field: anything already typed stays.
        setPaymentTerms((current) => (current === '' ? (v.default_payment_terms ?? '') : current));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vendorPrefillId]);

  // ---------------------------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------------------------
  const [lines, setLines] = useState<FormLine[]>(() => {
    if (po) return po.lines.map(fromSaved);
    const initial: FormLine[] = [];
    if (prefill?.jobOperationId) {
      initial.push({ ...blankLine('outside_service'), jobOperationId: prefill.jobOperationId });
    } else if (prefill?.workCenterId) {
      initial.push({ ...blankLine('other'), workCenterId: prefill.workCenterId, jobId: prefill.jobId ?? null });
    } else if (prefill?.partId) {
      initial.push({ ...blankLine('part'), jobId: prefill.jobId ?? null, jobPartId: prefill.jobPartId ?? null });
    }
    return initial;
  });
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const prefillPartId = useRef(prefill?.partId ?? null);
  const prefillOpId = useRef(prefill?.jobOperationId ?? null);

  // Hydrate a prefilled part (ids only reach this form, never names from the URL).
  useEffect(() => {
    const partId = prefillPartId.current;
    if (!partId) return;
    prefillPartId.current = null;
    let cancelled = false;
    getPartsForSelectByIds([partId])
      .then((rows) => {
        if (cancelled || !rows[0]) return;
        const part: PartSelectOption = rows[0];
        setLines((current) => current.map((l, i) => (i === 0 && l.lineKind === 'part' && !l.part ? { ...l, part } : l)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const updateLine = (key: string, patch: Partial<FormLine>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addLine = (kind: VendorPoLineKind) => setLines((current) => [...current, blankLine(kind)]);

  const removeLine = (line: FormLine) => {
    setLines((current) => current.filter((l) => l.key !== line.key));
    if (line.id) setRemovedIds((ids) => [...ids, line.id as string]);
  };

  // Price-default inputs per (vendor, part): this vendor's sheet, Last PO prices, the part's units.
  const [priceInputs, setPriceInputs] = useState<Map<string, VendorPoPriceDefaultInputs | 'error'>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const wantedKeys = vendorId
    ? [...new Set(lines.filter((l) => l.lineKind === 'part' && l.part).map((l) => `${vendorId}:${l.part?.id}`))]
    : [];
  const wantedKey = wantedKeys.join('|');
  useEffect(() => {
    for (const key of wantedKey ? wantedKey.split('|') : []) {
      if (priceInputs.has(key) || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      const [v, p] = key.split(':');
      getPriceDefaultInputs(companyId, v, p)
        .then((inputs) => setPriceInputs((m) => new Map(m).set(key, inputs)))
        .catch(() => setPriceInputs((m) => new Map(m).set(key, 'error')))
        .finally(() => inFlight.current.delete(key));
    }
  }, [companyId, wantedKey, priceInputs]);

  // This vendor's open outside steps: for outside lines, and for the leak guard on Other lines.
  const needOps =
    Boolean(vendorId) &&
    lines.some((l) => (l.lineKind === 'outside_service' && !l.saved) || (l.lineKind === 'other' && Boolean(l.jobId)));
  const opsLoad = useLoad(
    () =>
      needOps && vendorId
        ? listOpenOutsideOpsForVendor(companyId, vendorId).then((ops) => {
            const pending = prefillOpId.current;
            if (pending) {
              prefillOpId.current = null;
              const op = ops.find((o) => o.jobOperationId === pending);
              if (op) setLines((current) => current.map((l) => (l.jobOperationId === pending && !l.saved ? fillFromOp(l, op) : l)));
            }
            return { vendorId, ops };
          })
        : Promise.resolve(null),
    [companyId, vendorId, needOps],
  );
  // Only this vendor's steps: a list still showing the last vendor's would offer a step the
  // database refuses ("done by X, not Y").
  const ops = opsLoad.data && opsLoad.data.vendorId === vendorId ? opsLoad.data.ops : null;

  const needJobs = lines.some((l) => l.lineKind !== 'outside_service');
  const jobsLoad = useLoad(() => (needJobs ? loadTaggableJobs(companyId) : Promise.resolve([])), [companyId, needJobs]);
  const jobs = jobsLoad.data ?? [];

  // ---------------------------------------------------------------------------------------------
  // Each line's derived view: defaults, captions, problems
  // ---------------------------------------------------------------------------------------------
  const maxSavedNumber = po ? Math.max(0, ...po.lines.map((l) => l.lineNumber)) : 0;
  // Saved lines keep their number; new ones follow the highest saved one (the database assigns the
  // real number on save — line numbers are never reused).
  const numbered = lines.map((line, i) => {
    if (line.saved) return { line, number: line.saved.lineNumber };
    const newSoFar = lines.slice(0, i + 1).filter((l) => !l.saved).length;
    return { line, number: maxSavedNumber + newSoFar };
  });

  const views: LineView[] = numbered.map(({ line }) => {
    const saved = line.saved;
    const qty = Number(line.quantity);
    const qtyOk = line.quantity.trim() !== '' && Number.isFinite(qty) && qty > 0;
    const problems: string[] = [];
    let unit = line.unit;
    let stockUnit: string | null = null;
    let conversions: LineView['conversions'] = [];
    let unitPrice = line.unitPrice;
    let priceSource: VendorPoPriceSource | null = null;
    let caption = NO_PRICE_CAPTION;
    let warnings: string[] = [];
    let vendorPartNumber = line.vendorPartNumber;
    let description = line.description;
    let notice: LineView['notice'] = null;
    let op: OpenOutsideOperation | null = null;
    let leak: OpenOutsideOperation | null = null;

    // A typed (or saved) price: where it came from.
    const typedCaption = () => {
      const priceNumber = isValidUnitPriceInput(text(line.unitPrice)) && text(line.unitPrice) !== '' ? Number(line.unitPrice) : null;
      if (saved && priceNumber === saved.unitPrice) {
        priceSource = saved.priceSource;
        caption = saved.priceSource ? SAVED_PRICE_SOURCE_CAPTION[saved.priceSource] : NO_PRICE_CAPTION;
      } else if (text(line.unitPrice) === '') {
        priceSource = null;
        caption = NO_PRICE_CAPTION;
      } else {
        priceSource = 'manual';
        caption = TYPED_PRICE_CAPTION;
      }
    };

    if (line.lineKind === 'part') {
      const key = vendorId && line.part ? `${vendorId}:${line.part.id}` : null;
      const loaded = key ? priceInputs.get(key) : undefined;
      const inputs = loaded && loaded !== 'error' ? loaded : null;
      stockUnit = inputs?.stockUnit ?? line.part?.primary_unit ?? saved?.stockUnit ?? null;
      conversions = inputs?.conversions ?? [];
      const typedPrice = line.priceTouched
        ? text(line.unitPrice) === '' || !isValidUnitPriceInput(text(line.unitPrice))
          ? null
          : Number(line.unitPrice)
        : undefined;
      const resolution = inputs
        ? resolveLinePriceDefault(inputs, {
            quantity: qtyOk ? qty : 0,
            unit: line.unitTouched ? line.unit : line.unit || null,
            today,
            ...(typedPrice !== undefined ? { typedPrice } : {}),
          })
        : null;
      unit = line.unitTouched ? line.unit : (resolution?.unit ?? line.unit);
      if (line.priceTouched) {
        typedCaption();
      } else if (resolution) {
        unitPrice = resolution.price.unitPrice === null ? '' : String(resolution.price.unitPrice);
        priceSource = resolution.price.priceSource;
        caption = resolution.price.caption;
        warnings = resolution.price.warnings;
      } else {
        unitPrice = '';
        caption = !vendorId
          ? 'Choose the vendor to see prices.'
          : !line.part
            ? NO_PRICE_CAPTION
            : loaded === 'error'
              ? "Couldn't look up a price — type one, or leave it blank to confirm later."
              : 'Looking up the price…';
      }
      vendorPartNumber = line.vendorPartNumberTouched ? line.vendorPartNumber : (resolution?.vendorPartNumber ?? '');
      description = line.descriptionTouched
        ? line.description
        : line.part
          ? text(line.part.description) || line.part.part_name
          : '';
      notice = resolution?.notice ?? null;

      if (!line.part) problems.push('choose the part.');
      const partChanged = !saved || saved.partId !== line.part?.id;
      if (notice?.tone === 'blocked' && partChanged) {
        problems.push(`${vendor?.name ?? 'This vendor'} is marked Do not use for this part.`);
      }
      if (stockUnit && text(unit) !== '') {
        const basis = resolvePurchaseUnit(unit, stockUnit, conversions);
        if (basis.kind === 'incomparable' && !isUsableUnitFactor(line.unitFactor) && (!saved || unitNameKey(unit) !== unitNameKey(saved.unit))) {
          problems.push(`say how many ${unitLabel(stockUnit)} are in one ${text(unit)}.`);
        }
      }
    } else if (line.lineKind === 'outside_service') {
      op = ops?.find((o) => o.jobOperationId === line.jobOperationId) ?? null;
      unit = line.unit || op?.stockUnit || saved?.unit || '';
      description = saved ? saved.description : (op?.defaultDescription ?? line.description);
      if (line.priceTouched) {
        typedCaption();
      } else if (op) {
        unitPrice = op.priceDefault.unitPrice === null ? '' : String(op.priceDefault.unitPrice);
        priceSource = op.priceDefault.priceSource;
        caption = op.priceDefault.caption;
        warnings = op.priceDefault.warnings;
      } else {
        unitPrice = '';
        caption = vendorId ? 'Choose the step it pays for.' : 'Choose the vendor first.';
      }
      if (!line.jobOperationId) problems.push('pick the outside step it pays for.');
    } else {
      typedCaption();
      if (!text(line.description)) problems.push('describe what you are buying.');
      leak = line.jobId && ops ? (ops.find((o) => o.jobId === line.jobId) ?? null) : null;
    }

    const quantityError = !qtyOk
      ? 'Enter a quantity greater than zero.'
      : saved && saved.lineKind !== 'outside_service' && qty < saved.receivedQuantity
        ? `Can't be less than the ${formatUnitQuantity(saved.receivedQuantity)} ${unitLabel(saved.unit)} already received.`
        : null;
    if (quantityError) problems.push(quantityError.charAt(0).toLowerCase() + quantityError.slice(1));
    const priceOk = text(unitPrice) === '' || isValidUnitPriceInput(text(unitPrice));
    const priceError = priceOk ? null : 'Up to 5 decimals, no $ or commas — or leave it blank to confirm later.';
    if (priceError) problems.push('enter the price as a plain number, or leave it blank to confirm it later.');
    const priceValue = priceOk && text(unitPrice) !== '' ? Number(unitPrice) : null;

    return {
      unit,
      stockUnit,
      conversions,
      unitPrice,
      priceSource,
      caption,
      warnings,
      vendorPartNumber,
      description,
      notice,
      op,
      leak,
      amount: qtyOk ? vendorPoLineAmount(qty, priceValue) : null,
      quantityError,
      priceError,
      problems,
      changed: false,
    };
  });

  const priceOf = (view: LineView): number | null => {
    const t = text(view.unitPrice);
    return t !== '' && isValidUnitPriceInput(t) ? Number(t) : null;
  };

  // ---------------------------------------------------------------------------------------------
  // What a save would send
  // ---------------------------------------------------------------------------------------------
  const newLineInput = (line: FormLine, view: LineView): VendorPoNewLineInput => {
    const base = {
      quantity: Number(line.quantity),
      unitPrice: priceOf(view),
      priceSource: view.priceSource,
      certRequired: line.certRequired,
      // Blank: the line takes the PO's need-by date, frozen by the database.
      ...(line.needByOn ? { needByOn: line.needByOn } : {}),
    };
    if (line.lineKind === 'part') {
      return {
        lineKind: 'part',
        partId: line.part?.id ?? null,
        ...(line.jobId ? { jobId: line.jobId, jobPartId: line.jobPartId } : {}),
        description: textOrNull(view.description),
        vendorPartNumber: textOrNull(view.vendorPartNumber),
        ...(text(view.unit) ? { unit: text(view.unit) } : {}),
        ...(isUsableUnitFactor(line.unitFactor) ? { unitFactor: Number(line.unitFactor) } : {}),
        ...base,
      };
    }
    if (line.lineKind === 'outside_service') {
      return {
        lineKind: 'outside_service',
        jobOperationId: line.jobOperationId,
        description: textOrNull(view.description),
        ...base,
      };
    }
    return {
      lineKind: 'other',
      description: text(line.description),
      unit: text(line.unit) || 'each',
      expectsReceipt: line.expectsReceipt,
      ...(line.workCenterId ? { workCenterId: line.workCenterId } : {}),
      ...(line.jobId ? { jobId: line.jobId } : {}),
      ...base,
    };
  };

  /** Only the keys that changed on a saved line; `null` when nothing did. */
  const linePatch = (line: FormLine, view: LineView): VendorPoLinePatch | null => {
    const saved = line.saved;
    if (!saved || !line.id) return null;
    const patch: VendorPoLinePatch = { id: line.id };
    const isPart = line.lineKind === 'part';
    if (isPart && (line.part?.id ?? null) !== saved.partId) patch.partId = line.part?.id ?? null;
    if (line.lineKind !== 'outside_service' && text(view.description) !== text(saved.description)) {
      patch.description = text(view.description);
    }
    if (textOrNull(view.vendorPartNumber) !== textOrNull(saved.vendorPartNumber)) patch.vendorPartNumber = textOrNull(view.vendorPartNumber);
    const qty = Number(line.quantity);
    if (Number.isFinite(qty) && qty !== saved.quantity) patch.quantity = qty;
    if (line.lineKind !== 'outside_service') {
      const unitChanged = isPart ? unitNameKey(view.unit) !== unitNameKey(saved.unit) : text(line.unit) !== text(saved.unit);
      if (unitChanged) {
        patch.unit = text(isPart ? view.unit : line.unit) || null;
        if (isPart && isUsableUnitFactor(line.unitFactor)) patch.unitFactor = Number(line.unitFactor);
      }
    }
    const price = priceOf(view);
    if (price !== saved.unitPrice) {
      patch.unitPrice = price;
      patch.priceSource = view.priceSource;
    }
    if (textOrNull(line.needByOn) !== saved.needByOn) patch.needByOn = textOrNull(line.needByOn);
    if (line.certRequired !== saved.certRequired) patch.certRequired = line.certRequired;
    if (line.lineKind !== 'outside_service' && line.jobId !== saved.jobId) {
      patch.jobId = line.jobId;
      // A different job's part would be refused ("belongs to another job").
      patch.jobPartId = null;
    }
    if (line.lineKind === 'other') {
      if (line.workCenterId !== saved.workCenterId) patch.workCenterId = line.workCenterId;
      if (line.expectsReceipt !== saved.expectsReceipt) patch.expectsReceipt = line.expectsReceipt;
    }
    return Object.keys(patch).length > 1 ? patch : null;
  };

  const patches: VendorPoLinePatch[] = [];
  const newLines: VendorPoNewLineInput[] = [];
  numbered.forEach(({ line }, i) => {
    if (line.saved) {
      const p = linePatch(line, views[i]);
      if (p) {
        patches.push(p);
        views[i].changed = true;
      }
    } else {
      newLines.push(newLineInput(line, views[i]));
      if (po) views[i].changed = true;
    }
  });

  const headerChanges: VendorPoHeaderChanges = {};
  if (header) {
    if (vendor && vendor.id !== header.vendorId) headerChanges.vendorId = vendor.id;
    if (orderedOn !== header.orderedOn) headerChanges.orderedOn = orderedOn;
    if (contactId !== header.vendorContactId) headerChanges.vendorContactId = contactId;
    if (addressId !== header.vendorAddressId) headerChanges.vendorAddressId = addressId;
    const savedShipTo: ShipToState = {
      kind: header.shipToKind,
      vendorId: header.shipToVendorId,
      vendorAddressId: header.shipToVendorAddressId,
      customerId: header.shipToCustomerId,
      customerAddressId: header.shipToCustomerAddressId,
    };
    if (!sameShipTo(shipTo, savedShipTo)) headerChanges.shipTo = shipTo;
    if (textOrNull(needByOn) !== header.needByOn) headerChanges.needByOn = textOrNull(needByOn);
    if (textOrNull(paymentTerms) !== header.paymentTerms) headerChanges.paymentTerms = textOrNull(paymentTerms);
    if (textOrNull(shipVia) !== header.shipVia) headerChanges.shipVia = textOrNull(shipVia);
    if (textOrNull(notesToVendor) !== header.notesToVendor) headerChanges.notesToVendor = textOrNull(notesToVendor);
  }

  // Revision prediction, from the ONE vendor-visible field list.
  const before = useMemo<VendorPoDocumentSnapshot | null>(() => {
    if (!po) return null;
    const h = po.header;
    return {
      header: {
        vendor_contact_id: h.vendorContactId,
        vendor_address_id: h.vendorAddressId,
        ship_to_kind: h.shipToKind,
        ship_to_vendor_id: h.shipToVendorId,
        ship_to_vendor_address_id: h.shipToVendorAddressId,
        ship_to_customer_id: h.shipToCustomerId,
        ship_to_customer_address_id: h.shipToCustomerAddressId,
        need_by_on: h.needByOn,
        payment_terms: h.paymentTerms,
        ship_via: h.shipVia,
        notes_to_vendor: h.notesToVendor,
      },
      lines: po.lines.map((l) => ({
        id: l.id,
        part_id: l.partId,
        description: l.description,
        vendor_part_number: l.vendorPartNumber,
        quantity: l.quantity,
        unit: l.unit,
        unit_price: l.unitPrice,
        need_by_on: l.needByOn,
        cert_required: l.certRequired,
        job_id: l.jobId,
        job_part_id: l.jobPartId,
        work_center_id: l.workCenterId,
      })),
    };
  }, [po]);
  const after: VendorPoDocumentSnapshot = {
    header: {
      vendor_contact_id: contactId,
      vendor_address_id: addressId,
      ship_to_kind: shipTo.kind,
      ship_to_vendor_id: shipTo.vendorId,
      ship_to_vendor_address_id: shipTo.vendorAddressId,
      ship_to_customer_id: shipTo.customerId,
      ship_to_customer_address_id: shipTo.customerAddressId,
      need_by_on: textOrNull(needByOn),
      payment_terms: textOrNull(paymentTerms),
      ship_via: textOrNull(shipVia),
      notes_to_vendor: textOrNull(notesToVendor),
    },
    lines: numbered.map(({ line }, i) => {
      const view = views[i];
      const saved = line.saved;
      return {
        id: line.id,
        part_id: line.lineKind === 'part' ? (line.part?.id ?? null) : (saved?.partId ?? null),
        description: line.lineKind === 'outside_service' && saved ? saved.description : textOrNull(view.description),
        vendor_part_number: textOrNull(view.vendorPartNumber),
        quantity: line.quantity,
        unit: saved && line.lineKind !== 'other' && unitNameKey(view.unit) === unitNameKey(saved.unit) ? saved.unit : view.unit,
        unit_price: priceOf(view),
        need_by_on: textOrNull(line.needByOn),
        cert_required: line.certRequired,
        job_id: line.lineKind === 'outside_service' ? (saved?.jobId ?? line.jobId) : line.jobId,
        job_part_id:
          line.lineKind === 'outside_service'
            ? (saved?.jobPartId ?? line.jobPartId)
            : saved && line.jobId === saved.jobId
              ? saved.jobPartId
              : line.jobId === null
                ? null
                : line.jobPartId,
        work_center_id: line.lineKind === 'other' ? line.workCenterId : (saved?.workCenterId ?? null),
      };
    }),
  };
  const vendorVisibleChanged = before !== null && diffVendorVisible(before, after).length > 0;
  const prediction = header
    ? predictVendorPoRevision({ revision: header.revision, sentRevision: header.sentRevision, vendorVisibleChanged })
    : null;

  const dirty = po
    ? Object.keys(headerChanges).length > 0 || patches.length > 0 || newLines.length > 0 || removedIds.length > 0
    : Boolean(vendor) ||
      lines.length > 0 ||
      text(shipVia) !== '' ||
      text(notesToVendor) !== '' ||
      text(needByOn) !== '' ||
      (termsTouched && text(paymentTerms) !== '') ||
      shipTo.kind !== 'shop';

  // The exit guard, armed only while something is unsaved (interaction-standards.md Invariant 2).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ---------------------------------------------------------------------------------------------
  // What blocks Save — the notice lists exactly these, and nothing else disables the button
  // ---------------------------------------------------------------------------------------------
  const blocking: string[] = [];
  if (!vendorId) blocking.push('Choose the vendor.');
  if (!orderedOn) blocking.push('Choose the order date.');
  if (lines.length === 0) blocking.push('Add at least one line.');
  numbered.forEach(({ number }, i) => {
    for (const p of views[i].problems) blocking.push(`Line ${number}: ${p}`);
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const canSave = blocking.length === 0 && !saving && (po ? dirty : true);

  const total = vendorPoTotal(numbered.map(({ line }, i) => ({ quantity: Number(line.quantity) || 0, unitPrice: priceOf(views[i]) })));

  const save = async () => {
    if (!canSave || !vendorId) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (po && header && props.mode === 'edit') {
        const result = await updateVendorPo(header.id, {
          today,
          changes: headerChanges,
          lines: [...patches, ...newLines],
          removedLineIds: removedIds,
          expectedUpdatedAt: header.updatedAt,
        });
        posthog.capture('vendor po updated', {
          revision_bumped: result.revisionBumped,
          added_line_count: newLines.length,
          removed_line_count: removedIds.length,
          changed_line_count: patches.length,
          header_changed: Object.keys(headerChanges).length > 0,
        });
        await props.onSaved();
        return;
      }
      const headerInput: VendorPoHeaderInput = {
        // Before the vendor's contacts arrive, let the database pick its default.
        ...(contacts !== null ? { vendorContactId: contactId } : {}),
        ...(addresses !== null ? { vendorAddressId: addressId } : {}),
        shipTo,
        needByOn: textOrNull(needByOn),
        paymentTerms: textOrNull(paymentTerms),
        shipVia: textOrNull(shipVia),
        notesToVendor: textOrNull(notesToVendor),
      };
      const created = await createVendorPo({ vendorId, orderedOn, today, header: headerInput, lines: newLines });
      const shape = vendorPoCreatedShape(
        newLines.map((l) => ({ lineKind: l.lineKind, jobId: l.jobId ?? null, unitPrice: l.unitPrice ?? null, priceSource: l.priceSource ?? null })),
      );
      posthog.capture('vendor po created', {
        surface: prefill?.jobOperationId ? 'operation' : 'form',
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
      router.push(vendorPoPath(companyId, created.id));
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (props.mode === 'edit') props.onCancel();
    else router.push(purchasingHubPath(companyId, 'orders'));
  };

  // ---------------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------------
  const outsideLinesPresent = lines.some((l) => l.lineKind === 'outside_service');
  const vendorLocked = sent || (po !== null && outsideLinesPresent);
  const vendorLockReason = sent
    ? "The vendor can't change once a PO is sent. Close it and duplicate it to order from someone else."
    : po && outsideLinesPresent
      ? "Remove the outside-service lines to change the vendor — they pay for this vendor's steps."
      : undefined;
  const takenOps = lines.filter((l) => l.lineKind === 'outside_service' && l.jobOperationId).map((l) => l.jobOperationId as string);
  const currentAddress = addresses?.find((a) => a.id === addressId) ?? null;
  const contactMissing = contactId !== null && contacts !== null && !contacts.some((c) => c.id === contactId);
  const addressMissing = addressId !== null && addresses !== null && !addresses.some((a) => a.id === addressId);

  return (
    <Box component="form" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      {header && prediction?.willBump && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {header.poNumber} was sent to {header.vendorName}
          {header.lastSentAt ? ` on ${new Date(header.lastSentAt).toLocaleDateString()}` : ''}. Saving makes it Rev{' '}
          {prediction.revisionAfterSave} — send it again.
        </Alert>
      )}
      {header && header.sentRevision !== null && header.revision > header.sentRevision && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Rev {header.revision} hasn&apos;t gone to {header.vendorName} yet. These changes are part of it.
        </Alert>
      )}

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            {header ? `Edit ${header.poNumber}` : 'New purchase order'}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2 }}>
            <Box>
              <VendorAutocomplete
                companyId={companyId}
                valueId={vendorId}
                onChange={pickVendor}
                label="Vendor"
                required
                disabled={vendorLocked}
                helperText={vendorLockReason}
              />
              {vendorLockReason && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {vendorLockReason}
                </Typography>
              )}
            </Box>
            <TextField
              select
              label="Contact"
              size="small"
              value={contactId ?? ''}
              onChange={(e) => setContactId(e.target.value || null)}
              disabled={!vendorId}
              helperText={vendorId && contacts?.length === 0 ? 'No contacts on file for this vendor.' : ' '}
            >
              <MenuItem value="">No contact</MenuItem>
              {contactMissing && header && <MenuItem value={contactId ?? ''}>{header.vendorContact?.name ?? 'Current contact'}</MenuItem>}
              {(contacts ?? []).map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                  {c.role === 'sales' ? ' · Sales' : c.is_primary ? ' · Primary' : ''}
                </MenuItem>
              ))}
            </TextField>
            <Box>
              <TextField
                select
                label="Order from"
                size="small"
                value={addressId ?? ''}
                onChange={(e) => setAddressId(e.target.value || null)}
                disabled={!vendorId}
                fullWidth
                helperText={
                  vendorId && addresses && addresses.length > 1 && !addressId
                    ? 'This vendor has several addresses and none is the default — choose one.'
                    : vendorId && addresses?.length === 0
                      ? 'No address on file — the PO will say so.'
                      : ' '
                }
              >
                <MenuItem value="">No address</MenuItem>
                {addressMissing && header && (
                  <MenuItem value={addressId ?? ''}>{header.vendorAddress?.address_line1 ?? 'Current address'}</MenuItem>
                )}
                {(addresses ?? []).map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {addressLabel(a)}
                  </MenuItem>
                ))}
              </TextField>
              {currentAddress && (
                <Box sx={{ mt: 0.5 }}>
                  <AddressDisplay address={currentAddress} />
                </Box>
              )}
            </Box>
            <PaymentTermsPicker
              companyId={companyId}
              value={paymentTerms}
              onChange={(v) => {
                setPaymentTerms(v);
                setTermsTouched(true);
              }}
              lazyQuickBooksTerms
              helperText={vendor?.defaultPaymentTerms && !termsTouched ? `${vendor.name}'s standing terms` : undefined}
            />
            <TextField
              label="Order date"
              type="date"
              size="small"
              value={orderedOn}
              onChange={(e) => setOrderedOn(e.target.value)}
              disabled={sent}
              helperText={sent ? 'Fixed once the PO is sent.' : ' '}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Needed by (whole order)"
              type="date"
              size="small"
              value={needByOn}
              onChange={(e) => setNeedByOn(e.target.value)}
              helperText="New lines without their own date take this one."
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Ship via"
              size="small"
              value={shipVia}
              onChange={(e) => setShipVia(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 100 } }}
            />
          </Box>
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Ship to
          </Typography>
          <ShipToPicker companyId={companyId} value={shipTo} onChange={setShipTo} />
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Lines
          </Typography>
          <Stack spacing={2}>
            {numbered.map(({ line, number }, i) => (
              <VendorPoLineRow
                key={line.key}
                companyId={companyId}
                position={i + 1}
                displayNumber={number}
                line={line}
                view={views[i]}
                vendorName={vendor?.name ?? header?.vendorName ?? null}
                hasVendor={Boolean(vendorId)}
                jobs={jobs}
                jobsLoading={jobsLoad.loading}
                outsideOps={ops}
                outsideOpsError={opsLoad.error}
                onRetryOutsideOps={() => void opsLoad.reload()}
                takenOps={takenOps}
                onChange={(patch) => updateLine(line.key, patch)}
                onPickOp={(op) => setLines((current) => current.map((l) => (l.key === line.key ? (op ? fillFromOp(l, op) : { ...l, jobOperationId: null }) : l)))}
                onRemove={() => removeLine(line)}
                onUseOutsideLine={(op) =>
                  setLines((current) => current.map((l) => (l.key === line.key ? fillFromOp({ ...blankLine('outside_service'), key: l.key }, op) : l)))
                }
                disabled={saving}
              />
            ))}
            {lines.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                Add what you are buying: a part, outside work on a job, or anything else — tooling, a repair, freight.
              </Typography>
            )}
          </Stack>
          <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => addLine('part')} disabled={saving}>
              Part
            </Button>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => addLine('outside_service')} disabled={saving}>
              Outside service
            </Button>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => addLine('other')} disabled={saving}>
              Other
            </Button>
          </Box>
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <TextField
            label="Notes to the vendor"
            value={notesToVendor}
            onChange={(e) => setNotesToVendor(e.target.value)}
            multiline
            minRows={2}
            fullWidth
            helperText="Printed on the PO. Internal notes are on the PO's page, after it is saved."
            slotProps={{ htmlInput: { maxLength: 4000 } }}
          />
        </CardContent>
      </Card>

      {saveError != null && <ErrorAlert error={saveError} entity="purchase order" onClose={() => setSaveError(null)} sx={{ mb: 2 }} />}

      {/* Sticky footer: the total, what blocks Save, and the one Save. */}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          borderTop: 1,
          borderColor: 'divider',
          px: 2,
          py: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <MissingFieldsNotice items={blocking} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography sx={{ fontWeight: 600 }}>
            Total {formatMoney(total.total)}
            {total.unpricedLineCount > 0 ? ` + ${total.unpricedLineCount} TBC` : ''}
          </Typography>
          {header && (
            <Typography variant="body2" color="text.secondary">
              Ordered {formatDateOnly(header.orderedOn)}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <Button onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSave}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {prediction?.saveLabel ?? 'Save'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
