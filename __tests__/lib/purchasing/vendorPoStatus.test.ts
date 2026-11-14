/**
 * Status words and colours for purchasing documents (plan §3.4 "Statuses", criterion P6).
 *
 * These MAP the statuses the database derives in its views; they never derive one. The colours
 * are StatusChip/StatusDot palette keys, so a PO's dot in the list and its chip on the detail page
 * can never disagree about what green means.
 */
import { describe, it, expect } from 'vitest';
import {
  PART_VENDOR_STATUS_CONFIG,
  VENDOR_PO_DEFAULT_LIST_STATUSES,
  VENDOR_PO_LINE_STATUSES,
  VENDOR_PO_LINE_STATUS_CONFIG,
  VENDOR_PO_OVERDUE,
  VENDOR_PO_QUICKBOOKS_STATE_CONFIG,
  VENDOR_PO_STATUSES,
  VENDOR_PO_STATUS_CONFIG,
  VENDOR_RFQ_STATUS_CONFIG,
  isVendorPoStatus,
  vendorPoLineStateDisplay,
  vendorPoStatusDisplay,
} from '@/lib/purchasing/vendorPoStatus';

const PALETTE = ['default', 'primary', 'secondary', 'error', 'info', 'success', 'warning'];

describe('PO statuses (P6)', () => {
  it('names every status the view derives, in lifecycle order', () => {
    expect([...VENDOR_PO_STATUSES]).toEqual(['draft', 'sent', 'partially_received', 'received', 'closed']);
  });

  it('labels each one in the words of the plan', () => {
    expect(Object.fromEntries(VENDOR_PO_STATUSES.map((s) => [s, VENDOR_PO_STATUS_CONFIG[s].label]))).toEqual({
      draft: 'Draft',
      sent: 'Sent',
      partially_received: 'Partly received',
      received: 'Received',
      closed: 'Closed',
    });
  });

  it('colours them from the semantic palette, with the "off" states hollow', () => {
    expect(VENDOR_PO_STATUS_CONFIG.draft.color).toBe('default');
    expect(VENDOR_PO_STATUS_CONFIG.sent.color).toBe('info');
    expect(VENDOR_PO_STATUS_CONFIG.partially_received.color).toBe('secondary');
    expect(VENDOR_PO_STATUS_CONFIG.received.color).toBe('success');
    expect(VENDOR_PO_STATUS_CONFIG.closed.color).toBe('default');
    for (const s of VENDOR_PO_STATUSES) expect(PALETTE).toContain(VENDOR_PO_STATUS_CONFIG[s].color);
  });

  it('gives every status a distinct word, since the word is the encoding that survives', () => {
    const labels = VENDOR_PO_STATUSES.map((s) => VENDOR_PO_STATUS_CONFIG[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('shows an unknown status as itself rather than hiding it', () => {
    expect(vendorPoStatusDisplay('mystery')).toEqual({ label: 'mystery', color: 'default' });
    expect(vendorPoStatusDisplay('sent')).toEqual(VENDOR_PO_STATUS_CONFIG.sent);
  });

  it('narrows a string to a status', () => {
    expect(isVendorPoStatus('partially_received')).toBe(true);
    expect(isVendorPoStatus('open')).toBe(false);
  });

  it('defaults the PO list to the open statuses: Draft, Sent and Partly received', () => {
    expect([...VENDOR_PO_DEFAULT_LIST_STATUSES]).toEqual(['draft', 'sent', 'partially_received']);
  });
});

describe('overdue is a flag beside the status, not a status (P6)', () => {
  it('is amber — behind, not broken', () => {
    expect(VENDOR_PO_OVERDUE).toEqual({ label: 'Overdue', color: 'warning' });
  });

  it('is not one of the statuses', () => {
    expect(VENDOR_PO_STATUSES as readonly string[]).not.toContain('overdue');
    expect(VENDOR_PO_LINE_STATUSES as readonly string[]).not.toContain('overdue');
  });
});

describe('line states (P6)', () => {
  it('names every state the line view derives', () => {
    expect([...VENDOR_PO_LINE_STATUSES].sort()).toEqual(
      ['closed', 'draft', 'no_receipt', 'open', 'partially_received', 'received'],
    );
  });

  it('labels them as the PO page reads them', () => {
    expect(VENDOR_PO_LINE_STATUS_CONFIG.open.label).toBe('Open');
    expect(VENDOR_PO_LINE_STATUS_CONFIG.partially_received.label).toBe('Partly received');
    expect(VENDOR_PO_LINE_STATUS_CONFIG.received.label).toBe('Received');
    expect(VENDOR_PO_LINE_STATUS_CONFIG.closed.label).toBe('Closed short');
    expect(VENDOR_PO_LINE_STATUS_CONFIG.no_receipt.label).toBe('No receipt needed');
    expect(VENDOR_PO_LINE_STATUS_CONFIG.draft.label).toBe('Draft');
    for (const s of VENDOR_PO_LINE_STATUSES) expect(PALETTE).toContain(VENDOR_PO_LINE_STATUS_CONFIG[s].color);
  });

  it('reads an over-receipt as "Received +N"', () => {
    expect(vendorPoLineStateDisplay('received', { orderedQuantity: 3, receivedQuantity: 4 })).toEqual({
      label: 'Received +1',
      color: 'success',
    });
    expect(vendorPoLineStateDisplay('received', { orderedQuantity: 10, receivedQuantity: 12.5 }).label).toBe('Received +2.5');
  });

  it('reads an exact receipt as plain "Received", ignoring float noise', () => {
    expect(vendorPoLineStateDisplay('received', { orderedQuantity: 0.3, receivedQuantity: 0.1 + 0.2 }).label).toBe('Received');
    expect(vendorPoLineStateDisplay('received').label).toBe('Received');
  });

  it('never adds +N to a state other than received', () => {
    expect(vendorPoLineStateDisplay('closed', { orderedQuantity: 3, receivedQuantity: 4 }).label).toBe('Closed short');
  });

  it('shows an unknown state as itself', () => {
    expect(vendorPoLineStateDisplay('weird')).toEqual({ label: 'weird', color: 'default' });
  });
});

describe('the other purchasing status words', () => {
  it('labels the QuickBooks state of a PO', () => {
    expect(Object.fromEntries(Object.entries(VENDOR_PO_QUICKBOOKS_STATE_CONFIG).map(([k, v]) => [k, v.label]))).toEqual({
      not_sent: 'Not sent',
      in_quickbooks: 'In QuickBooks',
      out_of_date: 'Out of date',
      pending: 'Sending',
      needs_checking: 'Needs checking',
      failed: 'Failed',
    });
    expect(VENDOR_PO_QUICKBOOKS_STATE_CONFIG.out_of_date.color).toBe('warning');
    expect(VENDOR_PO_QUICKBOOKS_STATE_CONFIG.failed.color).toBe('error');
  });

  it('labels RFQ statuses (Q1)', () => {
    expect(Object.fromEntries(Object.entries(VENDOR_RFQ_STATUS_CONFIG).map(([k, v]) => [k, v.label]))).toEqual({
      draft: 'Draft',
      sent: 'Sent',
      quoted: 'Quoted',
      awarded: 'Awarded',
      closed: 'Closed',
    });
  });

  it('labels approved-vendor statuses as Approved / Conditional / Do not use (V1, L4)', () => {
    expect(PART_VENDOR_STATUS_CONFIG.approved).toEqual({ label: 'Approved', color: 'success' });
    expect(PART_VENDOR_STATUS_CONFIG.conditional).toEqual({ label: 'Conditional', color: 'warning' });
    expect(PART_VENDOR_STATUS_CONFIG.disapproved).toEqual({ label: 'Do not use', color: 'error' });
  });
});
