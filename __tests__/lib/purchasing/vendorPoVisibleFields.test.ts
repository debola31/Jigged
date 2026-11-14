/**
 * The vendor-visible field list (plan §3.3 `save_vendor_purchase_order`, criterion P3).
 *
 * ONE LIST, THREE COPIES. The database bumps a sent PO's revision once per send cycle when the
 * vendor's copy changes; the PO form predicts "Save as Rev N+1" from the same keys. The DB tests
 * parametrize over the four tuples in `api/tests/integration/purchasing_support.py`, the same lists
 * live as data in `__tests__/fixtures/vendorPoVisibleFields.json`, and the first two tests below
 * pin all three together — so the form and the database cannot disagree about what the vendor sees.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import visibleFieldsFixture from '../../fixtures/vendorPoVisibleFields.json';
import {
  VENDOR_PO_FIXED_ONCE_SENT_FIELDS,
  VENDOR_PO_HEADER_INTERNAL_FIELDS,
  VENDOR_PO_HEADER_VISIBLE_FIELDS,
  VENDOR_PO_LINE_INTERNAL_FIELDS,
  VENDOR_PO_LINE_SET_CHANGES,
  VENDOR_PO_LINE_VISIBLE_FIELDS,
  VENDOR_PO_VISIBLE_FIELD_LISTS,
  diffVendorVisible,
  isVendorVisibleField,
  predictVendorPoRevision,
  type VendorPoDocumentSnapshot,
} from '@/lib/purchasing/vendorPoVisibleFields';

const PURCHASING_SUPPORT = join(process.cwd(), 'api/tests/integration/purchasing_support.py');

/** The string items of `NAME = ( ... )` in a Python source, comments stripped; null if absent. */
function pythonTuple(source: string, name: string): string[] | null {
  const match = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, 'm').exec(source);
  if (!match) return null;
  const body = match[1].replace(/#[^\n]*/g, '');
  return [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
}

describe('the shared list (P3)', () => {
  it('is exactly the data in vendorPoVisibleFields.json', () => {
    const { $comment: _comment, ...lists } = visibleFieldsFixture;
    expect(lists).toEqual(VENDOR_PO_VISIBLE_FIELD_LISTS);
  });

  it('is exactly the four tuples the DB tests parametrize over', () => {
    expect(existsSync(PURCHASING_SUPPORT), `${PURCHASING_SUPPORT} is missing`).toBe(true);
    const source = readFileSync(PURCHASING_SUPPORT, 'utf8');
    const pairs: Array<[string, readonly string[]]> = [
      ['VENDOR_VISIBLE_HEADER_FIELDS', VENDOR_PO_HEADER_VISIBLE_FIELDS],
      ['VENDOR_VISIBLE_LINE_FIELDS', VENDOR_PO_LINE_VISIBLE_FIELDS],
      ['INTERNAL_HEADER_FIELDS', VENDOR_PO_HEADER_INTERNAL_FIELDS],
      ['INTERNAL_LINE_FIELDS', VENDOR_PO_LINE_INTERNAL_FIELDS],
    ];
    for (const [name, ours] of pairs) {
      const theirs = pythonTuple(source, name);
      if (theirs === null) {
        // The Python side may load the JSON fixture instead of copying it — then the test above
        // is the whole pin.
        expect(source, `${name} is neither a literal tuple nor loaded from the fixture`).toContain('vendorPoVisibleFields.json');
        continue;
      }
      expect([...theirs].sort(), `${name} in purchasing_support.py`).toEqual([...ours].sort());
    }
  });

  it('never lists a key as both vendor-visible and internal', () => {
    const header = new Set<string>(VENDOR_PO_HEADER_VISIBLE_FIELDS);
    const line = new Set<string>(VENDOR_PO_LINE_VISIBLE_FIELDS);
    expect(VENDOR_PO_HEADER_INTERNAL_FIELDS.filter((f) => header.has(f))).toEqual([]);
    expect(VENDOR_PO_LINE_INTERNAL_FIELDS.filter((f) => line.has(f))).toEqual([]);
  });

  it('keeps internal notes and promised dates off the vendor\'s copy', () => {
    expect([...VENDOR_PO_HEADER_INTERNAL_FIELDS]).toEqual(['internal_notes']);
    expect([...VENDOR_PO_LINE_INTERNAL_FIELDS]).toEqual(['promised_on']);
  });

  it('counts adding and removing a line, and names what a sent PO refuses to change', () => {
    expect([...VENDOR_PO_LINE_SET_CHANGES]).toEqual(['line_added', 'line_removed']);
    expect([...VENDOR_PO_FIXED_ONCE_SENT_FIELDS]).toEqual(['vendor_id', 'ordered_on']);
  });

  it('answers per key', () => {
    expect(isVendorVisibleField('header', 'notes_to_vendor')).toBe(true);
    expect(isVendorVisibleField('header', 'vendor_address_id')).toBe(true);
    expect(isVendorVisibleField('header', 'internal_notes')).toBe(false);
    expect(isVendorVisibleField('line', 'quantity')).toBe(true);
    expect(isVendorVisibleField('line', 'promised_on')).toBe(false);
    expect(isVendorVisibleField('line', 'price_source')).toBe(false);
  });

  it('counts the machine and the job part, which print their names, and never kind or step', () => {
    expect(isVendorVisibleField('line', 'work_center_id')).toBe(true);
    expect(isVendorVisibleField('line', 'job_part_id')).toBe(true);
    // Fixed for an existing line — the save refuses a change — so never a key that bumps.
    expect(isVendorVisibleField('line', 'line_kind')).toBe(false);
    expect(isVendorVisibleField('line', 'job_operation_id')).toBe(false);
  });
});

const doc = (): VendorPoDocumentSnapshot => ({
  header: {
    vendor_id: 'v1',
    vendor_contact_id: 'c1',
    vendor_address_id: 'a1',
    ship_to_kind: 'shop',
    notes_to_vendor: 'Deliver to dock 2',
    internal_notes: 'Ask for Jane',
    need_by_on: '2026-11-20',
  },
  lines: [
    { id: 'l1', part_id: 'p1', quantity: 10, unit: 'bar', unit_price: 36, promised_on: null, cert_required: false },
    { id: 'l2', description: 'Freight', quantity: 1, unit: 'each', unit_price: 50 },
  ],
});

const changes = (before: VendorPoDocumentSnapshot, after: VendorPoDocumentSnapshot) =>
  diffVendorVisible(before, after).map((c) => `${c.scope}.${c.field}${c.lineId ? `@${c.lineId}` : ''}`);

describe('diffVendorVisible — what the vendor would see change (P3)', () => {
  it('sees a change to a vendor-visible header key', () => {
    const after = doc();
    after.header.notes_to_vendor = 'Deliver to dock 3';
    after.header.vendor_address_id = 'a2';
    expect(changes(doc(), after)).toEqual(['header.vendor_address_id', 'header.notes_to_vendor']);
  });

  it('sees a drop-ship to a customer as a ship-to change', () => {
    const after = doc();
    after.header.ship_to_kind = 'customer';
    after.header.ship_to_customer_id = 'cust-1';
    after.header.ship_to_customer_address_id = 'ca-1';
    expect(changes(doc(), after)).toEqual([
      'header.ship_to_kind', 'header.ship_to_customer_id', 'header.ship_to_customer_address_id',
    ]);
  });

  it('ignores internal notes', () => {
    const after = doc();
    after.header.internal_notes = 'Ask for Bob';
    expect(changes(doc(), after)).toEqual([]);
  });

  it('sees a line\'s quantity and price change, and ignores its promised date', () => {
    const after = doc();
    after.lines[0] = { ...after.lines[0], quantity: 12, unit_price: 35, promised_on: '2026-11-18' };
    expect(changes(doc(), after)).toEqual(['line.quantity@l1', 'line.unit_price@l1']);
  });

  it('sees a line added (it has no id yet) and a line removed', () => {
    const added = doc();
    added.lines.push({ description: 'Cert fee', quantity: 1, unit: 'each', unit_price: 10 });
    expect(changes(doc(), added)).toEqual(['lines.line_added']);
    const removed = doc();
    removed.lines = removed.lines.filter((l) => l.id !== 'l2');
    expect(changes(doc(), removed)).toEqual(['lines.line_removed@l2']);
  });

  it('does not mistake a re-typed number, a cleared blank or padding for a change', () => {
    const after = doc();
    after.lines[0] = { ...after.lines[0], quantity: '10', unit_price: '36.00' };
    after.header.notes_to_vendor = '  Deliver to dock 2 ';
    after.header.ship_via = '';
    expect(changes(doc(), after)).toEqual([]);
  });

  it('sees a certs-required tick', () => {
    const after = doc();
    after.lines[0] = { ...after.lines[0], cert_required: true };
    expect(changes(doc(), after)).toEqual(['line.cert_required@l1']);
  });

  it('sees a line moved to another machine or onto a job part', () => {
    const before = doc();
    before.lines[1] = { ...before.lines[1], work_center_id: 'wc-1' };
    const after = doc();
    after.lines[1] = { ...after.lines[1], work_center_id: 'wc-2' };
    after.lines[0] = { ...after.lines[0], job_part_id: 'jp-1' };
    expect(changes(before, after)).toEqual(['line.job_part_id@l1', 'line.work_center_id@l2']);
  });
});

describe('predictVendorPoRevision — "Save as Rev N+1" (P3)', () => {
  it('never bumps a draft', () => {
    expect(predictVendorPoRevision({ revision: 0, sentRevision: null, vendorVisibleChanged: true })).toEqual({
      willBump: false, revisionAfterSave: 0, saveLabel: 'Save',
    });
  });

  it('bumps the first vendor-visible change after a send', () => {
    expect(predictVendorPoRevision({ revision: 0, sentRevision: 0, vendorVisibleChanged: true })).toEqual({
      willBump: true, revisionAfterSave: 1, saveLabel: 'Save as Rev 1',
    });
    expect(predictVendorPoRevision({ revision: 2, sentRevision: 2, vendorVisibleChanged: true }).saveLabel).toBe('Save as Rev 3');
  });

  it('bumps only once per send cycle', () => {
    expect(predictVendorPoRevision({ revision: 1, sentRevision: 0, vendorVisibleChanged: true })).toEqual({
      willBump: false, revisionAfterSave: 1, saveLabel: 'Save',
    });
  });

  it('does not bump when nothing the vendor sees changed', () => {
    expect(predictVendorPoRevision({ revision: 0, sentRevision: 0, vendorVisibleChanged: false })).toMatchObject({
      willBump: false, revisionAfterSave: 0,
    });
  });
});
