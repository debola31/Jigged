import { describe, it, expect } from 'vitest';

import {
  buildJobActivity,
  filterToOperation,
  movementsFromShipments,
  noteCountsByOperation,
} from '@/components/jobs/activity/jobActivityTimeline';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { ShipmentWithRelations } from '@/types/shipment';
import type { QuickBooksInvoiceView } from '@/utils/quickbooksAccess';

function note(over: Partial<JobNote> & Pick<JobNote, 'id' | 'created_at'>): JobNote {
  return {
    body: 'a note',
    author_id: 'member-1',
    author_name: 'Kurtis',
    job_operation_id: null,
    operation_label: null,
    note_type: 'user',
    edited_at: null,
    subject_kind: 'job',
    media: [],
    reactions: [],
    ...over,
  } as JobNote;
}

function completion(
  over: Partial<JobActivityCompletion> & Pick<JobActivityCompletion, 'id' | 'completed_at'>,
): JobActivityCompletion {
  return {
    job_operation_id: 'op-20',
    operation_name: 'Mill',
    operation_sequence: 20,
    quantity_good: 12,
    completed_by: 'member-1',
    completed_by_name: 'Kurtis',
    note: null,
    voided_at: null,
    capture_source: 'operator',
    ...over,
  };
}

function slip(
  over: Partial<OutsideShipmentWithRelations> &
    Pick<OutsideShipmentWithRelations, 'id' | 'slip_number' | 'shipped_at'>,
): OutsideShipmentWithRelations {
  return {
    company_id: 'co-1',
    job_id: 'job-1',
    job_part_id: 'jp-1',
    job_operation_id: 'op-30',
    vendor_id: 'v-1',
    vendor_address_id: null,
    vendor_contact_id: null,
    vendor_name: 'Acme Plating',
    service_name: 'Zinc plate',
    ship_to_address: null,
    ship_to_contact: null,
    quantity: 12,
    due_back_on: null,
    carrier: null,
    notes: null,
    closed_at: null,
    closed_by: null,
    created_by: null,
    voided_at: null,
    voided_by: null,
    created_at: '2026-09-05T11:20:00Z',
    updated_at: '2026-09-05T11:20:00Z',
    job_operation: { id: 'op-30', operation_name: 'Plating', sequence: 30 },
    receipts: [],
    ...over,
  } as OutsideShipmentWithRelations;
}

function receipt(over: { id: string; received_at: string; quantity_good?: number; voided_at?: string | null; note?: string | null }) {
  return {
    company_id: 'co-1',
    outside_shipment_id: 's-1',
    job_operation_id: 'op-30',
    job_part_id: 'jp-1',
    quantity_good: 12,
    received_by: null,
    note: null,
    voided_at: null,
    voided_by: null,
    created_at: over.received_at,
    updated_at: over.received_at,
    ...over,
  };
}

function packingSlip(
  over: Partial<ShipmentWithRelations> &
    Pick<ShipmentWithRelations, 'id' | 'packing_slip_number' | 'created_at'>,
): ShipmentWithRelations {
  return {
    company_id: 'co-1',
    customer_id: 'cust-1',
    job_id: 'job-1',
    shipping_address_id: null,
    one_time_address: null,
    ship_date: '2026-09-05',
    carrier: null,
    shipping_method: null,
    created_by: 'user-1',
    voided_at: null,
    voided_by: null,
    customer_name: 'Classic Turning Inc.',
    bill_to_address: null,
    ship_to_address: null,
    freight_terms: null,
    customer_carrier_account_id: null,
    freight_account_snapshot: null,
    heat_numbers_snapshot: [],
    created_by_member: { user_id: 'user-1', name: 'Devin', email: null },
    shipment_line_items: [
      { id: 'sli-1', shipment_id: over.id, job_part_id: 'jp-1', quantity: 20, created_at: over.created_at },
    ],
    ...over,
  } as ShipmentWithRelations;
}

function invoice(
  over: Partial<QuickBooksInvoiceView> & Pick<QuickBooksInvoiceView, 'id' | 'createdAt'>,
): QuickBooksInvoiceView {
  return {
    invoiceId: 'qb-1',
    docNumber: '1043',
    url: 'https://qbo.intuit.com/app/invoice?txnId=1043',
    lines: [],
    total: 4200,
    provider: 'qbo',
    realmId: 'realm-1',
    voidedAt: null,
    qbTxnDate: null,
    qbStatus: null,
    qbTotalAmt: null,
    qbBalance: null,
    qbDueDate: null,
    qbStatusCheckedAt: null,
    ...over,
  } as QuickBooksInvoiceView;
}

