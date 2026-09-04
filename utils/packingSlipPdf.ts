/**
 * Generate a printable packing slip PDF for a shipment.
 *
 * Modeled on utils/quotePdf.ts. jsPDF + jspdf-autotable, same letter
 * format and margins. The PDF is generated client-side from a hydrated
 * shipment + the customer's billing address + the company profile.
 *
 * Layout (FR-8, PRD v2.1):
 *   - Header: company logo (top-left when present), company return
 *     address, PACKING SLIP title + PS# + ship date (top-right).
 *   - Bill-to (left) + Ship-to (right) blocks. Bill-to is resolved
 *     from the customer's default-billing address at render time; ship-to
 *     is the shipment.shipping_address_id snapshot. Ship-to surfaces
 *     ATTN: from customer_addresses.attention_to via resolveAttentionLine.
 *   - Line items table: Customer PO / Part / Description / Qty Ordered /
 *     Prev Shipped / Qty Shipped / Qty Remaining, so the row reconciles
 *     on its face: ordered − prev − shipped = remaining. Two columns are
 *     conditional — Prev Shipped appears only once some line has a
 *     prior shipment, Qty Remaining only while some line is still open —
 *     and when a column is present every cell shows its number, 0
 *     included, never blanked. There is no Job # column: every slip is a
 *     single job (shipments.job_id) and the number is in the meta block.
 *   - Shipment details block: shipping method label + carrier (carrier
 *     only present when the method is a true shipment), notes.
 *   - Signature lines at the bottom: Received By / Date / Signature.
 *
 * Voided shipments render the same content with a "VOIDED" watermark
 * banner — Phase 3 surfaces this; Phase 1 never reaches the void path.
 */

import { jsPDF } from 'jspdf';
import autoTable, { type Styles } from 'jspdf-autotable';
import type { Company } from '@/utils/companyAccess';
import type { AddressSnapshot } from '@/types/documentSnapshot';
import {
  SHIPPING_METHOD_LABELS,
  describeHeatNumbers,
  describeShipmentFreight,
  type ShipmentWithRelations,
} from '@/types/shipment';
import { resolveAttentionLine } from '@/utils/shipmentsAccess';
import { readLogoIncludesName } from '@/lib/companyDefaults';

const MARGIN = 40;
const ADDRESS_COMBINE_MAX_CHARS = 50;

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // ship_date is stored as a date scalar (YYYY-MM-DD). Parse the parts
  // directly so US-Pacific viewers don't see "1 day earlier" because of
  // UTC-midnight reinterpretation.
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (ymd) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatNumber(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}

export interface PackingSlipQtyLine {
  jobPartId: string;
  qtyOrdered: number;
  qtyShippedThisSlip: number;
}

export interface PackingSlipQtyRow {
  qtyOrdered: number;
  qtyPrevShipped: number;
  /** This line's own quantity — not the job_part's total on the slip. */
  qtyShipped: number;
  qtyRemaining: number;
}

/**
 * The slip's quantity block: what was ordered, what went out before,
 * what goes out on this slip, and what is still open after it.
 *
 *   remaining = ordered − prev shipped − this slip, clamped at zero.
 *
 * Clamped because over-shipment is allowed (the FR-4 soft warning
 * confirms it upstream) and "−5 remaining" is not something a receiving
 * dock can act on.
 *
 * `thisSlipCounts` is false for a voided slip: a void removes that
 * shipment's quantity, so its lines still print their Qty Shipped under
 * the VOIDED banner while Qty Remaining reports what is genuinely owed.
 *
 * Grouped by job_part, not by line. shipment_line_items has no unique
 * constraint on (shipment_id, job_part_id), so one job_part can legally
 * appear on two rows of one slip; per-line math would subtract only
 * half the slip and overstate the remaining on both rows.
 */
