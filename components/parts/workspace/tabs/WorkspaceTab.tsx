'use client';

import { useCallback, useMemo } from 'react';
import NextLink from 'next/link';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import MuiLink from '@mui/material/Link';

import type { Part } from '@/types/part';
import type {
  PartCostMissingLeaf,
  PartMarkupGap,
  PartOpRateGap,
} from '@/utils/partsAccess';
import PartPricing from '@/components/parts/PartPricing';
import PartRoutingPanel from '@/components/parts/PartRoutingPanel';
import PartBomPanel from '@/components/parts/PartBomPanel';
import PartPreferredVendor from '@/components/parts/PartPreferredVendor';
import PartIdentitySection from '../PartIdentitySection';
import type { PartSetupStatus } from '../partSetupStatus';

interface WorkspaceTabProps {
  part: Part;
  companyId: string;
  partId: string;
  refreshKey: number;
  currentChain: string[];
  refreshAfterMutation: () => void;
  setupStatus: PartSetupStatus | null;
  /** The structural gaps behind a not-priceable verdict; null while loading. */
  pricingGaps: {
    missing_markups: PartMarkupGap[];
    missing_op_rates: PartOpRateGap[];
    missing_leaves: PartCostMissingLeaf[];
  } | null;
  /**
   * Reports a staged-save panel's dirty state up to the workspace, which owns
   * the exit guard. Keyed so two panels (a bought part shows both tier tables)
   * can be dirty independently.
   */
  onDirtyChange?: (key: string, dirty: boolean) => void;
}

/** How many gap bullets to show before collapsing the rest into "+N more". */
const MAX_GAPS_SHOWN = 6;

/**
 * The part "workspace": how it's made and priced. The default landing tab.
 * Type-adaptive — made parts get a Pricing-left / Operations+Materials-right
 * layout; bought parts get vendor procurement + markup. A colour-coded
 * completeness banner sits on top guiding any remaining setup.
 *
 * Every panel here is reused verbatim from the previous monolithic page; this
 * component is just the JSX lifted out of it.
 */
