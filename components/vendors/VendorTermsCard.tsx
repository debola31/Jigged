'use client';

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';

import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import { setVendorDefaultPaymentTerms } from '@/utils/vendorsAccess';

export interface VendorTermsCardProps {
  companyId: string;
  vendorId: string;
  vendorName: string;
  /** `vendors.default_payment_terms` as loaded with the vendor. */
  terms: string | null;
}

/**
 * The vendor's standing payment terms — the PO-side twin of `CustomerTermsCard`.
 *
 * AUTO-SAVE (interaction-standards §2 mode 1). Standing terms are non-financial by that section's
 * own test: they seed a NEW purchase order to this vendor and nothing else. A PO freezes the terms
 * it was raised on and never reads these again, so a slip here cannot change what any open PO says.
 *
 * QUICKBOOKS ONLY ON A CLICK. The picker leads with QuickBooks' own terms (so a term chosen here
 * resolves to a real QuickBooks term when a PO is pushed), and for QuickBooks Online that list is a
 * live call — so it loads when the picker opens, never with the page (`lazyQuickBooksTerms`, plan
 * §2 "QB read").
 *
 * Not instrumented, by the plan's choice (docs/telemetry.md): a single standing field no question
 * depends on.
 */
export default function VendorTermsCard({ companyId, vendorId, vendorName, terms }: VendorTermsCardProps) {
  const [value, setValue] = useState(terms ?? '');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Only the newest save may report: two quick picks must not end on the older one's answer.
  const latest = useRef(0);

  const save = async (next: string) => {
    const request = ++latest.current;
    setValue(next);
    setSaveState('saving');
    try {
      const stored = await setVendorDefaultPaymentTerms(vendorId, next.trim() || null);
      if (request !== latest.current) return;
      setValue(stored ?? '');
      setSaveState('saved');
    } catch {
      if (request === latest.current) setSaveState('error');
    }
  };

  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Terms
          </Typography>
          <SaveStatus state={saveState} />
        </Box>
        <PaymentTermsPicker
          companyId={companyId}
          value={value}
          onChange={(next) => void save(next)}
          size="medium"
          lazyQuickBooksTerms
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Applied to new purchase orders to {vendorName}. POs already raised keep the terms they were
          created with.
        </Typography>
      </CardContent>
    </Card>
  );
}
