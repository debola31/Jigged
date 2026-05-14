'use client';

import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Box from '@mui/material/Box';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DownloadIcon from '@mui/icons-material/Download';
import type { ConflictDialogProps } from './types';

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Shared dialog for displaying import conflicts and validation errors.
 * Works for both customers and parts imports.
 */
export default function ConflictDialog<
  TConflict extends { row_number: number },
  TError extends { row_number: number; message?: string; field?: string }
>({
  open,
  conflicts,
  validationErrors,
  validRowsCount,
  totalRows,
  onCancel,
  onConfirm,
  entityName,
  conflictColumns,
  getConflictLabel,
  getErrorMessage,
}: ConflictDialogProps<TConflict, TError>) {
  // Calculate unique rows with issues
  const conflictRowNumbers = new Set(conflicts.map((c) => c.row_number));
  const errorRowNumbers = new Set(validationErrors.map((e) => e.row_number));
  const totalSkippedRows = new Set([...conflictRowNumbers, ...errorRowNumbers]).size;

  const entitySlug = entityName.toLowerCase().replace(/\s+/g, '-');

  const handleDownloadConflicts = () => {
    const headers = ['Row', ...conflictColumns.map((c) => c.label), 'Conflict', 'Conflicting With'];
    const rows = conflicts.map((conflict) => {
      const record = conflict as Record<string, unknown>;
      return [
        conflict.row_number,
        ...conflictColumns.map((col) => (record[col.key] as string) ?? ''),
        getConflictLabel(conflict),
        (record.existing_value as string) ?? '',
      ];
    });
    downloadCsv(`${entitySlug}-import-conflicts.csv`, headers, rows);
  };

  const handleDownloadErrors = () => {
    const headers = ['Row', 'Error'];
    const rows = validationErrors.map((error) => [error.row_number, getErrorMessage(error)]);
    downloadCsv(`${entitySlug}-import-errors.csv`, headers, rows);
  };

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningAmberIcon color="warning" />
        Issues Detected
      </DialogTitle>
      <DialogContent>
        {/* Stats Row */}
        <Box sx={{ display: 'flex', gap: 4, mb: 3 }}>
          <Box>
            <Typography variant="h4" fontWeight={600}>
              {validRowsCount}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Can be imported
            </Typography>
          </Box>
          <Box>
            <Typography variant="h4" fontWeight={600} color="warning.main">
              {totalSkippedRows}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Will be skipped
            </Typography>
          </Box>
          <Box>
            <Typography variant="h4" fontWeight={600} color="text.secondary">
              {totalRows}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Total rows
            </Typography>
          </Box>
        </Box>

        {/* Conflicts Table */}
        {conflicts.length > 0 && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Conflicting Rows ({conflicts.length})
              </Typography>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={handleDownloadConflicts}
              >
                Download CSV
              </Button>
            </Box>
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>Row</TableCell>
                    {conflictColumns.map((col) => (
                      <TableCell key={col.key} sx={{ fontWeight: 600 }}>
                        {col.label}
                      </TableCell>
                    ))}
                    <TableCell sx={{ fontWeight: 600 }}>Conflict</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Conflicting With</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {conflicts.map((conflict, idx) => (
                    <TableRow key={`${conflict.row_number}-${idx}`}>
                      <TableCell>{conflict.row_number}</TableCell>
                      {conflictColumns.map((col) => (
                        <TableCell key={col.key}>
                          {(conflict as Record<string, unknown>)[col.key] as string || '—'}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {getConflictLabel(conflict)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {(conflict as Record<string, unknown>).existing_value as string || '—'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {/* Validation Errors Table */}
        {validationErrors.length > 0 && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 3, mb: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Validation Errors ({validationErrors.length})
              </Typography>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={handleDownloadErrors}
              >
                Download CSV
              </Button>
            </Box>
            <TableContainer sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>Row</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Error</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {validationErrors.map((error, idx) => (
                    <TableRow key={`${error.row_number}-${idx}`}>
                      <TableCell>{error.row_number}</TableCell>
                      <TableCell>
                        <Typography variant="body2" color="error.main">
                          {getErrorMessage(error)}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 3, pt: 0 }}>
        <Button onClick={onCancel} color="inherit">
          Cancel Import
        </Button>
        <Button
          onClick={onConfirm}
          variant="contained"
          color="primary"
          disabled={validRowsCount === 0}
        >
          Import {validRowsCount} {entityName}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
