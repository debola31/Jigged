'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
// Use the canonical `getLowStockPartsAlerts` (the legacy `getInventoryAlerts`
// alias still exists but the new name reflects the unified parts model).
import {
  getAtRiskJobs,
  getLowStockPartsAlerts,
  type AtRiskJob,
  type InventoryAlert,
} from '@/utils/alertsAccess';

interface AlertBadgeProps {
  companyId: string;
}

const EMPTY_JOBS: AtRiskJob[] = [];
const EMPTY_INVENTORY: InventoryAlert[] = [];

function severityColor(severity: string): 'error' | 'warning' | 'default' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'default';
}

export default function AlertBadge({ companyId }: AlertBadgeProps) {
  const router = useRouter();
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [inventoryOpen, setInventoryOpen] = useState(true);

  // Both reads are plain Supabase metric queries (no AI). Alerts are
  // non-critical, so a load failure is swallowed (captured into the unused
  // `error`); useLoad keeps setState out of the effect body.
  const { data } = useLoad(
    async (): Promise<[AtRiskJob[], InventoryAlert[]]> => {
      if (!companyId) return [EMPTY_JOBS, EMPTY_INVENTORY];
      return Promise.all([getAtRiskJobs(companyId), getLowStockPartsAlerts(companyId)]);
    },
    [companyId],
  );
  const atRiskJobs = data?.[0] ?? EMPTY_JOBS;
  const inventoryAlerts = data?.[1] ?? EMPTY_INVENTORY;

  const totalCount = atRiskJobs.length + inventoryAlerts.length;
  const open = Boolean(anchorEl);

  return (
    <>
      <IconButton
        onClick={(e) => setAnchorEl(e.currentTarget)}
        aria-label="View alerts"
        sx={{
          color: 'rgba(255, 255, 255, 0.7)',
          '&:hover': { color: 'white' },
        }}
      >
        <Badge
          badgeContent={totalCount}
          color="error"
          invisible={totalCount === 0}
          max={99}
        >
          <NotificationsNoneIcon />
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: { width: 360, maxHeight: 480, mt: 1 },
          },
        }}
      >
        {totalCount === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <CheckCircleOutlineIcon
              sx={{ fontSize: 40, color: 'success.main', mb: 1 }}
            />
            <Typography variant="body1" sx={{ fontWeight: 500 }}>
              All clear
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No alerts right now.
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {/* At-Risk Jobs Section */}
            {atRiskJobs.length > 0 && (
              <>
                <ListItemButton
                  onClick={() => setJobsOpen(!jobsOpen)}
                  sx={{ py: 1.5, bgcolor: 'action.hover' }}
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          At-Risk Jobs
                        </Typography>
                        <Chip
                          label={atRiskJobs.length}
                          size="small"
                          color="warning"
                          sx={{ height: 20, fontSize: '0.75rem' }}
                        />
                      </Box>
                    }
                  />
                  {jobsOpen ? <ExpandLess /> : <ExpandMore />}
                </ListItemButton>
                <Collapse in={jobsOpen}>
                  <List disablePadding>
                    {atRiskJobs.map((job) => (
                      <ListItemButton
                        key={job.job_number}
                        onClick={() => {
                          setAnchorEl(null);
                          router.push(`/dashboard/${companyId}/jobs`);
                        }}
                        sx={{ pl: 3, py: 1 }}
                      >
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {job.job_number}
                              </Typography>
                              <Chip
                                label={job.severity}
                                size="small"
                                color={severityColor(job.severity)}
                                sx={{ height: 18, fontSize: '0.7rem' }}
                              />
                            </Box>
                          }
                          secondary={`${job.customer_name} — ${Math.round(job.pct_complete)}% done, ${Math.round(job.pct_time_elapsed)}% time used`}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                </Collapse>
              </>
            )}

            {/* Low Inventory Section */}
            {inventoryAlerts.length > 0 && (
              <>
                <ListItemButton
                  onClick={() => setInventoryOpen(!inventoryOpen)}
                  sx={{ py: 1.5, bgcolor: 'action.hover' }}
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          Low Inventory
                        </Typography>
                        <Chip
                          label={inventoryAlerts.length}
                          size="small"
                          color="warning"
                          sx={{ height: 20, fontSize: '0.75rem' }}
                        />
                      </Box>
                    }
                  />
                  {inventoryOpen ? <ExpandLess /> : <ExpandMore />}
                </ListItemButton>
                <Collapse in={inventoryOpen}>
                  <List disablePadding>
                    {inventoryAlerts.map((alert) => (
                      <ListItemButton
                        key={alert.item_name}
                        onClick={() => {
                          setAnchorEl(null);
                          router.push(`/dashboard/${companyId}/inventory`);
                        }}
                        sx={{ pl: 3, py: 1 }}
                      >
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {alert.item_name}
                              </Typography>
                              <Chip
                                label={alert.severity}
                                size="small"
                                color={severityColor(alert.severity)}
                                sx={{ height: 18, fontSize: '0.7rem' }}
                              />
                            </Box>
                          }
                          secondary={`Qty: ${alert.quantity} / Reorder: ${alert.reorder_point} ${alert.unit || 'ea'}`}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                </Collapse>
              </>
            )}
          </List>
        )}
      </Popover>
    </>
  );
}
