'use client';

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { parseCSV } from '@/utils/csvParser';
import type { UploadedFilePayload } from '@/types/data-import';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file

interface MultiFileDropzoneProps {
  files: UploadedFilePayload[];
  onChange: (files: UploadedFilePayload[]) => void;
  disabled?: boolean;
}

/**
 * Multi-file drag-and-drop for legacy CSV exports. Parses each file locally into
 * {filename, headers, rows}. Parsing on drop does NOT trigger any AI call — the page's
 * explicit "Analyze" button does that (CLAUDE.md: AI requires a deliberate user action).
 */
export default function MultiFileDropzone({ files, onChange, disabled }: MultiFileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const parsed: UploadedFilePayload[] = [];
    const errors: string[] = [];

    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        errors.push(`${file.name} is larger than 10 MB`);
        continue;
      }
      try {
        const text = await file.text();
        const rows = parseCSV(text);
        if (rows.length === 0) {
          errors.push(`${file.name} is empty`);
          continue;
        }
        const headers = rows[0];
        const dataRows = rows.slice(1).map((cells) => {
          const record: Record<string, string> = {};
          headers.forEach((h, i) => {
            record[h] = cells[i] ?? '';
          });
          return record;
        });
        parsed.push({ filename: file.name, headers, rows: dataRows });
      } catch {
        errors.push(`Could not read ${file.name}`);
      }
    }

    if (errors.length) setError(errors.join('; '));
    if (parsed.length) {
      // De-dupe by filename: a re-added file replaces the previous parse.
      const byName = new Map(files.map((f) => [f.filename, f]));
      parsed.forEach((f) => byName.set(f.filename, f));
      onChange(Array.from(byName.values()));
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(filename: string) {
    onChange(files.filter((f) => f.filename !== filename));
  }

  return (
    <Box>
      <Box
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled) void addFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        sx={{
          border: '2px dashed',
          borderColor: dragOver ? 'primary.main' : 'divider',
          borderRadius: 2,
          p: 5,
          textAlign: 'center',
          cursor: disabled ? 'default' : 'pointer',
          bgcolor: dragOver ? 'action.hover' : 'transparent',
          transition: 'all 0.2s ease',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <UploadFileIcon sx={{ fontSize: 48, color: 'primary.main', mb: 1 }} />
        <Typography variant="h6" gutterBottom>
          Drop your legacy CSV exports here
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Parts, vendors, customers, work centers, routings, BOMs — add as many as you have.
          Nothing is imported or saved; this only reads your files.
        </Typography>
        <Button variant="outlined" component="span" disabled={disabled}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          hidden
          onChange={(e) => void addFiles(e.target.files)}
        />
      </Box>

      {error && (
        <Typography variant="body2" color="error.light" sx={{ mt: 1 }}>
          {error}
        </Typography>
      )}

      {files.length > 0 && (
        <List dense sx={{ mt: 2 }}>
          {files.map((f) => (
            <ListItem
              key={f.filename}
              secondaryAction={
                !disabled && (
                  <IconButton edge="end" aria-label={`Remove ${f.filename}`} onClick={() => removeFile(f.filename)}>
                    <DeleteOutlineIcon />
                  </IconButton>
                )
              }
            >
              <ListItemText
                primary={f.filename}
                secondary={
                  <Box component="span" sx={{ display: 'inline-flex', gap: 1, alignItems: 'center' }}>
                    <Chip size="small" label={`${f.rows.length} rows`} />
                    <Chip size="small" variant="outlined" label={`${f.headers.length} columns`} />
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
