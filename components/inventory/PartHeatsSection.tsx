'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useLoad } from '@/hooks/useLoad';
import { getLotsForPart, setPartLotTracking } from '@/utils/inventoryLocationsAccess';
import { listLotCertificatesForLots } from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';
import LotCertificateControl from './LotCertificateControl';

const EMPTY_CERTS = new Map<string, LotCertificate[]>();

interface PartHeatsSectionProps {
  partId: string;
  companyId: string;
  /** Bumped by the drawer after any write, so a new heat or a new cert shows without a reload. */
  refreshKey: number;
  /** A write landed — the drawer re-reads, and the part's tracking flag with it. */
  onChanged: () => void | Promise<void>;
}

/**
 * Every heat this part has ever carried, its certificate, and the way out of heat tracking.
 *
 * **Lives in the side rail on Storage → Inventory**, which is the only per-part storage surface
 * there is now. It was on the part detail page's own Storage tab until 2026-09-09; that tab is
 * gone, because most parts are never stocked and a tab that is empty for most of a catalogue is a
 * tab people learn to ignore — and the one place someone looks for a part's heats is the drawer
 * they opened by clicking that part in the stock list.
 *
 * **Balances cannot drive this.** `getLotsForPart` returns every lot ever recorded against the
 * part, not only what is still on a shelf, and that is the whole point: the question people are
 * actually asked is *"the customer wants the cert for heat 4471"* about material consumed last
 * month, which has no balance row at all.
 */
export default function PartHeatsSection({
  partId,
  companyId,
  refreshKey,
  onChanged,
}: PartHeatsSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const [untracking, setUntracking] = useState(false);

  const { data: lots, loading } = useLoad(() => getLotsForPart(partId), [partId, refreshKey]);
  const lotIds = (lots ?? []).map((l) => l.lotId);
  const lotKey = lotIds.join(',');
  const { data: certsData, reload: reloadCerts } = useLoad(
    () => listLotCertificatesForLots(lotIds),
    [lotKey, refreshKey],
  );
  const certsByLot = certsData ?? EMPTY_CERTS;

  /*
   * The way back out of heat tracking, and the reason this section carries it.
   *
   * Tracking turns itself ON — writing a heat IS the decision to trace the part — which leaves one
   * trap: a heat typed by mistake makes the part demand one on every removal, forever, with no
   * visible cause. The escape has to sit where someone would come looking, and that is beside the
   * heats themselves.
   *
   * Turning it off does NOT merge the split balances back together: the flag stops future
   * enforcement, it is not an instruction to forget what has been traced.
   */
  const stopTracking = async () => {
    setUntracking(true);
    setError(null);
    try {
      await setPartLotTracking(partId, false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop tracking heats for this part.');
    } finally {
      setUntracking(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  // No heats, no section. An untracked part is most parts, and a header over nothing is clutter.
  if (!lots || lots.length === 0) return null;

  return (
    <Box sx={{ mt: 3 }}>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ textTransform: 'uppercase', letterSpacing: 0.4, fontSize: '0.7rem', mb: 1 }}
      >
        Heats and certificates
      </Typography>

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
              {/* A minted code means the material arrived with no readable heat. Say that, rather
                  than print an invented number as though a mill had issued it. */}
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
              // Chased later, from a read surface — never the receipt itself.
              atReceipt={false}
              onChanged={reloadCerts}
              onError={setError}
            />
          </Paper>
        ))}
      </Stack>

      <Button size="small" disabled={untracking} onClick={stopTracking} sx={{ mt: 1 }}>
        {untracking ? 'Stopping…' : 'Stop tracking heats'}
      </Button>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        Stock already split by heat stays split — this only stops asking on the way out.
      </Typography>
    </Box>
  );
}
