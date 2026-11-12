/**
 * Complete `VendorPoDetail` fixtures for the purchase order screen tests and the PDF test.
 *
 * Every field the types declare is filled, so a component that reads one the test author forgot
 * still renders against realistic data. The parties are deliberately named unlike anything a
 * "live" vendor read could return ("Acme Steel Supply (frozen)"): a surface that shows the frozen
 * copy prints these words, one that read the address book would not.
 */
import type {
  VendorPoDetail,
  VendorPoHeader,
  VendorPoLine,
  VendorPoOutsideSlip,
  VendorPoReceipt,
  VendorPoSummary,
} from '@/types/vendorPo';

export function poHeader(over: Partial<VendorPoHeader> = {}): VendorPoHeader {
  return {
    id: 'po-1',
    companyId: 'test-company-id',
    poNumber: 'PO-1042',
    vendorId: 'v1',
    vendorName: 'Acme Steel Supply (frozen)',
    vendorAddressId: 'va1',
    vendorAddress: {
      address_line1: '100 Mill Rd',
      address_line2: null,
      city: 'Gary',
      state: 'IN',
      postal_code: '46402',
      country: 'USA',
      attention_to: null,
    },
    vendorContactId: 'vc1',
    vendorContact: { name: 'Jane Buyer', email: 'jane@acme.test', phone: '(219) 555-0100' },
    shipToKind: 'shop',
    shipToVendorId: null,
    shipToVendorAddressId: null,
    shipToCustomerId: null,
    shipToCustomerAddressId: null,
    shipToName: 'Contour Tool & Machine',
    shipToAddress: {
      address_line1: '123 Shop St',
      address_line2: null,
      city: 'Warren',
      state: 'MI',
      postal_code: '48089',
      country: 'USA',
      attention_to: 'Receiving',
    },
    orderedOn: '2026-11-02',
    needByOn: '2026-11-20',
    paymentTerms: 'Net 30',
    shipVia: 'UPS Ground',
    notesToVendor: 'Deliver to the back dock.',
    internalNotes: 'SECRET-INTERNAL-NOTE',
    termsAndConditions: 'All material must be certified.',
    revision: 0,
    sentRevision: 0,
    issuedAt: '2026-11-02T15:00:00Z',
    lastSentAt: '2026-11-02T15:00:00Z',
    contentVersion: 3,
    closedAt: null,
    closedReason: null,
    vendorRfqId: null,
    createdAt: '2026-11-02T14:00:00Z',
    updatedAt: '2026-11-02T15:00:00.123456+00:00',
    deletedAt: null,
    isArchived: false,
    ...over,
  };
}

export function poSummary(over: Partial<VendorPoSummary> = {}): VendorPoSummary {
  return {
    status: 'sent',
    isLate: false,
    nextExpectedOn: '2026-11-20',
    lineCount: 2,
    outstandingLineCount: 2,
    orderedAmount: 437.5,
    openAmount: 437.5,
    hasUnpricedLines: false,
    hasUnsentChanges: false,
    quickbooksState: 'not_sent',
    jobIds: ['j1'],
    jobNumbers: ['J-1042'],
    ...over,
  };
}

export function poLine(over: Partial<VendorPoLine> = {}): VendorPoLine {
  return {
    id: 'l1',
    vendorPurchaseOrderId: 'po-1',
    lineNumber: 1,
    lineKind: 'part',
    partId: 'p1',
    partName: '6061-BAR-1',
    description: '6061-T6 round bar, 1 in',
    vendorPartNumber: 'AC-6061-1',
    quantity: 3,
    unit: 'bar',
    stockUnit: 'inches',
    stockFactor: 144,
    unitPrice: 125,
    priceSource: 'price_sheet',
    amount: 375,
    openAmount: 375,
    needByOn: '2026-11-20',
    promisedOn: '2026-11-18',
    expectedOn: '2026-11-18',
    certRequired: true,
    expectsReceipt: true,
    jobId: 'j1',
    jobNumber: 'J-1042',
    jobPartId: 'jp1',
    jobOperationId: null,
    operationLabel: null,
    vendorServiceId: null,
    serviceName: null,
    workCenterId: null,
    workCenterName: null,
    closedAt: null,
    status: 'open',
    isLate: false,
    orderedStockQuantity: 432,
    receivedQuantity: 0,
    receivedStockQuantity: 0,
    remainingQuantity: 3,
    remainingStockQuantity: 432,
    openQuantity: 3,
    openStockQuantity: 432,
    overReceivedQuantity: 0,
    sentQuantity: null,
    atVendorQuantity: null,
    linkedSlipCount: 0,
    hasLiveReceipts: false,
    removable: true,
    createdAt: '2026-11-02T14:00:00Z',
    updatedAt: '2026-11-02T14:00:00Z',
    ...over,
  };
}

