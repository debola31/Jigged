'use client';

import { useMemo, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import TablePagination from '@mui/material/TablePagination';
import NextLink from 'next/link';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { getBomParents } from '@/utils/bomAccess';
import type { BomLineWithParentPart } from '@/types/bom';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';

interface PartWhereUsedPanelProps {
  partId: string;
  companyId: string;
  /**
   * Drill-down chain on the page hosting this panel — passed through to
   * `pushPartToChain` when building the parent-part hrefs so back-nav
   * breadcrumbs accumulate. Defaults to empty for callers outside the
   * part-detail page.
   */
  currentChain?: string[];
}

// Stable empty fallback so the paginate memo doesn't churn while the first load runs.
const EMPTY_PARENTS: BomLineWithParentPart[] = [];

const formatQuantity = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Read-only "where used" view: lists the parents whose BOM includes this
 * part as a child. Editing happens from the parent's BOM panel — here we
 * only navigate.
 *
 * Paginated client-side at 25 rows per page. Some real-shop parts have
 * 100+ parents; rendering them all in a single scrollable list would be
 * fine functionally, but pagination keeps the panel a predictable height
 * and matches the transaction-history table's UX.
 */
export default function PartWhereUsedPanel({
  partId,
  companyId,
  currentChain = [],
}: PartWhereUsedPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const { data: rowsData, loading } = useLoad(() => getBomParents(partId), [partId], {
    onError: (err) => {
      console.error('Failed to load BOM parents:', err);
      setError(err instanceof Error ? err.message : 'Failed to load where-used list.');
    },
  });
  const rows = rowsData ?? EMPTY_PARENTS;

  const visibleRows = useMemo(() => {
    const start = page * rowsPerPage;
    return rows.slice(start, start + rowsPerPage);
  }, [rows, page, rowsPerPage]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  if (rows.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body2" color="text.secondary">
          No other parts reference this part in their BOM.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Stack divider={<Divider flexItem />} spacing={0}>
        {visibleRows.map((row) => (
          <Box
            key={row.id}
            sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.5 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {/* Same link affordance as PartBomPanel: primary color +
                  always-underlined + chevron. Pushes the current part
                  onto the back chain so the parent renders a breadcrumb
                  back to here. */}
              <Link
                component={NextLink}
                href={buildPartHref({
                  companyId,
                  targetPartId: row.parent_part.id,
                  chain: pushPartToChain(currentChain, partId, row.parent_part.id),
                })}
                underline="always"
                color="primary.main"
                sx={{
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.25,
                }}
              >
                {row.parent_part.part_name}
                <ChevronRightIcon sx={{ fontSize: 16 }} />
              </Link>
            </Box>
            <Box sx={{ minWidth: 140, textAlign: 'right' }}>
              <Typography variant="body2" color="text.secondary">
                uses {formatQuantity(row.quantity)} {row.unit}
              </Typography>
            </Box>
          </Box>
        ))}
      </Stack>

      {rows.length > rowsPerPage && (
        <TablePagination
          component="div"
          count={rows.length}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          rowsPerPageOptions={[10, 25, 50, 100]}
        />
      )}
    </Box>
  );
}
