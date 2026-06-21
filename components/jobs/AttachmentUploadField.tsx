'use client';

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import { validateAttachmentFile } from '@/utils/jobAttachmentsAccess';

interface AttachmentUploadFieldProps {
  /** The currently staged file (held in the parent until the job exists). */
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Stages a single PDF in parent state without uploading. Used inside the
 * PO-intake and quote-convert modals (which upload after the job is created)
 * and reused by the job page's attachment card. Validates type/size on select
 * for immediate feedback.
 */
export default function AttachmentUploadField({
  file,
  onChange,
  disabled,
  label = 'Attach PO PDF (optional)',
}: AttachmentUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    // Reset so re-selecting the same file still fires onChange.
    e.target.value = '';
    if (!selected) return;
    const validationError = validateAttachmentFile(selected);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onChange(selected);
  };

  return (
    <Box>
      <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={handleSelect} />
      {file ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <AttachFileIcon fontSize="small" color="action" />
          <Typography
            variant="body2"
            sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {file.name}
          </Typography>
          <IconButton
            size="small"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-label="Remove attachment"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      ) : (
        <Button
          variant="outlined"
          size="small"
          startIcon={<AttachFileIcon />}
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          {label}
        </Button>
      )}
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