describe('movementsFromShipments', () => {
  it('fans one slip out into a send, a row per receipt, and a short-close', () => {
    // Four rows from one slip. A single self-rewriting row would lose three of
    // these facts, which is the whole reason the feed fans out.
    const rows = movementsFromShipments([
      slip({
        id: 's-1',
        slip_number: 'VPS-1042-1',
        shipped_at: '2026-09-05T11:20:00Z',
        closed_at: '2026-09-05T16:00:00Z',
        receipts: [
          receipt({ id: 'r-1', received_at: '2026-09-05T13:52:00Z', quantity_good: 8 }),
          receipt({ id: 'r-2', received_at: '2026-09-05T15:10:00Z', quantity_good: 2 }),
        ],
      }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['sent', 'received', 'received', 'short_closed']);
    expect(rows[0]).toMatchObject({ quantity: 12, vendorName: 'Acme Plating', voided: false });
    expect(rows[1]).toMatchObject({ quantityGood: 8, receiptId: 'r-1' });
    // 12 sent, 10 back, so the close retires 2 — not counted as good anywhere.
    expect(rows[3]).toMatchObject({ kind: 'short_closed', outstanding: 2 });
  });

  it('emits no short-close row when the slip closed with nothing outstanding', () => {
    const rows = movementsFromShipments([
      slip({
        id: 's-2',
        slip_number: 'VPS-1042-2',
        shipped_at: '2026-09-01T09:00:00Z',
        closed_at: '2026-09-02T09:00:00Z',
        receipts: [receipt({ id: 'r-3', received_at: '2026-09-02T08:00:00Z', quantity_good: 12 })],
      }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['sent', 'received']);
  });

  it('keeps a voided slip in the history, flagged rather than dropped', () => {
    // The vendor was holding that paperwork. Erasing it makes the operation's
    // quantities unexplainable.
    const rows = movementsFromShipments([
      slip({
        id: 's-3',
        slip_number: 'VPS-1042-3',
        shipped_at: '2026-09-03T10:00:00Z',
        voided_at: '2026-09-03T10:30:00Z',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sent', voided: true });
  });

  it('treats a live receipt on a voided slip as voided too', () => {
    // The send it books against never counted, so the receipt cannot stand on
    // its own even though its own column is null.
    const rows = movementsFromShipments([
      slip({
        id: 's-4',
        slip_number: 'VPS-1042-4',
        shipped_at: '2026-09-03T10:00:00Z',
        voided_at: '2026-09-04T10:00:00Z',
        receipts: [receipt({ id: 'r-4', received_at: '2026-09-03T18:00:00Z', voided_at: null })],
      }),
    ]);

    expect(rows[1]).toMatchObject({ kind: 'received', voided: true });
  });

  it('excludes a voided receipt from what the short-close retires', () => {
    const rows = movementsFromShipments([
      slip({
        id: 's-5',
        slip_number: 'VPS-1042-5',
        shipped_at: '2026-09-01T09:00:00Z',
        closed_at: '2026-09-04T09:00:00Z',
        receipts: [
          receipt({ id: 'r-5', received_at: '2026-09-02T09:00:00Z', quantity_good: 5 }),
          receipt({
            id: 'r-6',
            received_at: '2026-09-03T09:00:00Z',
            quantity_good: 4,
            voided_at: '2026-09-03T10:00:00Z',
          }),
        ],
      }),
    ]);

    // 12 − 5 (the voided 4 does not count as returned) = 7 retired.
    expect(rows.find((r) => r.kind === 'short_closed')).toMatchObject({ outstanding: 7 });
  });
});

describe('buildJobActivity', () => {
  it('merges all three kinds newest-first', () => {
    const items = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
      notes: [note({ id: 'n-1', created_at: '2026-09-05T13:40:00Z', job_operation_id: 'op-20' })],
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T14:31:00Z' })],
      shipments: [
        slip({
          id: 's-1',
          slip_number: 'VPS-1042-1',
          shipped_at: '2026-09-05T11:20:00Z',
          receipts: [receipt({ id: 'r-1', received_at: '2026-09-05T13:52:00Z' })],
        }),
      ],
    });

    expect(items.map((i) => i.key)).toEqual([
      'completion-c-1', // 14:31
      'movement-received-r-1', // 13:52
      'note-n-1', // 13:40
      'movement-sent-s-1', // 11:20
    ]);
  });

  it('orders two same-second events deterministically instead of leaving them to render order', () => {
    const at = '2026-09-05T14:31:00Z';
    const forward = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
      notes: [],
      completions: [completion({ id: 'b', completed_at: at }), completion({ id: 'a', completed_at: at })],
      shipments: [],
    });
    const reversed = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
      notes: [],
      completions: [completion({ id: 'a', completed_at: at }), completion({ id: 'b', completed_at: at })],
      shipments: [],
    });

    expect(forward.map((i) => i.key)).toEqual(['completion-a', 'completion-b']);
    expect(reversed.map((i) => i.key)).toEqual(forward.map((i) => i.key));
  });

  it('sorts a backdated send into the middle of the history, not the top', () => {
    // shipped_at is deliberately backdatable (20260903203741). This is the
    // behaviour most likely to be reported as a sort bug.
    const items = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
      notes: [note({ id: 'n-1', created_at: '2026-09-05T09:00:00Z' })],
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T14:00:00Z' })],
      shipments: [slip({ id: 's-old', slip_number: 'VPS-1042-9', shipped_at: '2026-09-05T11:00:00Z' })],
    });

    expect(items.map((i) => i.key)).toEqual(['completion-c-1', 'movement-sent-s-old', 'note-n-1']);
  });

  it('carries a voided completion into the list rather than filtering it out', () => {
    const items = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
      notes: [],
      completions: [
        completion({ id: 'c-1', completed_at: '2026-09-05T14:00:00Z', voided_at: '2026-09-05T15:00:00Z' }),
      ],
      shipments: [],
    });

    expect(items).toHaveLength(1);
  });
});