export default function WorkspaceTab({
  part,
  companyId,
  partId,
  refreshKey,
  currentChain,
  refreshAfterMutation,
  setupStatus,
  pricingGaps,
  onDirtyChange,
}: WorkspaceTabProps) {
  // Stable reporter — PartPricing publishes dirty state from an effect, so an
  // inline arrow would re-fire it on every render. There used to be a second
  // 'procurement' key for the Cost card; one ladder means one staged section.
  const reportPricingDirty = useCallback(
    (dirty: boolean) => onDirtyChange?.('pricing', dirty),
    [onDirtyChange],
  );
  // Turn the structural gaps into a flat, prioritised list of "what to fix"
  // bullets. Order: missing markups (the common case — a sub-part with no
  // markup), then purchased leaves with no vendor cost, then unpriced ops.
  // Each bullet names the offending part and links to it (except the part
  // you're already on). A part can legitimately appear under more than one
  // gap type — they're distinct fixes.
  const gapItems = useMemo(() => {
    if (!pricingGaps) return [];
    const item = (partId_: string, partName: string, prefix: string, text: string) => ({
      key: `${prefix}:${partId_}`,
      partId: partId_,
      partName,
      isSelf: partId_ === partId,
      text,
    });
    return [
      ...pricingGaps.missing_markups.map((g) =>
        item(g.part_id, g.part_name, 'markup', 'has no markup applied'),
      ),
      ...pricingGaps.missing_leaves.map((g) =>
        item(g.part_id, g.part_name, 'leaf', 'has no vendor cost'),
      ),
      ...pricingGaps.missing_op_rates.map((g) =>
        item(g.part_id, g.part_name, 'op', 'has an operation with no rate or no time'),
      ),
    ];
  }, [pricingGaps, partId]);

  const shownGaps = gapItems.slice(0, MAX_GAPS_SHOWN);
  const extraGapCount = gapItems.length - shownGaps.length;

  const bomLinesCount = part.bom_lines_count ?? 0;
  const showRoutingPanel = part.source === 'made';
  // BOM panel: shown whenever this part is made in-house, OR when it has BOM
  // lines (covers historical / odd-classification rows that still have a BOM).
  const showBomPanel = part.source === 'made' || bomLinesCount > 0;

  return (
    <Box>
      {/* Identity — same surface as the create flow; edits auto-save inline. */}
      <PartIdentitySection
        mode="existing"
        companyId={companyId}
        part={part}
        onSaved={() => refreshAfterMutation()}
      />

      {setupStatus && setupStatus.state !== 'ready' && setupStatus.nextStep && (
        <Alert severity={setupStatus.color} sx={{ mb: 3 }}>
          {gapItems.length > 0 ? (
            <>
              <AlertTitle>This part isn’t ready to quote yet</AlertTitle>
              <Box component="ul" sx={{ m: 0, pl: 3 }}>
                {shownGaps.map((g) => (
                  <Box component="li" key={g.key}>
                    {g.isSelf ? (
                      <>This part {g.text}.</>
                    ) : (
                      <>
                        <MuiLink
                          component={NextLink}
                          href={`/dashboard/${companyId}/parts/${g.partId}`}
                          underline="hover"
                        >
                          {g.partName}
                        </MuiLink>{' '}
                        {g.text}.
                      </>
                    )}
                  </Box>
                ))}
                {extraGapCount > 0 && <Box component="li">…and {extraGapCount} more.</Box>}
              </Box>
            </>
          ) : (
            setupStatus.nextStep
          )}
        </Alert>
      )}

      <Grid container spacing={3}>
        {showRoutingPanel ? (
          <>
            <Grid size={{ xs: 12, md: 7 }}>
              {/* PartPricing renders its own Cost + Pricing cards. */}
              <PartPricing
                companyId={companyId}
                part={part}
                refreshKey={refreshKey}
                currentChain={currentChain}
                onPricingChanged={refreshAfterMutation}
                onDirtyChange={reportPricingDirty}
              />
            </Grid>

            <Grid size={{ xs: 12, md: 5 }}>
              <Card elevation={2} sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Operations
                  </Typography>
                  <Divider sx={{ mt: 1, mb: 2 }} />
                  <PartRoutingPanel
                    companyId={companyId}
                    partId={partId}
                    onRoutingSaved={() => {
                      refreshAfterMutation();
                    }}
                  />

                  {showBomPanel && (
                    <>
                      <Divider sx={{ my: 3 }} />
                      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                        Materials
                      </Typography>
                      <PartBomPanel
                        partId={partId}
                        companyId={companyId}
                        currentChain={currentChain}
                        onChanged={refreshAfterMutation}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </>
        ) : (
          <>
            {/* Non-made parts: BOM (rare — only when the row carries legacy
                lines) sits as a full-width row above Pricing. */}
            {showBomPanel && (
              <Grid size={{ xs: 12 }}>
                <Card elevation={2}>
                  <CardContent>
                    <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                      Materials
                    </Typography>
                    <Divider sx={{ mb: 2 }} />
                    <PartBomPanel
                      partId={partId}
                      companyId={companyId}
                      currentChain={currentChain}
                      description={`Parts consumed when manufacturing this ${part.part_name}.`}
                      onChanged={refreshAfterMutation}
                    />
                  </CardContent>
                </Card>
              </Grid>
            )}

            {part.source === 'bought' && (
              <Grid size={{ xs: 12 }}>
                <Card elevation={2}>
                  <CardContent>
                    <PartPreferredVendor
                      partId={partId}
                      companyId={companyId}
                      preferredVendorId={part.preferred_vendor_id}
                      onSaved={() => refreshAfterMutation()}
                    />
                  </CardContent>
                </Card>
              </Grid>
            )}

            <Grid size={{ xs: 12 }}>
              {/* One Pricing card for both sources. A bought part's cost is an
                  editable column in the same ladder as its markup — it used to
                  be a second card over a second table, and nothing kept the two
                  sets of quantity breaks aligned. */}
              <PartPricing
                companyId={companyId}
                part={part}
                refreshKey={refreshKey}
                currentChain={currentChain}
                onPricingChanged={refreshAfterMutation}
                onDirtyChange={reportPricingDirty}
              />
            </Grid>
          </>
        )}
      </Grid>
    </Box>
  );
}