export function computePackingSlipQuantities(
  lines: readonly PackingSlipQtyLine[],
  shippedBeforeByJobPart: ReadonlyMap<string, number>,
  thisSlipCounts: boolean,
): PackingSlipQtyRow[] {
  // quantity is numeric(12,2); round after each accumulation so binary
  // float drift can't print 9.999999999999998 as "10".
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const num = (n: number) => (Number.isFinite(n) ? n : 0);

  const thisSlipByPart = new Map<string, number>();
  for (const line of lines) {
    thisSlipByPart.set(
      line.jobPartId,
      round2((thisSlipByPart.get(line.jobPartId) ?? 0) + num(line.qtyShippedThisSlip)),
    );
  }

  return lines.map((line) => {
    const ordered = num(line.qtyOrdered);
    const prev = Math.max(0, num(shippedBeforeByJobPart.get(line.jobPartId) ?? 0));
    const onThisSlip = thisSlipCounts ? (thisSlipByPart.get(line.jobPartId) ?? 0) : 0;
    return {
      qtyOrdered: ordered,
      qtyPrevShipped: prev,
      qtyShipped: num(line.qtyShippedThisSlip),
      qtyRemaining: Math.max(0, round2(ordered - prev - onThisSlip)),
    };
  });
}

export function buildShopHeaderLines(company: Company): string[] {
  const lines: string[] = [];
  const a1 = company.address_line1?.trim();
  const a2 = company.address_line2?.trim();
  if (a1 && a2) {
    const combined = `${a1}, ${a2}`;
    if (combined.length <= ADDRESS_COMBINE_MAX_CHARS) {
      lines.push(combined);
    } else {
      lines.push(a1);
      lines.push(a2);
    }
  } else if (a1) {
    lines.push(a1);
  } else if (a2) {
    lines.push(a2);
  }

  const cityStateZip = [company.city, company.state].filter(Boolean).join(', ');
  const cityStateZipFull = [cityStateZip, company.postal_code]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (company.country && company.country.toUpperCase() !== 'USA') {
    lines.push(company.country);
  }
  if (company.phone) lines.push(company.phone);

  return lines;
}

function buildAddressBlockLines(
  customerName: string | null | undefined,
  address: AddressSnapshot | null,
  attentionText: string | null,
): string[] {
  const lines: string[] = [];
  if (customerName) lines.push(customerName);
  if (attentionText) lines.push(`Attn: ${attentionText}`);
  if (address) {
    if (address.address_line1) lines.push(address.address_line1);
    if (address.address_line2) lines.push(address.address_line2);
    const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
    const cityStateZipFull = [cityStateZip, address.postal_code]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (cityStateZipFull) lines.push(cityStateZipFull);
    if (address.country && address.country.toUpperCase() !== 'USA') {
      lines.push(address.country);
    }
  }
  if (lines.length === 0) lines.push('(No address on file)');
  return lines;
}

/**
 * Filename used both when downloading and when surfacing in dialogs.
 */
export function packingSlipPdfFilename(shipment: Pick<ShipmentWithRelations, 'packing_slip_number'>): string {
  return `PackingSlip-${shipment.packing_slip_number}.pdf`;
}

/**
 * Where a document came from, in the two forms our three documents need.
 *
 * Both are built from `ATTRIBUTION_SUFFIX` so the words "jigged.app" exist once. Three generators
 * printing three hand-copied strings is how you end up with "with jigged.app", "via jigged.app" and
 * "by Jigged" on three pieces of paper from the same shop.
 *
 * It is metadata at footer weight — same size, same grey, same row as the page number — never a
 * badge and never a logo. Unconditional and unconfigurable: there is no setting, so there is no
 * state to read at print time and nothing that can disagree with itself.
 */
const ATTRIBUTION_SUFFIX = 'with jigged.app';

/**
 * The dated form, for a document whose footer has a **left slot of its own** — the packing slip and
 * the job traveler. On the slip it replaced `Generated {date} · {company}`: the company name is
 * already the largest thing in the header, so the footer was restating it, and the date was the
 * half worth keeping.
 */
