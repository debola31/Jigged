/**
 * Purchasing numbering and printed terms — the Purchasing hub's settings dialog (plan §3.2
 * "Numbering and settings", criterion N2). Any office user may change them, not only admins.
 *
 * The one writer is `save_purchasing_document_settings`; the browser can only read
 * `purchasing_document_series`. A company has no row until its first PO or RFQ (or first save), and
 * the defaults it then gets are the contract — PO-0001, RFQ-0001 (lib/purchasing/numbering.ts) —
 * which is what this reads back for a series that has no row yet.
 */
import { z } from 'zod';

import { getSupabase } from '@/lib/supabase';
import {
  DEFAULT_PURCHASING_SERIES,
  formatPurchasingDocumentNumber,
  validatePurchasingNumbering,
  type PurchasingDocumentKind,
} from '@/lib/purchasing/numbering';
import { parsePurchasingResult, purchasingReadFailure, purchasingRpcFailure } from '@/utils/purchasingShared';

export type { PurchasingDocumentKind };

export interface PurchasingSeriesSettings {
  kind: PurchasingDocumentKind;
  prefix: string;
  nextNumber: number;
  minDigits: number;
  termsAndConditions: string | null;
  /** The number the next document will get, as the mint would format it. */
  nextNumberPreview: string;
  /** No row yet: these are the defaults the first document will create. */
  isDefault: boolean;
}

export type PurchasingSeries = Record<PurchasingDocumentKind, PurchasingSeriesSettings>;

/** Both series for a company: PO numbering and terms, and the RFQ terms (RFQs keep RFQ-). */
export async function getPurchasingSeries(companyId: string): Promise<PurchasingSeries> {
  const { data, error } = await getSupabase()
    .from('purchasing_document_series')
    .select('document_kind, prefix, next_number, min_digits, terms_and_conditions')
    .eq('company_id', companyId);
  if (error) throw purchasingReadFailure(error, 'load the purchasing settings', 'purchasing settings');

  const settingsFor = (kind: PurchasingDocumentKind): PurchasingSeriesSettings => {
    const row = (data ?? []).find((r) => r.document_kind === kind);
    const fallback = DEFAULT_PURCHASING_SERIES[kind];
    const prefix = row?.prefix ?? fallback.prefix;
    const nextNumber = row ? Number(row.next_number) : fallback.nextNumber;
    const minDigits = row ? Number(row.min_digits) : fallback.minDigits;
    return {
      kind,
      prefix,
      nextNumber,
      minDigits,
      termsAndConditions: row?.terms_and_conditions ?? null,
      nextNumberPreview: formatPurchasingDocumentNumber(prefix, nextNumber, minDigits),
      isDefault: !row,
    };
  };
  return { vendor_purchase_order: settingsFor('vendor_purchase_order'), vendor_rfq: settingsFor('vendor_rfq') };
}

export interface SavePurchasingSettingsInput {
  /** PO numbering, as a whole (RFQs always use the RFQ- series and refuse this). */
  numbering?: { prefix: string; nextNumber: number; minDigits: number };
  /** Printed on each NEW document of this kind; null or blank clears them. */
  termsAndConditions?: string | null;
}

const saveResultSchema = z
  .object({
    document_kind: z.enum(['vendor_purchase_order', 'vendor_rfq']),
    prefix: z.string(),
    next_number: z.number(),
    min_digits: z.number(),
    terms_and_conditions: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    next_number_preview: z.string(),
  })
  .transform(
    (r): PurchasingSeriesSettings => ({
      kind: r.document_kind,
      prefix: r.prefix,
      nextNumber: r.next_number,
      minDigits: r.min_digits,
      termsAndConditions: r.terms_and_conditions,
      nextNumberPreview: r.next_number_preview,
      isDefault: false,
    }),
  );

/**
 * Save the numbering and/or terms for one kind (`save_purchasing_document_settings`). Numbering is
 * checked first with the dialog's own rules (prefix shape, 11 characters for a PO); the database
 * also refuses a next number at or below one already issued under the prefix.
 */
export async function savePurchasingSettings(
  companyId: string,
  kind: PurchasingDocumentKind,
  input: SavePurchasingSettingsInput,
): Promise<PurchasingSeriesSettings> {
  const changes: Record<string, string | number | null> = {};
  if (input.numbering) {
    if (kind === 'vendor_rfq') {
      throw new Error('RFQ numbers always use the RFQ- series. Only their terms and conditions can change.');
    }
    const errors = validatePurchasingNumbering({ kind, ...input.numbering });
    const first = errors.prefix ?? errors.minDigits ?? errors.nextNumber;
    if (first) throw new Error(first);
    changes.prefix = input.numbering.prefix;
    changes.next_number = input.numbering.nextNumber;
    changes.min_digits = input.numbering.minDigits;
  }
  if (input.termsAndConditions !== undefined) changes.terms_and_conditions = input.termsAndConditions;

  const { data, error } = await getSupabase().rpc('save_purchasing_document_settings', {
    p_company_id: companyId,
    p_kind: kind,
    p_changes: changes,
  });
  if (error) throw purchasingRpcFailure(error, 'save the purchasing settings', 'purchasing settings');
  return parsePurchasingResult(saveResultSchema, data, 'save the purchasing settings');
}