describe("the job's own beginning", () => {
  /**
   * A JOB'S FEED IS NEVER EMPTY. Before this row, a job nobody had touched said
   * "Nothing has been recorded on this job yet" — true, and useless: it left the
   * reader unsure whether the feed was broken or the job was simply new.
   */
  it('gives an untouched job exactly one row', () => {
    const items = buildJobActivity({
      notes: [],
      completions: [],
      shipments: [],
      createdAt: '2026-09-01T08:00:00Z',
      customerShipments: [],
      invoices: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'created', key: 'job-created' });
  });

  it('sorts oldest, under everything that has happened since', () => {
    const items = buildJobActivity({
      notes: [note({ id: 'n-1', created_at: '2026-09-05T13:40:00Z' })],
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T14:31:00Z' })],
      shipments: [],
      createdAt: '2026-09-01T08:00:00Z',
      customerShipments: [],
      invoices: [],
    });

    expect(items.map((i) => i.key)).toEqual(['completion-c-1', 'note-n-1', 'job-created']);
  });

  it('emits nothing rather than an Invalid Date when the column is null', () => {
    // The beginning of a timeline is not a thing to guess at.
    const items = buildJobActivity({
      notes: [],
      completions: [],
      shipments: [],
      createdAt: null,
      customerShipments: [],
      invoices: [],
    });

    expect(items).toEqual([]);
  });

  it('is left out of a step filter, being about the job rather than a step', () => {
    const items = buildJobActivity({
      notes: [],
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T14:31:00Z' })],
      shipments: [],
      createdAt: '2026-09-01T08:00:00Z',
      customerShipments: [],
      invoices: [],
    });

    expect(filterToOperation(items, 'op-20').map((i) => i.key)).toEqual(['completion-c-1']);
  });
});