export function attributionLine(): string {
  return `Generated ${formatDate(new Date().toISOString())} ${ATTRIBUTION_SUFFIX}`;
}

/**
 * The undated form, for a footer that is **already carrying something** — the quote, whose left
 * slot holds the preparer credit, so this rides on the right ahead of the page number.
 *
 * **No date, and that is not just to save width.** A quote already prints `Date:` in its header
 * meta block, a few inches above; a second date in the footer is the same fact stated twice, and
 * the two are not even the same fact — the header date is when the quote was *issued*, this one is
 * when the PDF was *rendered*. On a re-download months later they disagree, and a customer reading
 * two different dates on one page has no way to know which one their price is good from.
 */
export const ATTRIBUTION_MARK = `Generated ${ATTRIBUTION_SUFFIX}`;

/** The box a company logo is fitted into, in points. Square, but the logo need not be. */
export const LOGO_BOX = 56;

/**
 * The minimum a jsPDF document must expose to have a logo drawn into it. Keeps this testable
 * without a real jsPDF, and `compression` mirrors jsPDF's own union so a real document satisfies
 * this structurally.
 */
export interface LogoDrawTarget {
  getImageProperties: (data: string) => { width: number; height: number; fileType: string };
  addImage: (
    data: string,
    format: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: string,
    compression?: 'NONE' | 'FAST' | 'MEDIUM' | 'SLOW',
  ) => void;
}

/**
 * Draw a company logo fitted inside `LOGO_BOX`, and return the width it actually occupied.
 *
 * **Aspect is preserved.** Both generators used to pass a 56×56 square regardless of the source,
 * which squashed every wordmark — the common case, since a shop's logo is usually wider than it is
 * tall. `getImageProperties` also supplies the real format, so a JPEG renders instead of being
 * declared 'PNG' and failing into a silent catch.
 *
 * Returns 0 and draws nothing on any failure; the caller falls back to the company name in bold,
 * which is the layout that has been shipping all along.
 *
 * Kept for callers that want a logo in a fixed box. The document headers use
 * `drawShopHeaderBlock` instead, which sizes the logo against the space the header already has.
 */
export function drawCompanyLogo(
  doc: LogoDrawTarget,
  dataUrl: string,
  x: number,
  y: number,
  box: number = LOGO_BOX,
): number {
  try {
    const props = doc.getImageProperties(dataUrl);
    if (!props?.width || !props?.height) return 0;
    const scale = Math.min(box / props.width, box / props.height);
    const w = props.width * scale;
    const h = props.height * scale;
    // Vertically centred in the box so a wide wordmark sits on the same optical line as the company
    // name beside it rather than clinging to the top of the header.
    doc.addImage(dataUrl, props.fileType, x, y + (box - h) / 2, w, h, undefined, 'FAST');
    return w;
  } catch {
    return 0;
  }
}

// ─────────────────────────── The shop header block ───────────────────────────

/**
 * Gap between the logo and the text stacked beneath it.
 *
 * **6, not 12.** The address under a mark is part of the same lockup and should read as one block;
 * the text's own leading already adds ~10pt below this, so 12 put roughly 15pt of white between the
 * logo's last pixel and the top of the address — more than a full line of 9.5pt type, which reads
 * as two separate things that happen to be stacked. Tightening it also hands the difference back to
 * the logo, since the budget it comes out of is the same one the logo is sized against.
 */
const SHOP_LOGO_GAP = 6;

/**
 * Ceilings on the drawn logo.
 *
 * The height cap matters more than it looks: the budget is whatever the *right* column reaches, and
 * the traveler's right column can be short. Without a cap, a document with a sparse right column
 * would print a bigger logo than one with a full one — the same shop's paperwork disagreeing with
 * itself about how big its own mark is. The width cap keeps a very wide logo out of the right
 * column on a narrow header.
 */
const SHOP_LOGO_MAX_H = 62;
const SHOP_LOGO_MAX_W = 190;

