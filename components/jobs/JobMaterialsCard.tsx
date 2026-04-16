'use client';

import {
  Card,
  CardContent,
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  Chip,
} from '@mui/material';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import type { JobMaterial } from '@/types/job';

interface JobMaterialsCardProps {
  materials: JobMaterial[];
}

const STATUS_COLORS: Record<JobMaterial['status'], 'default' | 'success' | 'warning'> = {
  pending: 'default',
  consumed: 'success',
  skipped: 'warning',
};

/**
 * Job detail page material list. Shows expected qty, actual qty (if recorded)
 * and status. Materials are job-level, snapshotted from routing_materials.
 */
export default function JobMaterialsCard({ materials }: JobMaterialsCardProps) {
  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Inventory2OutlinedIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Materials
          </Typography>
          <Typography variant="caption" color="text.secondary">
            ({materials.length} item{materials.length === 1 ? '' : 's'})
          </Typography>
        </Box>

        {materials.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No materials are needed for this job.
          </Typography>
        ) : (
          <List dense disablePadding>
            {materials.map((mat, idx) => {
              const itemName = mat.inventory_item?.name || 'Unknown item';
              const expected = `${mat.expected_quantity} ${mat.unit}`;
              const actualLabel =
                mat.actual_quantity != null
                  ? `${mat.actual_quantity} ${mat.unit} consumed`
                  : null;
              return (
                <ListItem
                  key={mat.id}
                  divider={idx < materials.length - 1}
                  sx={{ alignItems: 'flex-start', py: 1 }}
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {itemName}
                        </Typography>
                        <Chip
                          size="small"
                          label={mat.status}
                          color={STATUS_COLORS[mat.status]}
                          variant="outlined"
                          sx={{ textTransform: 'capitalize' }}
                        />
                      </Box>
                    }
                    secondary={
                      <Typography variant="caption" color="text.secondary">
                        Expected: {expected}
                        {actualLabel ? ` • ${actualLabel}` : ''}
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
  );
}
