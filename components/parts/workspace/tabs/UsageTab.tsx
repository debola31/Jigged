'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';

import type { Part } from '@/types/part';
import PartWhereUsedPanel from '@/components/parts/PartWhereUsedPanel';

interface UsageTabProps {
  part: Part;
  partId: string;
  companyId: string;
  currentChain: string[];
}

/**
 * "Where does this part show up?" — the record view of a part's relationships.
 *
 * Phase 1a: parent assemblies (Where Used). Phase 1b adds the Jobs and Quotes
 * the part appears on above this section.
 */
export default function UsageTab({ part, partId, companyId, currentChain }: UsageTabProps) {
  const bomParentsCount = part.bom_parents_count ?? 0;

  return (
    <Box>
      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Where Used
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Other parts whose BOM includes this part as a component.
          </Typography>
          <Divider sx={{ my: 2 }} />
          {bomParentsCount > 0 ? (
            <PartWhereUsedPanel partId={partId} companyId={companyId} currentChain={currentChain} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              This part isn’t used as a component in any other part’s BOM.
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
