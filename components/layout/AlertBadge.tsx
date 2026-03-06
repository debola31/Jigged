'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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
import { getDashboardInsights, type InsightCard } from '@/utils/insightsAccess';

interface AlertBadgeProps {
  companyId: string;
}

interface AtRiskJob {
  job_number: string;
  customer_name: string;
  severity: string;
  pct_complete: number;
  pct_time_elapsed: number;
}

interface InventoryAlert {
  item_name: string;
  severity: string;
  quantity: number;
  reorder_point: number;
  unit: string;
}

function severityColor(severity: string): 'error' | 'warning' | 'default' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'default';
}

export default function AlertBadge({ companyId }: AlertBadgeProps) {
  const router = useRouter();
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [atRiskJobs, setAtRiskJobs] = useState<AtRiskJob[]>([]);
  const [inventoryAlerts, setInventoryAlerts] = useState<InventoryAlert[]>([]);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [inventoryOpen, setInventoryOpen] = useState(true);

  const fetchAlerts = useCallback(async () => {
    if (!companyId) return;
    try {
      const insights = await getDashboardInsights(companyId);
      const jobInsight = insights.find((i: InsightCard) => i.type === 'at_risk_jobs');
      const invInsight = insights.find((i: InsightCard) => i.type === 'inventory_alerts');

      setAtRiskJobs(
        (jobInsight?.metric_data?.at_risk_jobs as AtRiskJob[]) || []
      );
      setInventoryAlerts(
        (invInsight?.metric_data?.alerts as InventoryAlert[]) || []
      );
    } catch {
      // Silently fail — alerts are non-critical
    }
  }, [companyId]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

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
