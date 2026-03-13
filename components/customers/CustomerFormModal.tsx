'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CustomerForm from './CustomerForm';
import { EMPTY_CUSTOMER_FORM } from '@/types/customer';
import type { Customer } from '@/types/customer';

interface CustomerFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (customer: Customer) => void;
  companyId: string;
}

/**
 * Modal wrapper for CustomerForm to enable quick customer creation.
 * Used in QuoteForm for inline customer creation.
 */
export default function CustomerFormModal({
  open,
  onClose,
  onCreated,
  companyId,
}: CustomerFormModalProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  // Key to force re-render of form when modal opens
  const [formKey, setFormKey] = useState(0);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setFormKey((prev) => prev + 1);
    }
  }, [open]);

  const handleSuccess = (customer: Customer) => {
    onCreated(customer);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      fullScreen={isMobile}
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
        Create New Customer
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <CustomerForm
          key={formKey}
          mode="create"
          initialData={EMPTY_CUSTOMER_FORM}
          companyId={companyId}
          onSuccess={handleSuccess}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
