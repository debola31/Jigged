'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';

import { getPartWithRelations, deletePart } from '@/utils/partsAccess';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import type { RoutingCostBreakdown } from '@/utils/routingCostCalculation';
import type { Part } from '@/types/part';

export default function PartDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  const [part, setPart] = useState<Part | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Routing cost breakdown
  const [costBreakdown, setCostBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [costLoading, setCostLoading] = useState(false);

  useEffect(() => {
    fetchPart();
  }, [partId]);

  const fetchPart = async () => {
    try {
      setLoading(true);
      const data = await getPartWithRelations(partId);
      setPart(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load part');
    } finally {
      setLoading(false);
    }
  };

  // Calculate routing cost when part has a routing
  useEffect(() => {
    if (!part?.routing) {
      setCostBreakdown(null);
      return;
    }
    setCostLoading(true);
    calculateRoutingCost(partId)
      .then((breakdown) => {
        setCostBreakdown(breakdown);
      })
      .catch((err) => {
        console.error('Error calculating routing cost:', err);
        setCostBreakdown(null);
      })
      .finally(() => setCostLoading(false));
  }, [part, partId]);

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deletePart(partId);
      router.push(`/dashboard/${companyId}/parts`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete part');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!part) {
    return (
      <Box>
        <Alert severity="error">Part not found</Alert>
      </Box>
    );
  }

  const quotesCount = part.quotes_count ?? 0;
  const jobsCount = part.jobs_count ?? 0;
  const hasRelatedRecords = quotesCount > 0 || jobsCount > 0;

  return (
    <Box>
      {/* Back Button and Actions */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Parts
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/parts/${partId}/edit`)}
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip title="Delete Part">
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading}
                sx={{
                  color: 'text.secondary',
                  '&:hover': {
                    color: 'error.main',
                    bgcolor: 'rgba(239, 68, 68, 0.1)',
                  },
                }}
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Basic Information Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Basic Information
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Part Number
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {part.part_number}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Description
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {part.description || '—'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Category
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {part.part_category
                      ? `${part.part_category.name}${part.part_category.default_markup_percent !== null ? ` (${part.part_category.default_markup_percent}% markup)` : ''}`
                      : '—'}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Routing Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <AccountTreeIcon sx={{ color: 'text.secondary' }} />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Routing
                </Typography>
              </Box>
              <Divider sx={{ mb: 2 }} />
              {part.routing ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Operations
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {part.routing.nodes_count}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Run Time
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {part.routing.total_run_time_per_unit !== null
                        ? `${part.routing.total_run_time_per_unit} min/unit`
                        : '—'}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<AccountTreeIcon />}
                      onClick={() =>
                        router.push(`/dashboard/${companyId}/parts/${partId}/routing/edit`)
                      }
                    >
                      Edit Routing
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Box>
                  <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
                    No routing defined
                  </Typography>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<AccountTreeIcon />}
                    onClick={() =>
                      router.push(`/dashboard/${companyId}/parts/${partId}/routing/new`)
                    }
                  >
                    Create Routing
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Cost Information Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Cost Information
                </Typography>
                {costLoading && <CircularProgress size={16} />}
              </Box>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Cost Source
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                    <Chip
                      label={
                        part.cost_source === 'routing'
                          ? 'From Routing'
                          : part.cost_source === 'manual'
                            ? 'Manual'
                            : part.cost_source === 'estimate'
                              ? 'Estimate'
                              : 'Not Set'
                      }
                      size="small"
                      color={part.cost_source === 'routing' ? 'primary' : 'default'}
                      variant="outlined"
                    />
                  </Box>
                </Box>

                {/* Routing Cost (calculated live) */}
                {costBreakdown && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Routing Cost (per unit)
                    </Typography>
                    <Typography variant="h6" fontWeight={600} color="primary">
                      {formatCurrency(costBreakdown.total_cost)}
                    </Typography>
                  </Box>
                )}

                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Manual Estimate
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatCurrency(part.manual_cost)}
                  </Typography>
                </Box>
              </Box>

              {/* Warnings for missing data */}
              {costBreakdown && costBreakdown.warnings.length > 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {costBreakdown.warnings.map((w, i) => (
                    <Typography key={i} variant="body2">{w.message}</Typography>
                  ))}
                </Alert>
              )}

              {/* Cost Breakdown accordion */}
              {costBreakdown && (costBreakdown.labor_items.length > 0 || costBreakdown.material_items.length > 0) && (
                <Accordion sx={{ mt: 2, bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
                    <Typography variant="body2" fontWeight={500}>
                      Cost Breakdown
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ px: 0 }}>
                    {costBreakdown.labor_items.length > 0 && (
                      <>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Labor</Typography>
                        <Table size="small" sx={{ mb: 2 }}>
                          <TableHead>
                            <TableRow>
                              <TableCell>Operation</TableCell>
                              <TableCell align="right">Time (min)</TableCell>
                              <TableCell align="right">Rate ($/hr)</TableCell>
                              <TableCell align="right">Cost</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {costBreakdown.labor_items.map((item, i) => (
                              <TableRow key={i}>
                                <TableCell>{item.operation_name}</TableCell>
                                <TableCell align="right">{item.run_time_minutes}</TableCell>
                                <TableCell align="right">{formatCurrency(item.labor_rate)}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                              </TableRow>
                            ))}
                            <TableRow>
                              <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                              <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(costBreakdown.total_labor_cost)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </>
                    )}
                    {costBreakdown.material_items.length > 0 && (
                      <>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>Materials</Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>Item</TableCell>
                              <TableCell align="right">Qty</TableCell>
                              <TableCell align="right">Unit Cost</TableCell>
                              <TableCell align="right">Cost</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {costBreakdown.material_items.map((item, i) => (
                              <TableRow key={i}>
                                <TableCell>{item.item_name}</TableCell>
                                <TableCell align="right">{item.quantity} {item.unit}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost_per_unit)}</TableCell>
                                <TableCell align="right">{formatCurrency(item.cost)}</TableCell>
                              </TableRow>
                            ))}
                            <TableRow>
                              <TableCell colSpan={3} sx={{ fontWeight: 600 }}>Subtotal</TableCell>
                              <TableCell align="right" sx={{ fontWeight: 600 }}>{formatCurrency(costBreakdown.total_material_cost)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </AccordionDetails>
                </Accordion>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Related Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Related
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Quotes
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {quotesCount} quote{quotesCount !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Jobs
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {jobsCount} job{jobsCount !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatDate(part.created_at)}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{part.part_number}</strong>? This action cannot
            be undone.
          </Typography>
          {hasRelatedRecords && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This part has {quotesCount} quote{quotesCount !== 1 ? 's' : ''} and {jobsCount} job
              {jobsCount !== 1 ? 's' : ''}. These records will be kept but will no longer be linked
              to this part.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={
              actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
