'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import PartForm from './PartForm';
import { EMPTY_PART_FORM } from '@/types/part';
import type { Part } from '@/types/part';

interface PartFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (part: Part) => void;
  companyId: string;
}

/**
 * Modal wrapper for PartForm to enable quick part creation.
 * Used in QuoteForm for inline part creation.
 */
export default function PartFormModal({
  open,
  onClose,
  onCreated,
  companyId,
}: PartFormModalProps) {
  // Key to force re-render of form when modal opens
  const [formKey, setFormKey] = useState(0);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setFormKey((prev) => prev + 1);
    }
  }, [open]);

  const handleSuccess = (part?: Part) => {
    if (part) {
      onCreated(part);
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      scroll="paper"
      PaperProps={{
        sx: {
          maxHeight: '90vh',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        Create New Part
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <PartForm
          key={formKey}
          mode="create"
          companyId={companyId}
          initialData={EMPTY_PART_FORM}
          onSuccess={handleSuccess}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
