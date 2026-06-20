'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';

import type { Part } from '@/types/part';
import PartPricing from '@/components/parts/PartPricing';
import PartRoutingPanel from '@/components/parts/PartRoutingPanel';
import PartBomPanel from '@/components/parts/PartBomPanel';
import PartProcurementPricingPanel from '@/components/parts/PartProcurementPricingPanel';
import type { PartSetupStatus } from '../partSetupStatus';

interface WorkspaceTabProps {
  part: Part;
  companyId: string;
  partId: string;
  refreshKey: number;
  currentChain: string[];
  refreshAfterMutation: () => void;
  setupStatus: PartSetupStatus | null;
}

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
}: WorkspaceTabProps) {
  const bomLinesCount = part.bom_lines_count ?? 0;
  const showRoutingPanel = part.source === 'made';
  // BOM panel: shown whenever this part is made in-house, OR when it has BOM
  // lines (covers historical / odd-classification rows that still have a BOM).
  const showBomPanel = part.source === 'made' || bomLinesCount > 0;

  return (
    <Box>
      {setupStatus && setupStatus.state !== 'ready' && setupStatus.nextStep && (
        <Alert severity={setupStatus.color} sx={{ mb: 3 }}>
          {setupStatus.nextStep}
        </Alert>
      )}

      <Grid container spacing={3}>
        {showRoutingPanel ? (
          <>
            <Grid size={{ xs: 12, md: 7 }}>
              <Card elevation={2} sx={{ height: '100%' }}>
                <CardContent>
                  <PartPricing
                    companyId={companyId}
                    part={part}
                    refreshKey={refreshKey}
                    currentChain={currentChain}
                  />
                </CardContent>
              </Card>
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
                        description={`Parts consumed when manufacturing this ${part.part_name}.`}
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
                    <PartProcurementPricingPanel
                      partId={partId}
                      companyId={companyId}
                      primaryUnit={part.primary_unit}
                      preferredVendorId={part.preferred_vendor_id}
                    />
                  </CardContent>
                </Card>
              </Grid>
            )}

            <Grid size={{ xs: 12 }}>
              <Card elevation={2}>
                <CardContent>
                  <PartPricing
                    companyId={companyId}
                    part={part}
                    refreshKey={refreshKey}
                    currentChain={currentChain}
                  />
                </CardContent>
              </Card>
            </Grid>
          </>
        )}
      </Grid>
    </Box>
  );
}
