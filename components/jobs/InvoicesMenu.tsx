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

import { getQuickBooksInvoiceLinksForJob, type QuickBooksInvoiceView } from '@/utils/quickbooksAccess';

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
  const { data } = useLoad(
    () => getQuickBooksInvoiceLinksForJob(companyId, jobId),
    [companyId, jobId, refreshKey],
    { onError: (err) => console.warn('InvoicesMenu load failed', err) },
  );
  const invoices = data ?? EMPTY;

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
              <MenuItem key={inv.id} onClick={() => setAnchor(null)}>
                <ListItemText
                  primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                  secondary={formatDate(inv.createdAt)}
                />
              </MenuItem>
            ),
          )
        )}
        {invoices.length > 0 && invoices.every((i) => !i.url) && (
          <MenuItem disabled sx={{ whiteSpace: 'normal', maxWidth: 320 }}>
            <ListItemText
              secondary="QuickBooks Desktop has no web page to link to — open the invoice in QuickBooks on the shop computer."
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