/** An Other line: freight-like text, a machine, quantity only. */
export function otherLine(over: Partial<VendorPoLine> = {}): VendorPoLine {
  return poLine({
    id: 'l2',
    lineNumber: 2,
    lineKind: 'other',
    partId: null,
    partName: null,
    description: 'Spindle rebuild',
    vendorPartNumber: null,
    quantity: 1,
    unit: 'each',
    stockUnit: null,
    stockFactor: null,
    unitPrice: 62.5,
    priceSource: 'manual',
    amount: 62.5,
    openAmount: 62.5,
    promisedOn: null,
    expectedOn: '2026-11-20',
    certRequired: false,
    jobId: null,
    jobNumber: null,
    jobPartId: null,
    workCenterId: 'wc1',
    workCenterName: 'Haas VF-2',
    orderedStockQuantity: null,
    receivedStockQuantity: null,
    remainingQuantity: 1,
    remainingStockQuantity: null,
    openQuantity: 1,
    openStockQuantity: null,
    ...over,
  });
}

/** An outside-service line: received on its slips, never on the PO. */
export function outsideLine(over: Partial<VendorPoLine> = {}): VendorPoLine {
  return poLine({
    id: 'l3',
    lineNumber: 3,
    lineKind: 'outside_service',
    partId: 'p2',
    partName: '1234-A',
    description: 'Anodize — 1234-A — Job J-1042, Op 30',
    vendorPartNumber: null,
    quantity: 100,
    unit: 'each',
    stockUnit: null,
    stockFactor: null,
    unitPrice: 1.25,
    priceSource: 'vendor_service',
    amount: 125,
    openAmount: 50,
    promisedOn: null,
    expectedOn: '2026-11-25',
    certRequired: false,
    jobId: 'j1',
    jobNumber: 'J-1042',
    jobPartId: 'jp2',
    jobOperationId: 'op30',
    operationLabel: 'Op 30 Anodize',
    vendorServiceId: 'vs1',
    serviceName: 'Anodize',
    orderedStockQuantity: null,
    receivedQuantity: 60,
    receivedStockQuantity: null,
    remainingQuantity: 40,
    remainingStockQuantity: null,
    openQuantity: 40,
    openStockQuantity: null,
    status: 'partially_received',
    sentQuantity: 100,
    atVendorQuantity: 40,
    linkedSlipCount: 1,
    hasLiveReceipts: true,
    removable: false,
    ...over,
  });
}

export function poReceipt(over: Partial<VendorPoReceipt> = {}): VendorPoReceipt {
  return {
    id: 'r1',
    vendorPurchaseOrderLineId: 'l1',
    lineNumber: 1,
    lineKind: 'part',
    receiptGroupId: 'g1',
    entryIndex: 0,
    quantity: 1,
    unit: 'bar',
    stockQuantity: 144,
    stockUnit: 'inches',
    partId: 'p1',
    locationId: 'loc1',
    locationName: 'Rack A',
    lotId: 'lot1',
    lotCode: 'H4471',
    heatNumber: 'H4471',
    startedTracking: false,
    inventoryTransactionId: 't1',
    voidTransactionId: null,
    vendorPackingSlip: 'PS-88',
    notes: null,
    receivedAt: '2026-11-05T15:00:00Z',
    receivedByName: 'Shane Miller',
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

export function poSlip(over: Partial<VendorPoOutsideSlip> = {}): VendorPoOutsideSlip {
  return {
    id: 's1',
    slipNumber: 'VPS-0141-1',
    vendorPurchaseOrderLineId: 'l3',
    jobId: 'j1',
    jobOperationId: 'op30',
    quantity: 100,
    shippedAt: '2026-11-04T12:00:00Z',
    dueBackOn: '2026-11-25',
    closedAt: null,
    voidedAt: null,
    receivedQuantity: 60,
    outstandingQuantity: 40,
    ...over,
  };
}

export function poDetail(over: Partial<VendorPoDetail> = {}): VendorPoDetail {
  return {
    header: poHeader(),
    summary: poSummary(),
    lines: [poLine(), otherLine()],
    receipts: [],
    outsideSlips: [],
    revisionCount: 1,
    quickbooks: {
      state: 'not_sent',
      linkId: null,
      provider: null,
      linkStatus: null,
      docNumber: null,
      url: null,
      closedInQuickBooks: false,
      pushedRevision: null,
      pushedAt: null,
    },
    ...over,
  };
}

/** A PO never marked sent. */
export function draftPoDetail(over: Partial<VendorPoDetail> = {}): VendorPoDetail {
  return poDetail({
    header: poHeader({ sentRevision: null, issuedAt: null, lastSentAt: null }),
    summary: poSummary({ status: 'draft' }),
    lines: [poLine({ status: 'draft' }), otherLine({ status: 'draft' })],
    revisionCount: 0,
    ...over,
  });
}
