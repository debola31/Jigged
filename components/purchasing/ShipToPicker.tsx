'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import AddressDisplay, { addressToLines } from '@/components/common/AddressDisplay';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import { highContrastToggleSx } from '@/lib/highContrastToggleSx';
import { getAllCustomers } from '@/utils/customerAccess';
import { getAddressesForCustomer } from '@/utils/customerAddressesAccess';
import { getAddressesForVendor } from '@/utils/vendorAddressesAccess';
import type { CustomerAddress } from '@/types/customer';
import type { VendorAddress } from '@/types/vendor';
import type { VendorPoShipToKind } from '@/types/vendorPo';

/** The ship-to as the form holds it; the RPC takes it as ONE `shipTo` key. */
export interface ShipToState {
  kind: VendorPoShipToKind;
  vendorId: string | null;
  vendorAddressId: string | null;
  customerId: string | null;
  customerAddressId: string | null;
}

export const SHOP_SHIP_TO: ShipToState = {
  kind: 'shop',
  vendorId: null,
  vendorAddressId: null,
  customerId: null,
  customerAddressId: null,
};

export interface ShipToPickerProps {
  companyId: string;
  value: ShipToState;
  onChange: (next: ShipToState) => void;
  disabled?: boolean;
}

function addressLabel(a: { address_line1: string | null; city: string | null; state: string | null }): string {
  return [a.address_line1, a.city, a.state].filter(Boolean).join(', ') || 'Address';
}

/**
 * Where the order ships (plan §3.13 "PO form"): our shop, another vendor (drop-shipped to the plater
 * that works on it next) or a customer. A segmented toggle, because it re-modes the same field
 * rather than switching views (design-system.md "Tabs vs. segmented toggles"). The address is a
 * pick from that party's address book, and the PO freezes a copy when it is saved — so what prints
 * is what was chosen, whatever the address book says later.
 */
export default function ShipToPicker({ companyId, value, onChange, disabled = false }: ShipToPickerProps) {
  const [vendorAddresses, setVendorAddresses] = useState<VendorAddress[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[]>([]);

  useEffect(() => {
    if (value.kind !== 'vendor' || !value.vendorId) return;
    let cancelled = false;
    getAddressesForVendor(value.vendorId)
      .then((rows) => {
        if (cancelled) return;
        setVendorAddresses(rows);
        // Their default address, unless one was already chosen.
        if (!value.vendorAddressId) {
          const def = rows.find((a) => a.is_default) ?? (rows.length === 1 ? rows[0] : null);
          if (def) onChange({ ...value, vendorAddressId: def.id });
        }
      })
      .catch(() => {
        if (!cancelled) setVendorAddresses([]);
      });
    return () => {
      cancelled = true;
    };
    // Re-read only when the vendor changes; `value` and `onChange` change every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.kind, value.vendorId]);

  useEffect(() => {
    if (value.kind !== 'customer') return;
    let cancelled = false;
    getAllCustomers(companyId)
      .then((rows) => {
        if (!cancelled) setCustomers(rows.map((c) => ({ id: c.id, label: c.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId, value.kind]);

  useEffect(() => {
    if (value.kind !== 'customer' || !value.customerId) return;
    let cancelled = false;
    getAddressesForCustomer(value.customerId)
      .then((rows) => {
        if (cancelled) return;
        setCustomerAddresses(rows);
        if (!value.customerAddressId) {
          const def = rows.find((a) => a.default_shipping) ?? (rows.length === 1 ? rows[0] : null);
          if (def) onChange({ ...value, customerAddressId: def.id });
        }
      })
      .catch(() => {
        if (!cancelled) setCustomerAddresses([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.kind, value.customerId]);

  const vendorAddress = vendorAddresses.find((a) => a.id === value.vendorAddressId) ?? null;
  const customerAddress = customerAddresses.find((a) => a.id === value.customerAddressId) ?? null;

  return (
    <Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value.kind}
        disabled={disabled}
        onChange={(_, next: VendorPoShipToKind | null) => {
          if (!next || next === value.kind) return;
          // Only the side the kind names: the RPC refuses ids on the wrong side.
          onChange({ ...SHOP_SHIP_TO, kind: next });
        }}
        sx={{ ...highContrastToggleSx, mb: 2, flexWrap: 'wrap' }}
        aria-label="Ship to"
      >
        <ToggleButton value="shop">Our shop</ToggleButton>
        <ToggleButton value="vendor">Another vendor</ToggleButton>
        <ToggleButton value="customer">A customer</ToggleButton>
      </ToggleButtonGroup>

      {value.kind === 'shop' && (
        <Typography variant="body2" color="text.secondary">
          Ships to your shop&apos;s address, as it is on your company settings.
        </Typography>
      )}

      {value.kind === 'vendor' && (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <VendorAutocomplete
            companyId={companyId}
            valueId={value.vendorId}
            onChange={(v) => onChange({ ...SHOP_SHIP_TO, kind: 'vendor', vendorId: v?.id ?? null })}
            label="Ship to vendor"
            disabled={disabled}
          />
          {value.vendorId && (
            <TextField
              select
              label="Their address"
              size="small"
              value={value.vendorAddressId ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, vendorAddressId: e.target.value || null })}
              helperText={vendorAddresses.length === 0 ? 'No address on file — the PO will say so.' : ' '}
            >
              <MenuItem value="">No address</MenuItem>
              {vendorAddresses.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {addressLabel(a)}
                </MenuItem>
              ))}
            </TextField>
          )}
          {vendorAddress && addressToLines(vendorAddress).length > 0 && <AddressDisplay address={vendorAddress} />}
        </Box>
      )}

      {value.kind === 'customer' && (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <SearchableSelect
            options={customers}
            value={value.customerId ?? ''}
            onChange={(id) => onChange({ ...SHOP_SHIP_TO, kind: 'customer', customerId: id || null })}
            label="Customer"
            size="small"
            disabled={disabled}
          />
          {value.customerId && (
            <TextField
              select
              label="Their address"
              size="small"
              value={value.customerAddressId ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, customerAddressId: e.target.value || null })}
              helperText={customerAddresses.length === 0 ? 'No address on file — the PO will say so.' : ' '}
            >
              <MenuItem value="">No address</MenuItem>
              {customerAddresses.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {addressLabel(a)}
                </MenuItem>
              ))}
            </TextField>
          )}
          {customerAddress && addressToLines(customerAddress).length > 0 && <AddressDisplay address={customerAddress} />}
        </Box>
      )}
    </Box>
  );
}
