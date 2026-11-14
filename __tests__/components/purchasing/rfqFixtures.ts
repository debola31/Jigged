/**
 * One RFQ, as `getVendorRfq` returns it, for the RFQ component suites.
 *
 * Two lines (a bar part at 10 and 25 bars, and an ad-hoc "Deburring brushes" line at 50 each) sent
 * to two vendors. Acme quoted both bar quantities; Beta quoted the bar line cheaper at 10 but its
 * quote has EXPIRED, and it said No bid on the brushes. The comparison is built by the real
 * `compareVendorRfq`, so the matrix suite sees exactly what the page would.
 */
import { compareVendorRfq } from '@/utils/vendorRfqAccess';
import type {
  VendorRfqDetail,
  VendorRfqInvitation,
  VendorRfqLine,
  VendorRfqResponse,
} from '@/types/vendorRfq';

export const TODAY = '2026-11-09';

export const LINES: VendorRfqLine[] = [
  {
    id: 'line-bar',
    lineNumber: 1,
    partId: 'part-bar',
    partName: 'BAR-6061',
    description: '6061-T6 round bar',
    unit: 'bar',
    quantities: [10, 25],
    jobId: null,
    jobNumber: null,
    certRequired: true,
    notes: null,
  },
  {
    id: 'line-brush',
    lineNumber: 2,
    partId: null,
    partName: null,
    description: 'Deburring brushes',
    unit: 'each',
    quantities: [50],
    jobId: null,
    jobNumber: null,
    certRequired: false,
    notes: null,
  },
];

export const INVITATIONS: VendorRfqInvitation[] = [
  {
    id: 'inv-acme',
    vendorId: 'v-acme',
    vendorName: 'Acme Steel',
    vendorContactId: 'c-1',
    vendorContact: { name: 'Jane Buyer', email: 'jane@acme.test', phone: '555-0101' },
    sentAt: '2026-11-08T15:00:00Z',
    declinedAt: null,
    declinedReason: null,
    vendorQuoteReference: 'Q-1001',
    quotedOn: '2026-11-08',
  },
  {
    id: 'inv-beta',
    vendorId: 'v-beta',
    vendorName: 'Beta Metals',
    vendorContactId: null,
    vendorContact: null,
    sentAt: null,
    declinedAt: null,
    declinedReason: null,
    vendorQuoteReference: null,
    quotedOn: null,
  },
];

export function response(over: Partial<VendorRfqResponse> & Pick<VendorRfqResponse, 'id' | 'invitationId' | 'lineId' | 'quantity'>): VendorRfqResponse {
  return {
    unitPrice: null,
    noBid: false,
    leadTimeDays: null,
    minimumOrderQuantity: null,
    validUntil: null,
    vendorPartNumber: null,
    notes: null,
    awardedAt: null,
    vendorPurchaseOrderLineId: null,
    ...over,
  };
}

export const RESPONSES: VendorRfqResponse[] = [
  response({ id: 'r-acme-10', invitationId: 'inv-acme', lineId: 'line-bar', quantity: 10, unitPrice: 60, leadTimeDays: 5, validUntil: '2026-12-31', vendorPartNumber: 'ACME-61' }),
  response({ id: 'r-acme-25', invitationId: 'inv-acme', lineId: 'line-bar', quantity: 25, unitPrice: 55, leadTimeDays: 5, validUntil: '2026-12-31', vendorPartNumber: 'ACME-61' }),
  response({ id: 'r-acme-brush', invitationId: 'inv-acme', lineId: 'line-brush', quantity: 50, unitPrice: 2.5, leadTimeDays: 3 }),
  // Cheaper, but expired yesterday: never "Lowest".
  response({ id: 'r-beta-10', invitationId: 'inv-beta', lineId: 'line-bar', quantity: 10, unitPrice: 50, leadTimeDays: 10, validUntil: '2026-11-08' }),
  response({ id: 'r-beta-brush', invitationId: 'inv-beta', lineId: 'line-brush', quantity: 50, noBid: true }),
];

export function rfqDetail(over: {
  header?: Partial<VendorRfqDetail['header']>;
  lines?: VendorRfqLine[];
  invitations?: VendorRfqInvitation[];
  responses?: VendorRfqResponse[];
  status?: VendorRfqDetail['status'];
} = {}): VendorRfqDetail {
  const lines = over.lines ?? LINES;
  const invitations = over.invitations ?? INVITATIONS;
  const responses = over.responses ?? RESPONSES;
  const base = {
    header: {
      id: 'rfq-1',
      companyId: 'test-company-id',
      rfqNumber: 'RFQ-0007',
      title: 'Bar stock for the Q1 run',
      neededByOn: '2026-12-01',
      respondByOn: '2026-11-20',
      notesToVendors: 'Mill certs, please.',
      internalNotes: 'Push Acme on lead time.',
      shipToName: 'Contour Tool & Machine',
      shipToAddress: null,
      closedAt: null,
      closedReason: null,
      createdAt: '2026-11-07T15:00:00Z',
      updatedAt: '2026-11-08T15:00:00.123456+00:00',
      deletedAt: null,
      isArchived: false,
      ...over.header,
    },
    status: over.status ?? ('quoted' as const),
    lineCount: lines.length,
    awardedLineCount: 0,
    invitedCount: invitations.length,
    sentCount: invitations.filter((i) => i.sentAt).length,
    declinedCount: invitations.filter((i) => i.declinedAt).length,
    respondedCount: new Set(responses.map((r) => r.invitationId)).size,
    lines,
    invitations,
    responses,
  };
  return { ...base, comparison: compareVendorRfq(base, TODAY) };
}
