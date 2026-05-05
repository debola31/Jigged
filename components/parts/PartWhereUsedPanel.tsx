'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import TablePagination from '@mui/material/TablePagination';
import NextLink from 'next/link';
import { getBomParents } from '@/utils/bomAccess';
import type { BomLineWithParentPart } from '@/types/bom';

interface PartWhereUsedPanelProps {
  partId: string;
  companyId: string;
}

const formatQuantity = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Read-only "where used" view: lists the parents whose BOM includes this
 * part as a child. Editing happens from the parent's BOM panel — here we
 * only navigate.
 *
 * Paginated client-side at 25 rows per page. Some Contour parts have 159
 * parents; rendering them all in a single scrollable list would be fine
 * functionally, but pagination keeps the panel a predictable height and
 * matches the transaction-history table's UX.
 */
export default function PartWhereUsedPanel({ partId, companyId }: PartWhereUsedPanelProps) {
  const [rows, setRows] = useState<BomLineWithParentPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBomParents(partId)
      .then((data) => {
        if (cancelled) return;
        setRows(data);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load BOM parents:', err);
        setError(err instanceof Error ? err.message : 'Failed to load where-used list.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

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
              <Link
                component={NextLink}
                href={`/dashboard/${companyId}/parts/${row.parent_part.id}`}
                underline="hover"
                sx={{ fontWeight: 500 }}
              >
                {row.parent_part.part_name}
              </Link>
              {row.notes && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 0.5 }}
                >
                  {row.notes}
                </Typography>
              )}
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
