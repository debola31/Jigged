'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useLoad } from '@/hooks/useLoad';
import { listLotCertificatesForLots } from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';
import LotCertificateControl from './LotCertificateControl';

const EMPTY_CERTS = new Map<string, LotCertificate[]>();

export interface LandedLot {
  lotId: string;
  partName: string;
  /** e.g. "Heat 4471", or null when the material arrived without a readable one. */
  heatLabel: string | null;
}

interface CertAfterBatchPanelProps {
  companyId: string;
  /** Every lot the batch landed on, in the order the lines were written. */
  lots: LandedLot[];
  onDone: () => void;
}

/**
 * The certificates for a batch put-away — several heats landing in one gesture.
 *
 * The sibling of `CertAfterReceiptPanel`, and it exists because that one owns a `Done`: N panels
 * would mean N Done buttons, none of which is the one that finishes. So this renders one control
 * per lot and one Done for the lot of them.
 *
 * **This is the receiving-bench case.** A delivery arrives under several heats and goes onto the
 * shelf in a single pass, which is precisely where "are people expected to scan things and upload"
 * was aimed — so the certs are offered together, once, after the stock is already recorded, and
 * skipping is a single click.
 *
 * Offered only after a batch in which every line landed. A partial failure already owns the form
 * with its own disarm-what-succeeded protocol, and stacking a second post-write state on top of
 * that one would give two things claiming to describe what just happened.
 */
export default function CertAfterBatchPanel({ companyId, lots, onDone }: CertAfterBatchPanelProps) {
  const [error, setError] = useState<string | null>(null);

  const lotIds = lots.map((l) => l.lotId);
  const lotKey = lotIds.join(',');
  const { data: certsData, reload } = useLoad(() => listLotCertificatesForLots(lotIds), [lotKey]);
  const certsByLot = certsData ?? EMPTY_CERTS;

  return (
    <Box>
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setError(null)}>
          The stock is recorded. {error}
        </Alert>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {lots.length === 1
          ? 'Stocked. Add the mill certificate, or do it later from the part.'
          : `${lots.length} lots stocked. Add their mill certificates, or do it later from the part.`}
      </Typography>

      <Stack spacing={1} sx={{ mb: 2 }}>
        {lots.map((lot) => (
          <Paper
            key={lot.lotId}
            variant="outlined"
            sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 2 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap>{lot.partName}</Typography>
              {lot.heatLabel && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {lot.heatLabel}
                </Typography>
              )}
            </Box>
            <LotCertificateControl
              companyId={companyId}
              lotId={lot.lotId}
              heatLabel={lot.heatLabel}
              certificates={certsByLot.get(lot.lotId) ?? []}
              surface="office_batch"
              atReceipt
              onChanged={reload}
              onError={setError}
            />
          </Paper>
        ))}
      </Stack>

      {/* One Done for the batch, always enabled: nothing about a certificate may stand between
          someone and finishing a put-away. */}
      <Button autoFocus variant="contained" onClick={onDone}>
        Done
      </Button>
    </Box>
  );
}
