'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import { useLoad } from '@/hooks/useLoad';
import { getCurrentMember } from '@/utils/operatorAccess';
import { getJobPartMaterialCheck, getUnassignedLocation } from '@/utils/materialCheckAccess';
import { locationLabel } from '@/lib/materialRequirements';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import OperatorIssueMaterialModal from '@/components/operator/OperatorIssueMaterialModal';
import type { MaterialRequirement } from '@/types/materialCheck';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

interface OperatorJobMaterialsProps {
  companyId: string;
  jobId: string;
  jobNumber: string;
  jobPartId: string;
  madePartId: string;
  madePartName: string | null;
  orderQuantity: number;
}

/**
 * "What this job needs, and where it is" — journey J7 on the operator surface.
 *
 * Sits ABOVE the steps on the traveler, because material comes before work: the operator's
 * first act on a job is fetching what it takes. Tapping a row records the take against the
 * job, which is the whole point — the depletion is job-linked by construction rather than by
 * an optional field somebody has to remember.
 *
 * Loaded in its OWN `useLoad`, not by widening `getJobPartTraveler`. The traveler's primary
 * job is navigation and it must not get slower to render because material lookup got heavier;
 * this streams in beside it with its own spinner.
 */
export default function OperatorJobMaterials({
  companyId,
  jobId,
  jobNumber,
  jobPartId,
  madePartId,
  madePartName,
  orderQuantity,
}: OperatorJobMaterialsProps) {
  const [picked, setPicked] = useState<MaterialRequirement | null>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [authorId, setAuthorId] = useState<string | null>(null);

  // Best-effort: an unresolvable member just means an unstamped ledger row, never a blocked
  // take. Same shape as the bin page.
  useEffect(() => {
    let cancelled = false;
    getCurrentMember(companyId)
      .then((m) => {
        if (cancelled || !m) return;
        setOperatorId(m.id);
        setAuthorId(m.user_id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const { data, loading, reload } = useLoad(
    async () => {
      const [requirements, unassigned] = await Promise.all([
        getJobPartMaterialCheck({
          companyId, jobId, jobPartId, madePartId, orderQuantity, withLocations: true,
        }),
        getUnassignedLocation(companyId).catch(() => null),
      ]);
      return { requirements, unassigned };
    },
    [companyId, jobId, jobPartId, madePartId, orderQuantity],
  );

  const requirements = data?.requirements ?? [];
  const unitOptions = useMemo(
    () => (picked ? getStandardUnitsForUnit(picked.stockUnit ?? picked.bomUnit) : []),
    [picked],
  );

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  if (requirements.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Material
      </Typography>
      <Card elevation={2} sx={{ ...cardSx, mt: 0.5 }}>
        {requirements.map((r, i) => (
          <Box key={r.bomLineId}>
            {i > 0 && <Divider />}
            <MaterialRow row={r} onTake={() => setPicked(r)} />
          </Box>
        ))}
      </Card>

      {picked && (
        <OperatorIssueMaterialModal
          open
          companyId={companyId}
          jobId={jobId}
          jobNumber={jobNumber}
          jobPartId={jobPartId}
          madePartName={madePartName}
          requirement={picked}
          unassigned={data?.unassigned ?? null}
          unitOptions={unitOptions}
          operatorId={operatorId}
          authorId={authorId}
          onClose={() => setPicked(null)}
          onDone={reload}
        />
      )}
    </Box>
  );
}

function MaterialRow({ row, onTake }: { row: MaterialRequirement; onTake: () => void }) {
  const unit = row.stockUnit ?? row.bomUnit;
  const held = row.locations.filter((l) => l.quantity > 0);

  // Where it is, in one line. Several bins says how many rather than listing them — the
  // picker in the modal is where that choice belongs.
  const where = !row.isLocationTracked
    ? null
    : held.length === 0
      ? 'Not at any location'
      : held.length === 1
        ? `${locationLabel(held[0])} · ${fmt(held[0].quantity)} ${unit} here`
        : `${held.length} locations`;

  const done = row.remainingToIssue !== null && row.remainingToIssue <= 0;

  return (
    <ListItemButton onClick={onTake} sx={{ minHeight: 56, py: 1.25, alignItems: 'flex-start' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body1" sx={{ fontWeight: 600 }}>
          {row.partName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {row.status === 'incomparable'
            ? `Needs ${fmt(row.requiredInBomUnit)} ${row.bomUnit}`
            : `Need ${fmt(row.requiredInBomUnit)} ${row.bomUnit}`}
          {row.issued > 0 && ` · ${fmt(row.issued)} taken`}
          {row.remainingToIssue !== null && row.remainingToIssue > 0 && row.issued > 0 &&
            ` · ${fmt(row.remainingToIssue)} to go`}
        </Typography>
        {where && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {where}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
          {done && <Chip size="small" color="success" variant="outlined" label="Got it all" />}
          {row.status === 'short' && (
            <Chip size="small" color="warning" variant="outlined" label={`Short ${fmt(row.shortBy ?? 0)}`} />
          )}
          {/* Still tappable — never block the floor on a data-quality gap. */}
          {row.status === 'incomparable' && (
            <Chip size="small" color="warning" variant="outlined" label="Can't compare units" />
          )}
          {row.hasDiscrepancy && (
            <Chip size="small" color="warning" variant="outlined" label="Shortfall recorded" />
          )}
        </Box>
      </Box>
      <ChevronRightIcon sx={{ color: 'text.secondary', mt: 0.5 }} />
    </ListItemButton>
  );
}
