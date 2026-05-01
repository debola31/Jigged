'use client';

import {
  Box,
  Card,
  CardContent,
  Typography,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import type { RoutingWithGraph } from '@/types/routings';
import { formatTime, calculateRoutingTime } from '@/types/routings';

interface RoutingViewerProps {
  routing: RoutingWithGraph;
}

/**
 * Read-only view of a routing: ordered operation list + material list.
 * Used by ViewRoutingModal and anywhere else we need a non-editable preview.
 */
export default function RoutingViewer({ routing }: RoutingViewerProps) {
  const time = calculateRoutingTime(routing.nodes);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Card elevation={1}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <BuildIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Operations ({routing.nodes.length})
            </Typography>
            {routing.nodes.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                setup {formatTime(time.setupTime)} + run {formatTime(time.runTime)}/unit
              </Typography>
            )}
          </Box>
          {routing.nodes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No operations defined.
            </Typography>
          ) : (
            <List dense disablePadding>
              {routing.nodes.map((node, idx) => (
                <ListItem
                  key={node.id}
                  divider={idx < routing.nodes.length - 1}
                  sx={{ alignItems: 'flex-start', py: 1 }}
                >
                  <Box sx={{ minWidth: 28, mt: 0.25, color: 'text.secondary', fontWeight: 600 }}>
                    {idx + 1}.
                  </Box>
                  <ListItemText
                    primary={
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {node.operation_type?.name || 'Unknown Operation'}
                      </Typography>
                    }
                    secondary={
                      <Typography variant="caption" color="text.secondary">
                        Setup {formatTime(node.setup_time)} • Run{' '}
                        {formatTime(node.run_time_per_unit)}/unit
                      </Typography>
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Card elevation={1}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <Inventory2OutlinedIcon fontSize="small" color="primary" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Materials ({routing.materials.length})
            </Typography>
          </Box>
          {routing.materials.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No materials defined.
            </Typography>
          ) : (
            <List dense disablePadding>
              {routing.materials.map((mat, idx) => (
                <ListItem
                  key={mat.id}
                  divider={idx < routing.materials.length - 1}
                  sx={{ alignItems: 'flex-start', py: 1 }}
                >
                  <Box sx={{ minWidth: 28, mt: 0.25, color: 'text.secondary', fontWeight: 600 }}>
                    {idx + 1}.
                  </Box>
                  <ListItemText
                    primary={
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {mat.inventory_item?.name || 'Unknown item'}
                      </Typography>
                    }
                    secondary={
                      <Typography variant="caption" color="text.secondary">
                        {mat.quantity} {mat.unit}
                      </Typography>
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
