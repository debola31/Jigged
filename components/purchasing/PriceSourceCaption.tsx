'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import type { VendorPoPriceSource } from '@/types/vendorPo';

export interface PriceSourceCaptionProps {
  /** Where the price came from, in words: "Acme price sheet · 10+ bar · valid to 3/1/27". */
  caption: string;
  /** Worth saying, did not change the answer: "Acme's sheet expired 3/1 — not used". */
  warnings?: readonly string[];
}

/** A saved line's price source, named the way the default would have named it. */
export const SAVED_PRICE_SOURCE_CAPTION: Record<VendorPoPriceSource, string> = {
  price_sheet: 'From the price sheet',
  last_po: 'From the last PO price',
  estimate: 'From the part cost estimate',
  vendor_service: "From the vendor's service price",
  rfq: 'From the awarded quote',
  manual: 'Typed',
};

/**
 * The caption under a PO line's price that says where it came from (plan §3.5 "Price default",
 * criterion L2). The default is only ever a proposal — the caption is how the person can tell a
 * price the system filled in from one they typed, and the warnings say what was passed over (an
 * expired sheet is named, never used).
 */
export default function PriceSourceCaption({ caption, warnings = [] }: PriceSourceCaptionProps) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {caption}
      </Typography>
      {warnings.map((w) => (
        <Typography key={w} variant="caption" sx={{ display: 'block', color: 'warning.light' }}>
          {w}
        </Typography>
      ))}
    </Box>
  );
}
