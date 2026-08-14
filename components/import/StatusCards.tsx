'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import type { StatusCardsProps } from './types';

/**
 * Status cards shown above the mapping table.
 * - Error alert for missing required fields
 * - Warning-tinted card for unmapped optional fields
 * - Gray-tinted card for discarded columns
 */
export default function StatusCards({
  unmappedRequired,
  unmappedOptional,
  discardedColumns,
  fields,
}: StatusCardsProps) {
  // Helper to get field label from key
  const getFieldLabel = (key: string) => {
    const field = fields.find((f) => f.key === key);
    return field?.label || key;
  };

  return (
    <>
      {/* Missing Required Fields Card */}
      {unmappedRequired.length > 0 && (
        <Card
          elevation={1}
          sx={{
            bgcolor: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          <CardContent>
            <Typography variant="subtitle2" color="error.main" gutterBottom>
              Missing required fields ({unmappedRequired.length})
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              These fields must be mapped before you can import.
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {unmappedRequired.map((fieldKey) => (
                <Chip
                  key={fieldKey}
                  label={getFieldLabel(fieldKey)}
                  size="small"
                  color="error"
                  variant="outlined"
                  // An OUTLINED chip draws its label in error.main, which is
                  // under the 4.5:1 body floor on a card. A filled error chip
                  // needs no such treatment — that one is white on red.
                  sx={{ color: 'error.light', borderColor: 'error.light' }}
                />
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Unmapped Optional Fields */}
      {unmappedOptional.length > 0 && (
        <Card
          elevation={1}
          sx={{
            bgcolor: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
          }}
        >
          <CardContent>
            <Typography variant="subtitle2" color="warning.main" gutterBottom>
              Optional fields that are missing ({unmappedOptional.length})
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              These fields will be left empty for imported records. You can proceed without mapping them.
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {unmappedOptional.map((fieldKey) => (
                <Chip
                  key={fieldKey}
                  label={getFieldLabel(fieldKey)}
                  size="small"
                  color="warning"
                  variant="outlined"
                />
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Discarded Columns */}
      {discardedColumns.length > 0 && (
        <Card elevation={1} sx={{ bgcolor: 'rgba(0, 0, 0, 0.02)' }}>
          <CardContent>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              CSV columns that will be skipped ({discardedColumns.length})
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {discardedColumns.map((col) => (
                <Chip
                  key={col}
                  label={col}
                  size="small"
                  variant="outlined"
                  sx={{ opacity: 0.7 }}
                />
              ))}
            </Box>
          </CardContent>
        </Card>
      )}
    </>
  );
}