/** Leading for the address lines under the logo, and for the optional name above them. */
const SHOP_LINE_H = 12;
const SHOP_NAME_H = 16;

export interface ShopHeaderOptions {
  company: Company;
  /** Already-resolved logo image, or null. */
  logoDataUrl: string | null;
  /** From `readLogoIncludesName` — when true the company name is NOT set as text. */
  logoIncludesName: boolean;
  x: number;
  y: number;
  /**
   * The y the *right-hand* column of this header reaches.
   *
   * This is the whole trick. A document header is as tall as its tallest column, and on all three
   * documents that is the right one — the meta block, or the traveler's QR. Every point between the
   * top of the page and that line is vertical space the document is **already paying for**, so a
   * logo drawn into it is free. Callers must therefore measure their right column *before* calling
   * this, which is why each generator computes its meta bottom up front.
   */
  availableBottom: number;
  /** Font size for the company name when it is printed. */
  nameSize?: number;
}

/**
 * Draw the shop's identity block — logo, then the company name (unless the logo already says it),
 * then the address — and return the y it reached.
 *
 * ## Why stacked rather than side by side
 *
 * A shop owner reviewing this preferred the address beneath the mark to the address beside it. That
 * is a taste call and it is theirs; both fit the budget. It does cost logo size — the text under the
 * logo eats budget the logo would otherwise have — which is exactly why the `logoIncludesName`
 * question earns its keep: answering it "yes" removes a line of text and hands the logo the space
 * back. On a 1.44:1 wordmark that is 78pt wide against 89pt.
 *
 * ## What it will not do
 *
 * It will not grow past `SHOP_LOGO_MAX_H`, and it will not return a bottom above `y` — a document
 * with no logo and no address still reports where the name ended. If the logo fails to draw, the
 * text renders exactly as it would have without one, which is the layout that shipped for months.
 */
export function drawShopHeaderBlock(
  doc: LogoDrawTarget & {
    setFont: (f: string, s: string) => void;
    setFontSize: (n: number) => void;
    setTextColor: (r: number, g?: number, b?: number) => void;
    text: (t: string, x: number, y: number) => void;
  },
  {
    company,
    logoDataUrl,
    logoIncludesName,
    x,
    y,
    availableBottom,
    nameSize = 13,
  }: ShopHeaderOptions,
): number {
  const shopLines = buildShopHeaderLines(company);

  /**
   * **The name is suppressed only if a logo actually carries it.**
   *
   * `logoIncludesName` is a statement about the *logo*, so it means nothing when there is no logo —
   * and honouring it anyway prints a document with no company name on it at all, which is the one
   * outcome this whole setting exists to avoid. A shop can easily reach that state: tick the box,
   * then remove the logo.
   *
   * Decided up front from whether a logo will be *attempted*, because the text's height sets the
   * logo's budget. If the attempt then fails, the name is restored below — safe, because a failed
   * logo hands its entire budget back to the text.
   */
  const hasLogo = Boolean(logoDataUrl);
  let showName = !logoIncludesName || !hasLogo;

  // What the text under the logo will occupy, so the logo can be given the remainder.
  const textHeight = (showName ? SHOP_NAME_H : 0) + shopLines.length * SHOP_LINE_H;

  let logoBottom = y;
  let logoDrawn = false;
  if (logoDataUrl) {
    try {
      const props = doc.getImageProperties(logoDataUrl);
      if (props?.width && props?.height) {
        const budget = availableBottom - y - SHOP_LOGO_GAP - textHeight;
        const maxH = Math.min(SHOP_LOGO_MAX_H, budget);
        if (maxH > 0) {
          const ratio = props.width / props.height;
          const h = Math.min(maxH, SHOP_LOGO_MAX_W / ratio);
          const w = h * ratio;
          doc.addImage(logoDataUrl, props.fileType, x, y, w, h, undefined, 'FAST');
          logoBottom = y + h + SHOP_LOGO_GAP;
          logoDrawn = true;
        }
      }
    } catch {
      // A logo must never break a document. Fall through and print the text where it would have
      // gone anyway.
    }
  }

  // The logo we were counting on to carry the name did not render — an unreadable file, or a header
  // too short to hold it. Print the name rather than ship an unnamed document. Nothing overflows:
  // the space the logo would have taken is now free.
  if (!logoDrawn) showName = true;

  let ty = logoBottom;
  if (showName) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(nameSize);
    doc.setTextColor(30);
    ty += nameSize;
    doc.text(company.name, x, ty);
    ty += SHOP_NAME_H - nameSize;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(95);
  shopLines.forEach((line, i) => {
    doc.text(line, x, ty + 10 + i * SHOP_LINE_H);
  });

  return shopLines.length ? ty + 10 + (shopLines.length - 1) * SHOP_LINE_H : ty;
}

