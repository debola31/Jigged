'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AddIcon from '@mui/icons-material/Add';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';

import { getQuickBooksInvoiceLinksForJob, type QuickBooksInvoiceView } from '@/utils/quickbooksAccess';
import { copyText } from '@/utils/clipboard';

const EMPTY: QuickBooksInvoiceView[] = [];

/**
 * Toolbar dropdown consolidating "view invoices" + "create invoice" into one
 * button (a standard MUI Menu), so invoices are reachable from the top of the
 * job page without scrolling and the toolbar doesn't grow a separate button.
 */
export default function InvoicesMenu({
  companyId,
  jobId,
  refreshKey = 0,
  onCreate,
  disabled,
}: {
  companyId: string;
  jobId: string;
  refreshKey?: number;
  onCreate: () => void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const { data } = useLoad(
    () => getQuickBooksInvoiceLinksForJob(companyId, jobId),
    [companyId, jobId, refreshKey],
    { onError: (err) => console.warn('InvoicesMenu load failed', err) },
  );
  const invoices = data ?? EMPTY;

  const handleCopy = async (inv: QuickBooksInvoiceView) => {
    if (!inv.docNumber) return;
    setCopied({ id: inv.id, ok: await copyText(inv.docNumber) });
  };

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<ReceiptLongIcon />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        disabled={disabled}
      >
        Invoices ({invoices.length})
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {invoices.length === 0 ? (
          <MenuItem disabled>
            <ListItemText primary="No invoices yet" />
          </MenuItem>
        ) : (
          invoices.map((inv) =>
            inv.url ? (
              <MenuItem
                key={inv.id}
                component="a"
                href={inv.url}
                target="_blank"
                rel="noopener"
                onClick={() => setAnchor(null)}
              >
                <ListItemText
                  primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                  secondary={formatDate(inv.createdAt)}
                />
                <OpenInNewIcon fontSize="small" sx={{ ml: 2, color: 'text.secondary' }} />
              </MenuItem>
            ) : (
              // No url means QuickBooks Desktop, which has no web page to open --
              // so the row copies the invoice number instead of navigating. That
              // number is the only handle a human has for finding the transaction
              // in QuickBooks, and retyping it from the screen is where the digit
              // gets transposed. The menu deliberately stays open afterwards so
              // the confirmation is seen.
              <MenuItem
                key={inv.id}
                onClick={() => handleCopy(inv)}
                disabled={!inv.docNumber}
                aria-label={inv.docNumber ? `Copy invoice number ${inv.docNumber}` : undefined}
              >
                <ListItemText
                  primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                  secondary={
                    copied?.id === inv.id
                      ? copied.ok
                        ? 'Copied'
                        : 'Press Ctrl+C to copy'
                      : formatDate(inv.createdAt)
                  }
                  slotProps={
                    copied?.id === inv.id
                      ? { secondary: { color: copied.ok ? 'success.main' : 'warning.main' } }
                      : undefined
                  }
                />
                {copied?.id === inv.id && copied.ok ? (
                  <CheckIcon fontSize="small" sx={{ ml: 2, color: 'success.main' }} />
                ) : (
                  <ContentCopyIcon fontSize="small" sx={{ ml: 2, color: 'text.secondary' }} />
                )}
              </MenuItem>
            ),
          )
        )}
        {invoices.length > 0 && invoices.every((i) => !i.url) && (
          <MenuItem disabled sx={{ whiteSpace: 'normal', maxWidth: 320 }}>
            <ListItemText
              secondary="QuickBooks Desktop has no web page to link to. Copy an invoice number, then in QuickBooks press Ctrl+F, paste it into Invoice #, and press Enter."
              slotProps={{ secondary: { variant: 'caption' } }}
            />
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onCreate();
          }}
        >
          <AddIcon fontSize="small" sx={{ mr: 1 }} />
          Create invoice
        </MenuItem>
      </Menu>
    </>
  );
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
