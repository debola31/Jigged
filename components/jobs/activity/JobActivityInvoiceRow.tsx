'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

import JobActivityRow from './JobActivityRow';
import type { JobActivityItem } from './jobActivityTimeline';

type InvoiceItem = Extract<JobActivityItem, { kind: 'invoice' }>;

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function meta(item: InvoiceItem): string {
  // Jigged's line total, never the QuickBooks figure: QBO totals are
  // tax-inclusive and ours are not, so the two are not the same number and
  // showing theirs here would disagree with the Invoices menu.
  const parts = [`#${item.docNumber ?? '—'}`, formatCurrency(item.total)];
  // "Voided" covers a human void AND the mirror finding it voided or deleted in
  // QuickBooks. The row does not claim to know which — only that it no longer
  // counts toward what this job has been billed.
  if (item.voided) parts.push('voided');
  return parts.join(' · ');
}

/**
 * One invoice this job produced.
 *
 * NO PAYMENT STATE ON THIS ROW, deliberately. The paid/partial/open chip lives
 * in the Invoices menu, where opening it is what refreshes the QuickBooks
 * mirror; a chip here would render whatever the mirror last happened to say,
 * with no way to tell how old that is and no user action behind it. What a feed
 * can say honestly is that the invoice was created, and when.
 */
export default function JobActivityInvoiceRow({ item }: { item: InvoiceItem }) {
  return (
    <JobActivityRow
      tone="document"
      struck={item.voided}
      at={item.at}
      title="Invoice created"
      meta={meta(item)}
    >
      {item.url ? (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            component="a"
            href={item.url}
            target="_blank"
            rel="noopener"
            aria-label={`Open invoice ${item.docNumber ?? ''} in QuickBooks`.trim()}
            sx={{ minHeight: 32, px: 1, py: 0.25, fontSize: '0.75rem' }}
          >
            View in QuickBooks
          </Button>
        </Box>
      ) : null}
    </JobActivityRow>
  );
}
