'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import type { WorkingFile } from '@/lib/dataImportEditing';

interface FixToolbarProps {
  file: WorkingFile;
  onBulkReplace: (colId: string, find: string, replace: string) => void;
  onFillBlanks: (colId: string, value: string) => void;
  onOpenMerge: () => void;
}

/**
 * Bulk-fix controls for the active file: find-and-replace and fill-blanks across a whole
 * column (one undoable step each), plus the entry to merge look-alikes. "Don't fix data one
 * cell at a time." Remount per file (key) so the column pickers reset to the new headers.
 */
export default function FixToolbar({ file, onBulkReplace, onFillBlanks, onOpenMerge }: FixToolbarProps) {
  const headers = file.headers;
  const [frCol, setFrCol] = useState(headers[0] ?? '');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [fillCol, setFillCol] = useState(headers[0] ?? '');
  const [fillVal, setFillVal] = useState('');

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ minWidth: 96, fontWeight: 600 }}>
            Find &amp; replace
          </Typography>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="fr-col-label">Column</InputLabel>
            <Select
              labelId="fr-col-label"
              label="Column"
              value={frCol}
              onChange={(e) => setFrCol(e.target.value as string)}
            >
              {headers.map((h) => (
                <MenuItem key={h} value={h}>
                  {h}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField size="small" label="Find" value={find} onChange={(e) => setFind(e.target.value)} sx={{ width: 150 }} />
          <TextField
            size="small"
            label="Replace with"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            sx={{ width: 150 }}
          />
          <Button
            variant="outlined"
            size="small"
            disabled={!find}
            onClick={() => {
              onBulkReplace(frCol, find, replace);
              setFind('');
              setReplace('');
            }}
          >
            Replace all
          </Button>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ minWidth: 96, fontWeight: 600 }}>
            Fill blanks
          </Typography>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel id="fill-col-label">Column</InputLabel>
            <Select
              labelId="fill-col-label"
              label="Column"
              value={fillCol}
              onChange={(e) => setFillCol(e.target.value as string)}
            >
              {headers.map((h) => (
                <MenuItem key={h} value={h}>
                  {h}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Value"
            value={fillVal}
            onChange={(e) => setFillVal(e.target.value)}
            sx={{ width: 150 }}
          />
          <Button
            variant="outlined"
            size="small"
            disabled={!fillVal}
            onClick={() => {
              onFillBlanks(fillCol, fillVal);
              setFillVal('');
            }}
          >
            Fill blanks
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button variant="outlined" size="small" startIcon={<CallMergeIcon />} onClick={onOpenMerge}>
            Merge look-alikes…
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
