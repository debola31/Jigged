'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TablePagination from '@mui/material/TablePagination';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import EditIcon from '@mui/icons-material/Edit';
import NextLink from 'next/link';
import type { InventoryTransactionWithRelations } from '@/types/partTransaction';
import {
  getTransactionTypeDisplay,
  formatTransactionDate,
  formatQuantityWithUnit,
} from '@/types/partTransaction';
import { getPartTransactions, updateTransactionNotes } from '@/utils/partsAccess';
import SaveStatus from '@/components/common/SaveStatus';

interface PartTransactionHistoryTableProps {
  partId: string;
  companyId: string;
  /** The part's primary unit of measurement */
  primaryUnit: string;
  /** Trigger a refresh from parent */
  refreshKey?: number;
}

export default function PartTransactionHistoryTable({
  partId,
  companyId,
  primaryUnit,
  refreshKey = 0,
}: PartTransactionHistoryTableProps) {
  const [transactions, setTransactions] = useState<InventoryTransactionWithRelations[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Inline notes editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    const fetchTransactions = async () => {
      setLoading(true);
      try {
        const { transactions: data, total: count } = await getPartTransactions(
          partId,
          page * rowsPerPage,
          rowsPerPage,
        );
        setTransactions(data as InventoryTransactionWithRelations[]);
        setTotal(count);
      } catch (err) {
        console.error('Error fetching transactions:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTransactions();
  }, [partId, page, rowsPerPage, refreshKey]);

  const handleChangePage = (_: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleStartEdit = (transaction: InventoryTransactionWithRelations) => {
    setEditingId(transaction.id);
    setEditingNotes(transaction.notes || '');
  };

  const handleSaveNotes = async () => {
    if (!editingId) return;

    setSavingNotes(true);
    try {
      await updateTransactionNotes(editingId, editingNotes);
      // Update local state
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === editingId ? { ...t, notes: editingNotes || null } : t
        )
      );
      setEditingId(null);
    } catch (err) {
      console.error('Error saving notes:', err);
    } finally {
      setSavingNotes(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  const handleNotesKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveNotes();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  if (loading && transactions.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!loading && transactions.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body1" color="text.secondary">
          No transactions recorded yet.
        </Typography>
      </Box>
    );
  }

  return (
    <Paper elevation={0} sx={{ border: '1px solid', borderColor: 'divider' }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Date & Time</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Type</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="right">Quantity</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Related Job</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Notes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {transactions.map((transaction) => {
              const typeDisplay = getTransactionTypeDisplay(transaction.type);

              return (
                <TableRow key={transaction.id} hover>
                  <TableCell>
                    <Typography variant="body2">
                      {formatTransactionDate(transaction.created_at)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Chip
                        label={typeDisplay.label}
                        size="small"
                        color={typeDisplay.color}
                        variant="outlined"
                      />
                      {transaction.has_discrepancy && (
                        <Chip
                          label="Discrepancy"
                          size="small"
                          color="warning"
                          variant="filled"
                        />
                      )}
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                        color:
                          transaction.type === 'addition'
                            ? 'success.main'
                            : transaction.type === 'depletion'
                            ? 'error.main'
                            : 'info.main',
                      }}
                    >
                      {typeDisplay.sign}
                      {formatQuantityWithUnit(transaction.quantity, transaction.unit)}
                    </Typography>
                    {transaction.unit !== primaryUnit && (
                      <Typography variant="caption" color="text.secondary">
                        = {formatQuantityWithUnit(transaction.converted_quantity, primaryUnit)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {transaction.job ? (
                      <Link
                        component={NextLink}
                        href={`/dashboard/${companyId}/jobs/${transaction.job.id}`}
                        underline="hover"
                      >
                        {transaction.job.job_number}
                      </Link>
                    ) : transaction.job_operation ? (
                      <Typography variant="body2" color="text.secondary">
                        Op: {transaction.job_operation.operation_name}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {editingId === transaction.id ? (
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        <TextField
                          value={editingNotes}
                          onChange={(e) => setEditingNotes(e.target.value)}
                          onBlur={handleSaveNotes}
                          onKeyDown={handleNotesKeyDown}
                          size="small"
                          multiline
                          maxRows={3}
                          autoFocus
                          disabled={savingNotes}
                          sx={{ minWidth: 180 }}
                          placeholder="Add notes..."
                        />
                        {savingNotes && <SaveStatus state="saving" />}
                      </Box>
                    ) : (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            maxWidth: 200,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={transaction.notes || undefined}
                        >
                          {transaction.notes || '—'}
                        </Typography>
                        <IconButton
                          size="small"
                          onClick={() => handleStartEdit(transaction)}
                          sx={{ opacity: 0.5, '&:hover': { opacity: 1 } }}
                        >
                          <EditIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Box>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={total}
        page={page}
        onPageChange={handleChangePage}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={handleChangeRowsPerPage}
        rowsPerPageOptions={[5, 10, 25, 50]}
      />
    </Paper>
  );
}
