'use client';

import { useState } from 'react';
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
  // Key to force a fresh CustomerForm each time the modal opens. Bumped in
  // onEnter (house convention) rather than a reset useEffect, which would trip
  // set-state-in-effect.
  const [formKey, setFormKey] = useState(0);

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
      TransitionProps={{ onEnter: () => setFormKey((prev) => prev + 1) }}
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