/**
 * Pull the company logo as a base64 image so jsPDF can embed it. Skips
 * silently on any failure — the layout falls back to the company name
 * in plain bold text (mirrors the quote PDF).
 */
export async function loadLogoAsDataUrl(
  logoPath: string | null | undefined,
  supabaseClient: SupabaseLike | null,
): Promise<string | null> {
  if (!logoPath || !supabaseClient) return null;
  try {
    const { data, error } = await supabaseClient.storage
      .from('logos')
      .createSignedUrl(logoPath, 60);
    if (error || !data?.signedUrl) return null;
    const resp = await fetch(data.signedUrl);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string) ?? null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface SupabaseLike {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (path: string, expiresIn: number) => Promise<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface PackingSlipPdfContext {
  shipment: ShipmentWithRelations;
  company: Company;
  /**
   * Quantity shipped per job_part on the slips issued before this one —
   * from getShippedBeforeShipment(). Required, and deliberately not
   * defaulted to an empty map: silently treating "not supplied" as "no
   * prior shipments" is what made slip #2 of a 40-piece job claim 30
   * remaining when 30 had already gone out.
   */
  shippedBeforeByJobPart: ReadonlyMap<string, number>;
  /** Optional Supabase client to resolve the logo signed URL. */
  supabase?: SupabaseLike | null;
}

/**
 * Fixed column widths, in points. Letter page less two 40pt margins
 * leaves 532pt; Description is the only 'auto' column and absorbs
 * whatever the fixed ones don't take — 250 / 200 / 190 / 140pt across
 * the four visibility permutations. The 140pt worst case is ~24
 * characters a line at 10pt, and is what decides whether another column
 * can ever be added here.
 *
 * The identifier columns are sized by their *content*, not by taste:
 * `part` holds "PROD-ACTUATOR-200" and `po` holds "PO-CAS-2207" on one
 * line, because a part number broken mid-token ("PROD-ACTUATO/R-200")
 * is what a receiving clerk has to retype. The numeric columns fit
 * their headers only because the header row drops to 9pt — at 10pt
 * "Remaining" wraps mid-word to "Remai/ning".
 */
const SLIP_COL_WIDTH = {
  po: 78,
  part: 104,
  ordered: 50,
  prevShipped: 50,
  shipped: 50,
  remaining: 60,
} as const;

interface SlipRowData {
  po: string;
  partName: string;
  description: string;
  qty: PackingSlipQtyRow;
}

interface SlipColumnSpec {
  key: 'po' | 'part' | 'description' | 'ordered' | 'prevShipped' | 'shipped' | 'remaining';
  header: string;
  style: Partial<Styles>;
  cell: (row: SlipRowData) => string;
  /** Cell used by the single placeholder row when the slip has no lines. */
  placeholder: string;
}

/**
 * One declarative spec drives the header, the body, the placeholder row
 * and columnStyles, so the four visibility permutations cannot drift out
 * of alignment — the previous version hand-maintained two index→width
 * maps and a separate placeholder row, and the placeholder was already
 * one cell short whenever Qty Remaining showed.
 */
const SLIP_COLUMNS: readonly SlipColumnSpec[] = [
  {
    key: 'po',
    header: 'Customer PO',
    style: { cellWidth: SLIP_COL_WIDTH.po },
    cell: (r) => r.po || '—',
    placeholder: '—',
  },
  {
    key: 'part',
    header: 'Part',
    style: { cellWidth: SLIP_COL_WIDTH.part, fontStyle: 'bold' },
    cell: (r) => r.partName,
    placeholder: '—',
  },
  {
    key: 'description',
    header: 'Description',
    style: { cellWidth: 'auto' },
    cell: (r) => r.description,
    placeholder: '',
  },
  {
    key: 'ordered',
    header: 'Qty Ordered',
    style: { cellWidth: SLIP_COL_WIDTH.ordered, halign: 'right' },
    cell: (r) => formatNumber(r.qty.qtyOrdered),
    placeholder: '—',
  },
  {
    key: 'prevShipped',
    header: 'Prev Shipped',
    style: { cellWidth: SLIP_COL_WIDTH.prevShipped, halign: 'right' },
    cell: (r) => formatNumber(r.qty.qtyPrevShipped),
    placeholder: '—',
  },
  {
    key: 'shipped',
    header: 'Qty Shipped',
    style: { cellWidth: SLIP_COL_WIDTH.shipped, halign: 'right' },
    cell: (r) => formatNumber(r.qty.qtyShipped),
    placeholder: '—',
  },
  {
    key: 'remaining',
    header: 'Qty Remaining',
    style: { cellWidth: SLIP_COL_WIDTH.remaining, halign: 'right' },
    cell: (r) => formatNumber(r.qty.qtyRemaining),
    placeholder: '—',
  },
];

/**
 * Build the jsPDF document for a shipment and return it without writing
 * to disk. Caller chooses how to consume:
 *   - doc.save(filename)              → download
 *   - doc.output('bloburl') as string → preview iframe src
 *   - doc.output('blob')              → Blob for upload
 */
export async function generatePackingSlipPdf(
  ctx: PackingSlipPdfContext,
): Promise<jsPDF> {
  const { shipment, company } = ctx;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ---------- Header ----------
  const headerTop = MARGIN;

  /**
   * The RIGHT column is measured first, because it sets the header's height and therefore the
   * vertical space the logo may occupy for free. Drawing the left column first — which is what this
   * did for months — means sizing the logo with no idea how much room the header already has, and a
   * 56pt box was the result.
   *
   * Bottom row is the last meta line, which is the Job(s) row when there is one and Ship Date
   * otherwise.
   */
  const jobNumbers = Array.from(
    new Set(
      (shipment.shipment_line_items ?? [])
        .map((li) => li.job_part?.job?.job_number)
        .filter((n): n is string => Boolean(n)),
    ),
  );
  const metaBlockBottom = headerTop + (jobNumbers.length > 0 ? 68 : 54);

  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, ctx.supabase ?? null);
  const shopBlockBottom = drawShopHeaderBlock(doc, {
    company,
    logoDataUrl,
    logoIncludesName: readLogoIncludesName(company),
    x: MARGIN,
    y: headerTop,
    availableBottom: metaBlockBottom,
    nameSize: 14,
  });

  // Top-right title + meta
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(30);
  doc.text('PACKING SLIP', pageWidth - MARGIN, headerTop + 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(
    `Packing Slip #: ${shipment.packing_slip_number}`,
    pageWidth - MARGIN,
    headerTop + 40,
    { align: 'right' },
  );
  doc.text(
    `Ship Date: ${formatDate(shipment.ship_date)}`,
    pageWidth - MARGIN,
    headerTop + 54,
    { align: 'right' },
  );

  // Surface job # context — packing slip rolls up by job_part, so list distinct job numbers in the
  // meta block to keep receiving anchored. The set itself is computed above the header, because its
  // presence decides the header's height and therefore how much room the logo gets.
  if (jobNumbers.length > 0) {
    doc.text(
      `Job${jobNumbers.length > 1 ? 's' : ''}: ${jobNumbers.join(', ')}`,
      pageWidth - MARGIN,
      headerTop + 68,
      { align: 'right' },
    );
  }

  let cursorY = Math.max(shopBlockBottom, metaBlockBottom) + 18;

  // ---------- VOIDED banner ----------
  if (shipment.voided_at) {
    const bandHeight = 26;
    doc.setFillColor(250, 230, 230);
    doc.rect(MARGIN, cursorY, pageWidth - MARGIN * 2, bandHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(180, 40, 40);
    doc.text(
      `VOIDED ${formatDate(shipment.voided_at)} — KEEP FOR RECORDS`,
      pageWidth / 2,
      cursorY + bandHeight / 2 + 4,
      { align: 'center' },
    );
    cursorY += bandHeight + 8;
  }

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- BILL TO (left) + SHIP TO (right) ----------
  // Bill-to resolves to the customer's default-billing customer_addresses
  // row at render time. Ship-to is the shipment.shipping_address_id
  // snapshot. ATTN: on the ship-to side surfaces from the address row.
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colWidth + 8;

  // Render the frozen snapshots captured on the shipment at issue time
  // (Document Snapshot Standard — snapshot_shipment_party trigger), not the live
  // address rows, so the slip is unchanged after the master address edits/deletes.
  const attention = resolveAttentionLine(shipment);
  const shipLines = buildAddressBlockLines(
    shipment.customer_name,
    shipment.ship_to_address,
    attention.text,
  );

  const billLines = buildAddressBlockLines(
    shipment.customer_name,
    shipment.bill_to_address,
    null,
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('BILL TO', leftX, cursorY);
  doc.text('SHIP TO', rightX, cursorY);

  // Left: bill-to address (same renderer as ship-to so the two columns
  // visually balance).
  billLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text(line, leftX, cursorY + 16 + i * 13);
  });

  // Right: ship-to address.
  shipLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text(line, rightX, cursorY + 16 + i * 13);
  });

  const blockLines = Math.max(billLines.length, shipLines.length);
  cursorY = cursorY + 16 + blockLines * 13 + 18;

  // ---------- Line items table ----------
  const lineItems = [...(shipment.shipment_line_items ?? [])];
  // One slip is one job (shipments.job_id), so part name is the only
  // ordering that carries information.
  lineItems.sort((a, b) =>
    (a.job_part?.part?.part_name ?? '').localeCompare(b.job_part?.part?.part_name ?? ''),
  );

  const quantities = computePackingSlipQuantities(
    lineItems.map((li) => ({
      jobPartId: li.job_part_id,
      qtyOrdered: Number(li.job_part?.quantity ?? 0),
      qtyShippedThisSlip: Number(li.quantity),
    })),
    ctx.shippedBeforeByJobPart,
    !shipment.voided_at,
  );

  // Prev Shipped only earns its width once something went out earlier;
  // Qty Remaining only while something is still open — a slip that
  // closes the order out prints a clean "everything shipped" table.
  const showPrevShipped = quantities.some((q) => q.qtyPrevShipped > 0);
  const showRemaining = quantities.some((q) => q.qtyRemaining > 0);

  const columns = SLIP_COLUMNS.filter((c) =>
    c.key === 'prevShipped' ? showPrevShipped : c.key === 'remaining' ? showRemaining : true,
  );

  const rows: SlipRowData[] = lineItems.map((li, idx) => ({
    po: li.job_part?.job?.customer_po_number ?? '',
    partName: li.job_part?.part?.part_name ?? '—',
    description: li.job_part?.part?.description?.trim() ?? '',
    qty: quantities[idx],
  }));

  const head = [columns.map((c) => c.header)];
  // Every cell in a present column shows its number, 0 included —
  // blanking a zero reads as "unknown" on a receiving dock.
  const body =
    rows.length > 0
      ? rows.map((row) => columns.map((c) => c.cell(row)))
      : [columns.map((c) => c.placeholder)];
  const columnStyles: Record<string, Partial<Styles>> = Object.fromEntries(
    columns.map((c, i) => [String(i), c.style]),
  );

  autoTable(doc, {
    startY: cursorY,
    margin: { left: MARGIN, right: MARGIN },
    head,
    body,
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: 7,
      textColor: [40, 40, 40],
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      // 9pt, not the body's 10: four numeric headers have to fit their
      // own column, and "Remaining" wraps mid-word at 10pt.
      fontSize: 9,
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles,
    theme: 'grid',
  });

  cursorY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ??
    cursorY + 60;
  cursorY += 18;

  // ---------- Shipment details ----------
  const methodLabel = shipment.shipping_method
    ? SHIPPING_METHOD_LABELS[shipment.shipping_method]
    : null;

  const details: Array<[string, string]> = [];
  if (methodLabel) details.push(['Shipping Method', methodLabel]);
  if (shipment.carrier) details.push(['Carrier', shipment.carrier]);
  // Freight, rendered from the FROZEN snapshot rather than the live account —
  // this slip must still say what it said a year from now, even if the account
  // is edited or archived (Document Snapshot Standard).
  //
  // REDACTED BY CONSTRUCTION: the snapshot only ever holds the last 4, because
  // this page rides in the box past carriers, docks and whoever opens the
  // carton. `has_account` is what distinguishes "billed to their account" from
  // "billed on the bill of lading" when nothing can be revealed — an account of
  // 4 characters or fewer has no last-4, since showing 3 of 4 is not redaction.
  const freightLine = describeShipmentFreight(shipment);
  if (freightLine) details.push(['Freight', freightLine]);
  // Material heat numbers, also from a FROZEN snapshot: the slip in a customer's hands must keep
  // saying what it said even after the office corrects a typo on the ledger (void and reissue is
  // the path to a different slip). Omitted entirely when nothing was recorded — most shops do not
  // track heats, and a blank line reads as a missing value on a receiving dock. One job per part
  // since #812, so this is per shipped part for every job made from a quote; a legacy multi-part
  // job prints the same set once. A details line, not a table column: the fixed widths above
  // leave Description 140pt at worst, and that is what decides whether a column can ever be added.
  const heatLine = describeHeatNumbers(shipment);
  if (heatLine) details.push(['Material heat no(s).', heatLine]);

  if (details.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('SHIPMENT DETAILS', MARGIN, cursorY);
    cursorY += 14;

    doc.setFontSize(11);
    details.forEach(([label, value]) => {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(`${label}:`, MARGIN, cursorY);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(40);
      const wrapped = doc.splitTextToSize(value, pageWidth - MARGIN * 2 - 130);
      doc.text(wrapped, MARGIN + 130, cursorY);
      cursorY += Math.max(14, wrapped.length * 13);
    });
    cursorY += 6;
  }

  // ---------- Signature lines ----------
  const sigBlockHeight = 56;
  if (cursorY + sigBlockHeight > pageHeight - MARGIN - 30) {
    doc.addPage();
    cursorY = MARGIN;
  } else {
    cursorY += 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('RECEIVED BY', MARGIN, cursorY);
  cursorY += 28;

  doc.setDrawColor(160);
  doc.setLineWidth(0.5);
  const sigLineY = cursorY + 8;
  doc.line(MARGIN, sigLineY, MARGIN + 240, sigLineY);
  doc.line(MARGIN + 270, sigLineY, MARGIN + 430, sigLineY);
  doc.line(MARGIN + 460, sigLineY, pageWidth - MARGIN, sigLineY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Signature', MARGIN, sigLineY + 11);
  doc.text('Print Name', MARGIN + 270, sigLineY + 11);
  doc.text('Date', MARGIN + 460, sigLineY + 11);

  // ---------- Footer (every page) ----------
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const footerY = pageHeight - MARGIN;
    doc.setDrawColor(230);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, footerY - 14, pageWidth - MARGIN, footerY - 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(attributionLine(), MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
