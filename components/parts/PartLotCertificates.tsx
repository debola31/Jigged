'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';

import { useLoad } from '@/hooks/useLoad';
import { getLotsForPart } from '@/utils/inventoryLocationsAccess';
import { listLotCertificatesForLots } from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';
import LotCertificateControl from '@/components/inventory/LotCertificateControl';

const EMPTY_CERTS = new Map<string, LotCertificate[]>();

interface PartLotCertificatesProps {
  partId: string;
  companyId: string;
}

/**
 * Every heat this part has ever carried, and the certificate against each.
 *
 * **This is the office path, and it is the only surface that can answer the question that actually
 * gets asked**: *"the customer wants the cert for heat 4471"* — about a heat consumed last month.
 * `PartLocationInventory` is driven by BALANCES, so a lot with nothing left on the shelf has no row
 * there at all; `getLotsForPart` is deliberately not balance-scoped, and certificates are its
 * second legitimate caller.
 *
 * Not in `FilesTab`: that holds part-level engineering files (drawings, models). A cert belongs to
 * a lot, which is the entire reason `lot_certificates` is a separate table rather than a `kind` on
 * `part_attachments`.
 *
 * Rendered only for a lot-tracked part, so an untracked one issues no request from here.
 */
export default function PartLotCertificates({ partId, companyId }: PartLotCertificatesProps) {
  const [error, setError] = useState<string | null>(null);

  const { data: lots, loading } = useLoad(() => getLotsForPart(partId), [partId]);
  const lotIds = (lots ?? []).map((l) => l.lotId);
  const lotKey = lotIds.join(',');
  const { data: certsData, reload: reloadCerts } = useLoad(
    () => listLotCertificatesForLots(lotIds),
    [lotKey],
  );
  const certsByLot = certsData ?? EMPTY_CERTS;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (!lots || lots.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No heats recorded yet. Recording one on a receipt is what starts tracing this part.
      </Typography>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Stack spacing={1}>
        {lots.map((lot) => (
          <Paper
            key={lot.lotId}
            variant="outlined"
            sx={{ px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 2 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap>
                {lot.heatNumber ? `Heat ${lot.heatNumber}` : lot.lotCode}
              </Typography>
              {/* A minted code means the material arrived with no readable heat — say so rather
                  than printing an invented number as though the mill had supplied it. */}
              {!lot.heatNumber && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Arrived without a mill heat
                </Typography>
              )}
            </Box>
            <LotCertificateControl
              companyId={companyId}
              lotId={lot.lotId}
              heatLabel={lot.heatNumber ? `Heat ${lot.heatNumber}` : lot.lotCode}
              certificates={certsByLot.get(lot.lotId) ?? []}
              surface="office_lot"
              onChanged={reloadCerts}
              onError={setError}
            />
          </Paper>
        ))}
      </Stack>
    </Box>
  );
}
