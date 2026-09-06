'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import { getAllVendors } from '@/utils/vendorsAccess';
import { updatePartPreferredVendor } from '@/utils/partsAccess';
import type { Vendor } from '@/types/vendor';

interface PartPreferredVendorProps {
  partId: string;
  companyId: string;
  /** `parts.preferred_vendor_id` — pre-selects the matching vendor on mount. */
  preferredVendorId?: string | null;
  /** Called after a successful pick; the Vendors page derives its supplier role from this. */
  onSaved?: () => void;
}

/**
 * The preferred-vendor picker for a bought part.
 *
 * It used to sit inside the Cost card, above that card's explicitly-saved tier
 * table — an auto-save control and an explicit-Save control in one section,
 * which `docs/interaction-standards.md` §2 says never to mix. It was already
 * fenced into its own bordered block to soften that; splitting the cost ladder
 * out into the Pricing card let it become its own thing instead.
 *
 * **The vendor is a label, not a cost filter.** A part's tiers apply whoever
 * supplies it — `part_rollup_at_qty` never reads `preferred_vendor_id`. Auto-save
 * is the right mode for a single non-financial field.
 */
export default function PartPreferredVendor({
  partId,
  companyId,
  preferredVendorId,
  onSaved,
}: PartPreferredVendorProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(
    preferredVendorId ?? null,
  );
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedVendorId(preferredVendorId ?? null);
  }, [preferredVendorId]);

  useEffect(() => {
    let cancelled = false;
    getAllVendors(companyId)
      .then((rows) => !cancelled && setVendors(rows))
      .catch(() => !cancelled && setVendors([]));
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;

  // Optimistic: switch locally, then persist. A failure reverts and says so,
  // rather than leaving the picker showing a vendor that was never saved.
  const handlePick = async (vendor: Vendor | null) => {
    const nextId = vendor ? vendor.id : null;
    if (nextId === selectedVendorId) return;

    const prevId = selectedVendorId;
    setSelectedVendorId(nextId);
    setSaveState('saving');
    setError(null);
    try {
      await updatePartPreferredVendor(partId, nextId);
      setSaveState('saved');
      onSaved?.();
    } catch (err) {
      setSelectedVendorId(prevId);
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to set preferred vendor');
    }
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Autocomplete<Vendor>
          options={vendors}
          value={selectedVendor}
          onChange={(_e, next) => handlePick(next)}
          getOptionLabel={(v) => v.name}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          size="small"
          sx={{ flex: 1, minWidth: 260, maxWidth: 480 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Preferred vendor"
              placeholder="Pick a supplier (optional)"
              helperText="Saved as soon as you pick it. Pricing applies regardless of vendor."
            />
          )}
        />
        <Box sx={{ pt: 1 }}>
          <SaveStatus state={saveState} />
        </Box>
      </Box>
    </Box>
  );
}
