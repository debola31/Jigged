'use client';

import { Box, Card, CardContent, Chip, Typography, List, ListItem, ListItemText } from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import type { RoutingWithGraph } from '@/types/routings';
import { formatTime, calculateRoutingTime } from '@/types/routings';

interface RoutingViewerProps {
  routing: RoutingWithGraph;
}

/**
 * Read-only view of a routing's ordered operation list. BOM lives on the
 * part (`parts_bom`) and is rendered separately by the part detail page.
 */
export default function RoutingViewer({ routing }: RoutingViewerProps) {
  const time = calculateRoutingTime(routing.operations);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Card elevation={1}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <BuildIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Operations ({routing.operations.length})
            </Typography>
            {routing.operations.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                setup {formatTime(time.setupTime)} + run {formatTime(time.runTime)}/unit
              </Typography>
            )}
          </Box>
          {routing.operations.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No operations defined.
            </Typography>
          ) : (
            <List dense disablePadding>
              {routing.operations.map((op, idx) => {
                const vs = op.vendor_service;
                const isExternal = vs !== null;
                // The step's override, else the service's own price — the same
                // COALESCE the cost engine applies, so this line cannot claim
                // "no price" for a step that is in fact priced by its vendor.
                const effectivePrice = op.external_unit_price ?? vs?.unit_price ?? null;
                const secondaryText = isExternal
                  ? `${vs?.vendor?.name ?? 'Vendor'} • ${
                      effectivePrice && effectivePrice > 0
                        ? `$${effectivePrice.toFixed(2)}/pc`
                        : 'No price'
                    }`
                  : `Setup ${formatTime(op.setup_minutes)} • Run ${formatTime(
                      op.cycle_minutes_per_unit,
                    )}/unit`;

                return (
                  <ListItem
                    key={op.id}
                    divider={idx < routing.operations.length - 1}
                    sx={{ alignItems: 'flex-start', py: 1 }}
                  >
                    <Box sx={{ minWidth: 28, mt: 0.25, color: 'text.secondary', fontWeight: 600 }}>
                      {idx + 1}.
                    </Box>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {op.work_center?.name || 'Unknown work center'}
                          </Typography>
                          <Chip
                            label={isExternal ? 'External' : 'Internal'}
                            size="small"
                            variant="outlined"
                            color={isExternal ? 'secondary' : 'default'}
                            sx={{ height: 18, fontSize: '0.7rem' }}
                          />
                        </Box>
                      }
                      secondary={
                        <Typography variant="caption" color="text.secondary">
                          {secondaryText}
                        </Typography>
                      }
                    />
                  </ListItem>
                );
              })}
            </List>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
