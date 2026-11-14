'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import type { BuyListVendorChoice } from '@/types/buyList';

export interface BuyListVendorPickerProps {
  companyId: string;
  partName: string;
  /** Vendors on the part's list marked Do not use: refused here, as the PO would refuse them. */
  doNotUseVendorIds: readonly string[];
  onClose: () => void;
  onPick: (choice: BuyListVendorChoice) => void;
}

/**
 * "Buy from" → "Another vendor…": any live vendor, for a part whose list has nobody suitable (most
 * parts, before a shop has filled in approved vendors). The row moves to that vendor's group and is
 * priced from its own history — the list never re-reads. A vendor marked Do not use for the part is
 * refused here with the reason, because the PO would refuse it anyway.
 *
 * Mounted only while open: the vendor picker loads every vendor, which nothing should pay for on
 * every row of the list.
 */
export default function BuyListVendorPicker({
  companyId,
  partName,
  doNotUseVendorIds,
  onClose,
  onPick,
}: BuyListVendorPickerProps) {
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const blocked = vendor !== null && doNotUseVendorIds.includes(vendor.id);

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Buy {partName} from another vendor</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          <VendorAutocomplete
            companyId={companyId}
            label="Vendor"
            valueId={vendor?.id ?? null}
            onChange={(v) => setVendor(v ? { id: v.id, name: v.name } : null)}
          />
        </Box>
        {blocked ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {vendor.name} is marked Do not use for {partName}.
          </Alert>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            A vendor that isn&apos;t on {partName}&apos;s list can still be ordered from. Add it on the
            part&apos;s Buying tab to keep its price sheet.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!vendor || blocked}
          onClick={() => vendor && onPick({ vendorId: vendor.id, vendorName: vendor.name })}
        >
          {vendor ? `Buy from ${vendor.name}` : 'Buy from this vendor'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