describe('the documents a job produces', () => {
  const BASE = {
    createdAt: null,
    notes: [],
    completions: [],
    shipments: [],
    customerShipments: [],
    invoices: [],
  };

  it('merges packing slips and invoices into the same chronology as everything else', () => {
    const items = buildJobActivity({
      ...BASE,
      notes: [note({ id: 'n-1', created_at: '2026-09-05T13:40:00Z' })],
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T09:00:00Z' })],
      customerShipments: [
        packingSlip({ id: 'ship-1', packing_slip_number: 'PS-0148-1', created_at: '2026-09-05T15:00:00Z' }),
      ],
      invoices: [invoice({ id: 'inv-1', createdAt: '2026-09-05T16:00:00Z' })],
    });

    expect(items.map((i) => i.key)).toEqual([
      'invoice-inv-1', // 16:00
      'shipment-ship-1', // 15:00
      'note-n-1', // 13:40
      'completion-c-1', // 09:00
    ]);
  });

  it('sums the line items on a slip into one piece count', () => {
    const items = buildJobActivity({
      ...BASE,
      customerShipments: [
        packingSlip({
          id: 'ship-1',
          packing_slip_number: 'PS-0148-1',
          created_at: '2026-09-05T15:00:00Z',
          shipment_line_items: [
            { id: 'a', shipment_id: 'ship-1', job_part_id: 'jp-1', quantity: 12, created_at: '2026-09-05T15:00:00Z' },
            { id: 'b', shipment_id: 'ship-1', job_part_id: 'jp-2', quantity: 8, created_at: '2026-09-05T15:00:00Z' },
          ],
        }),
      ],
    });

    expect(items[0]).toMatchObject({ kind: 'shipment', quantity: 20 });
  });

  it('sorts a slip on created_at, NOT on a backdated ship_date', () => {
    // ship_date is a DATE, so using it would drop an afternoon shipment below
    // every note written that morning. This is the assertion that pins it.
    const items = buildJobActivity({
      ...BASE,
      notes: [note({ id: 'n-1', created_at: '2026-09-05T09:00:00Z' })],
      customerShipments: [
        packingSlip({
          id: 'ship-1',
          packing_slip_number: 'PS-0148-1',
          created_at: '2026-09-05T15:00:00Z',
          ship_date: '2026-09-01',
        }),
      ],
    });

    expect(items.map((i) => i.key)).toEqual(['shipment-ship-1', 'note-n-1']);
    expect(items[0]).toMatchObject({ shipDate: '2026-09-01' });
  });

  it('keeps a voided slip and a voided invoice, marked rather than dropped', () => {
    // This is an audit surface: the paperwork existed, the customer may hold a
    // copy, and hiding it would make the job's quantities unexplainable.
    const items = buildJobActivity({
      ...BASE,
      customerShipments: [
        packingSlip({
          id: 'ship-1',
          packing_slip_number: 'PS-0148-1',
          created_at: '2026-09-05T15:00:00Z',
          voided_at: '2026-09-06T09:00:00Z',
        }),
      ],
      invoices: [invoice({ id: 'inv-1', createdAt: '2026-09-05T16:00:00Z', voidedAt: '2026-09-06T10:00:00Z' })],
    });

    expect(items).toHaveLength(2);
    expect(items.find((i) => i.key === 'shipment-ship-1')).toMatchObject({ voided: true });
    expect(items.find((i) => i.key === 'invoice-inv-1')).toMatchObject({ voided: true });
  });

  it('carries Jigged line total and the QuickBooks deep link onto the invoice row', () => {
    const items = buildJobActivity({
      ...BASE,
      invoices: [
        invoice({ id: 'inv-1', createdAt: '2026-09-05T16:00:00Z', docNumber: '1043', total: 4200, url: 'https://qbo/x' }),
      ],
    });

    expect(items[0]).toMatchObject({
      kind: 'invoice',
      docNumber: '1043',
      total: 4200,
      url: 'https://qbo/x',
    });
  });

  it('leaves both out of a step filter — they belong to the job, not an operation', () => {
    const items = buildJobActivity({
      ...BASE,
      completions: [completion({ id: 'c-1', completed_at: '2026-09-05T09:00:00Z', job_operation_id: 'op-20' })],
      customerShipments: [
        packingSlip({ id: 'ship-1', packing_slip_number: 'PS-0148-1', created_at: '2026-09-05T15:00:00Z' }),
      ],
      invoices: [invoice({ id: 'inv-1', createdAt: '2026-09-05T16:00:00Z' })],
    });

    expect(filterToOperation(items, 'op-20').map((i) => i.key)).toEqual(['completion-c-1']);
  });
});

describe('filterToOperation', () => {
  const items = buildJobActivity({
      createdAt: null,
      customerShipments: [],
      invoices: [],
    notes: [
      note({ id: 'n-step', created_at: '2026-09-05T13:40:00Z', job_operation_id: 'op-20' }),
      note({ id: 'n-job', created_at: '2026-09-05T13:30:00Z', job_operation_id: null }),
    ],
    completions: [completion({ id: 'c-1', completed_at: '2026-09-05T14:31:00Z', job_operation_id: 'op-20' })],
    shipments: [slip({ id: 's-1', slip_number: 'VPS-1042-1', shipped_at: '2026-09-05T11:20:00Z' })],
  });

  it('keeps only rows tagged to that step', () => {
    expect(filterToOperation(items, 'op-20').map((i) => i.key)).toEqual([
      'completion-c-1',
      'note-n-step',
    ]);
  });

  it('excludes job-level notes — the filter asks about a step', () => {
    expect(filterToOperation(items, 'op-20').some((i) => i.key === 'note-n-job')).toBe(false);
  });

  it('keeps the movement rows of an outside step', () => {
    expect(filterToOperation(items, 'op-30').map((i) => i.key)).toEqual(['movement-sent-s-1']);
  });
});

describe('noteCountsByOperation', () => {
  it('counts notes per step and ignores job-level ones', () => {
    // The badge navigates to the step filter, which excludes job-level notes —
    // counting them here would promise rows the filter will not show.
    const counts = noteCountsByOperation([
      note({ id: 'n-1', created_at: '2026-09-05T10:00:00Z', job_operation_id: 'op-20' }),
      note({ id: 'n-2', created_at: '2026-09-05T11:00:00Z', job_operation_id: 'op-20' }),
      note({ id: 'n-3', created_at: '2026-09-05T12:00:00Z', job_operation_id: 'op-10' }),
      note({ id: 'n-4', created_at: '2026-09-05T13:00:00Z', job_operation_id: null }),
    ]);

    expect(counts.get('op-20')).toBe(2);
    expect(counts.get('op-10')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
