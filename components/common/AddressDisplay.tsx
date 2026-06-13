'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * Minimal address shape shared by quotes and jobs — the nested PostgREST
 * projection of customer_addresses. Matches QuoteWithRelations /
 * JobWithRelations `customers.addresses[]` entries.
 */
export interface DisplayAddress {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  attention_to?: string | null;
}

/** Build the human-readable lines for an address (ATTN first, USA dropped). */
export function addressToLines(a: DisplayAddress): string[] {
  return [
    a.attention_to ? `ATTN: ${a.attention_to}` : null,
    a.address_line1,
    a.address_line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(', ').trim() || null,
    a.country && a.country.toUpperCase() !== 'USA' ? a.country : null,
  ].filter((l): l is string => !!l && l.toString().trim().length > 0);
}

/**
 * Read-only multi-line address block. Renders an em dash when the address is
 * null/empty so a missing address reads as an explicit gap, not a blank.
 */
export default function AddressDisplay({ address }: { address: DisplayAddress | null | undefined }) {
  const lines = address ? addressToLines(address) : [];
  if (lines.length === 0) {
    return (
      <Typography variant="body1" color="text.secondary">
        Not set
      </Typography>
    );
  }
  return (
    <Box>
      {lines.map((line, i) => (
        <Typography key={i} variant="body1" sx={{ fontWeight: i === 0 ? 500 : 400 }}>
          {line}
        </Typography>
      ))}
    </Box>
  );
}
