'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Autocomplete from '@mui/material/Autocomplete';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { QuoteFormData, QuoteAttachment, TempAttachment } from '@/types/quote';
import { createQuote, updateQuote, getQuoteAttachments } from '@/utils/quotesAccess';
import { getPartsForSelect } from '@/utils/partsAccess';
import { getAllCustomers } from '@/utils/customerAccess';
import { getTiersForPart } from '@/utils/partPricingTiersAccess';
import type { PartPricingTier } from '@/types/partPricing';
import CustomerFormModal from '@/components/customers/CustomerFormModal';
import PartFormModal from '@/components/parts/PartFormModal';
import QuoteAttachmentUpload from '@/components/quotes/QuoteAttachmentUpload';
import type { Customer } from '@/types/customer';
import { deleteTempQuoteAttachment } from '@/utils/quotesAccess';

const generateSessionId = () => crypto.randomUUID();

interface QuoteFormProps {
  mode: 'create' | 'edit';
  initialData: QuoteFormData;
  quoteId?: string;
  onCancel?: () => void;
  onSave?: () => void;
}

interface CustomerOption {
  id: string;
  name: string;
  isCreateNew?: boolean;
}

interface PartOption {
  id: string;
  part_name: string;
  description: string | null;
  category_id: string | null;
  has_routing: boolean;
  part_category: { id: string; name: string; default_markup_percent: number | null } | null;
  isCreateNew?: boolean;
}

interface PartBlockState {
  part_id: string;
  tier_ids: string[];
  tiers: PartPricingTier[];
  loading: boolean;
  error: string | null;
}

const CREATE_NEW_CUSTOMER: CustomerOption = {
  id: '__create_new__',
  name: 'Create New Customer',
  isCreateNew: true,
};

const CREATE_NEW_PART: PartOption = {
  id: '__create_new__',
  part_name: 'Create New Part',
  description: null,
  category_id: null,
  has_routing: false,
  part_category: null,
  isCreateNew: true,
};

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export default function QuoteForm({ mode, initialData, quoteId, onCancel, onSave }: QuoteFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [formData, setFormData] = useState<QuoteFormData>(initialData);
  const [partBlocks, setPartBlocks] = useState<PartBlockState[]>(
    initialData.parts.map((p) => ({
      part_id: p.part_id,
      tier_ids: p.tier_ids,
      tiers: [],
      loading: false,
      error: null,
    })),
  );

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [partModalOpen, setPartModalOpen] = useState(false);
  const [partModalTargetIdx, setPartModalTargetIdx] = useState<number | null>(null);

  // Attachments (create-mode: temp; edit-mode: persisted)
  const [sessionId] = useState<string>(() => generateSessionId());
  const [tempAttachments, setTempAttachments] = useState<TempAttachment[]>([]);
  const [attachments, setAttachments] = useState<QuoteAttachment[]>([]);

  const loadData = useCallback(async () => {
    try {
      setLoadingData(true);
      const [customersData, partsData] = await Promise.all([
        getAllCustomers(companyId),
        getPartsForSelect(companyId),
      ]);
      setCustomers([
        CREATE_NEW_CUSTOMER,
        ...customersData.map((c) => ({ id: c.id, name: c.name })),
      ]);
      setParts([
        CREATE_NEW_PART,
        ...partsData.map((p) => ({
          id: p.id,
          part_name: p.part_name,
          description: p.description,
          category_id: p.category_id,
          has_routing: p.has_routing,
          part_category: p.part_category,
        })),
      ]);

      if (mode === 'edit' && quoteId) {
        const quoteAttachments = await getQuoteAttachments(quoteId);
        setAttachments(quoteAttachments);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoadingData(false);
    }
  }, [companyId, mode, quoteId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load tiers for each part block when its part_id changes.
  useEffect(() => {
    const loadTiers = async (idx: number, partId: string) => {
      setPartBlocks((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], loading: true, error: null };
        return next;
      });
      try {
        const tiers = await getTiersForPart(partId);
        setPartBlocks((prev) => {
          const next = [...prev];
          if (next[idx]) {
            next[idx] = {
              ...next[idx],
              tiers,
              loading: false,
            };
          }
          return next;
        });
      } catch (err) {
        setPartBlocks((prev) => {
          const next = [...prev];
          if (next[idx]) {
            next[idx] = {
              ...next[idx],
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to load tiers',
            };
          }
          return next;
        });
      }
    };
    partBlocks.forEach((block, idx) => {
      if (block.part_id && block.tiers.length === 0 && !block.loading && !block.error) {
        loadTiers(idx, block.part_id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partBlocks.length, partBlocks.map((b) => b.part_id).join(',')]);

  const handleFieldChange = (field: keyof QuoteFormData, value: string | QuoteFormData['parts']) => {
    setFormData((prev) => ({ ...prev, [field]: value } as QuoteFormData));
  };

  const addPartBlock = () => {
    setPartBlocks((prev) => [
      ...prev,
      { part_id: '', tier_ids: [], tiers: [], loading: false, error: null },
    ]);
  };

  const removePartBlock = (idx: number) => {
    setPartBlocks((prev) => prev.filter((_, i) => i !== idx));
  };

  const updatePartInBlock = (idx: number, part: PartOption | null) => {
    if (!part) {
      setPartBlocks((prev) => {
        const next = [...prev];
        next[idx] = { part_id: '', tier_ids: [], tiers: [], loading: false, error: null };
        return next;
      });
      return;
    }
    if (part.isCreateNew) {
      setPartModalTargetIdx(idx);
      setPartModalOpen(true);
      return;
    }
    setPartBlocks((prev) => {
      const next = [...prev];
      next[idx] = {
        part_id: part.id,
        tier_ids: [],
        tiers: [],
        loading: false,
        error: null,
      };
      return next;
    });
  };

  const toggleTier = (blockIdx: number, tierId: string) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      const block = next[blockIdx];
      const included = block.tier_ids.includes(tierId);
      next[blockIdx] = {
        ...block,
        tier_ids: included ? block.tier_ids.filter((id) => id !== tierId) : [...block.tier_ids, tierId],
      };
      return next;
    });
  };

  const handleCustomerCreated = (customer: Customer) => {
    setCustomers((prev) => [CREATE_NEW_CUSTOMER, ...prev.filter((c) => !c.isCreateNew), { id: customer.id, name: customer.name }]);
    handleFieldChange('customer_id', customer.id);
    setCustomerModalOpen(false);
  };

  const handlePartCreated = async (part: { id: string }) => {
    await loadData();
    if (partModalTargetIdx !== null) {
      setPartBlocks((prev) => {
        const next = [...prev];
        next[partModalTargetIdx] = {
          part_id: part.id,
          tier_ids: [],
          tiers: [],
          loading: false,
          error: null,
        };
        return next;
      });
    }
    setPartModalOpen(false);
    setPartModalTargetIdx(null);
  };

  const handleSubmit = async () => {
    setError(null);

    if (!formData.customer_id) {
      setError('Pick a customer.');
      return;
    }
    if (partBlocks.length === 0) {
      setError('Add at least one part to the quote.');
      return;
    }
    for (const block of partBlocks) {
      if (!block.part_id) {
        setError('Every part block must have a part selected.');
        return;
      }
      if (block.tier_ids.length === 0) {
        setError('Every part must have at least one quantity tier selected.');
        return;
      }
    }

    const payload: QuoteFormData = {
      ...formData,
      parts: partBlocks.map((b) => ({ part_id: b.part_id, tier_ids: b.tier_ids })),
    };

    setLoading(true);
    try {
      if (mode === 'create') {
        const { quote, attachmentErrors } = await createQuote(companyId, payload, tempAttachments);
        if (attachmentErrors.length > 0) {
          setError(`Quote created with errors:\n${attachmentErrors.join('\n')}`);
          return;
        }
        onSave?.();
        router.push(`/dashboard/${companyId}/quotes/${quote.id}`);
      } else if (mode === 'edit' && quoteId) {
        await updateQuote(quoteId, payload);
        onSave?.();
        router.push(`/dashboard/${companyId}/quotes/${quoteId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save quote');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (mode === 'create' && tempAttachments.length > 0) {
      for (const attachment of tempAttachments) {
        try {
          await deleteTempQuoteAttachment(attachment.file_path);
        } catch (cleanupError) {
          console.warn('Failed to clean up temp attachment:', cleanupError);
        }
      }
    }
    if (onCancel) onCancel();
    else router.back();
  };

  if (loadingData) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Customer
          </Typography>
          <Autocomplete
            size="small"
            options={customers}
            getOptionLabel={(o) => o.name}
            value={customers.find((c) => c.id === formData.customer_id) ?? null}
            onChange={(_, v) => {
              if (v?.isCreateNew) {
                setCustomerModalOpen(true);
                return;
              }
              handleFieldChange('customer_id', v?.id ?? '');
            }}
            renderInput={(params) => <TextField {...params} label="Customer" required />}
          />
        </CardContent>
      </Card>

      {/* Parts */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">Parts</Typography>
            <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addPartBlock}>
              Add part
            </Button>
          </Box>

          {partBlocks.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Add at least one part to quote.
            </Typography>
          )}

          {partBlocks.map((block, idx) => {
            const selectedPart = parts.find((p) => p.id === block.part_id) ?? null;
            return (
              <Box key={idx} sx={{ mb: idx === partBlocks.length - 1 ? 0 : 3 }}>
                {idx > 0 && <Divider sx={{ mb: 3 }} />}
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <Autocomplete
                      size="small"
                      options={parts}
                      getOptionLabel={(o) => o.part_name}
                      value={selectedPart}
                      onChange={(_, v) => updatePartInBlock(idx, v)}
                      renderInput={(params) => <TextField {...params} label={`Part ${idx + 1}`} />}
                    />
                  </Box>
                  <IconButton
                    color="error"
                    onClick={() => removePartBlock(idx)}
                    aria-label="Remove part"
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </Box>

                {block.loading && (
                  <Box sx={{ py: 2, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={20} />
                  </Box>
                )}

                {block.error && <Alert severity="error">{block.error}</Alert>}

                {!block.loading && block.part_id && block.tiers.length === 0 && (
                  <Alert severity="warning">
                    This part has no pricing tiers yet. Open the part detail page to add them.
                  </Alert>
                )}

                {!block.loading && block.tiers.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                      Select one or more quantity tiers to include on this quote.
                    </Typography>
                    {block.tiers.map((tier) => {
                      const included = block.tier_ids.includes(tier.id);
                      return (
                        <FormControlLabel
                          key={tier.id}
                          control={
                            <Checkbox
                              size="small"
                              checked={included}
                              onChange={() => toggleTier(idx, tier.id)}
                            />
                          }
                          label={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                              <Typography variant="body2">
                                Qty {tier.quantity} · {formatCurrency(tier.unit_price)} / unit
                              </Typography>
                              {tier.markup_percent != null && (
                                <Chip
                                  size="small"
                                  label={`${tier.markup_percent}% markup`}
                                  variant="outlined"
                                  sx={{ height: 18 }}
                                />
                              )}
                              {tier.is_price_override && (
                                <Chip
                                  size="small"
                                  label="override"
                                  color="warning"
                                  variant="outlined"
                                  sx={{ height: 18 }}
                                />
                              )}
                            </Box>
                          }
                          sx={{ display: 'flex', alignItems: 'center' }}
                        />
                      );
                    })}
                  </Box>
                )}
              </Box>
            );
          })}
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Terms
          </Typography>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Lead time (days)"
                type="number"
                size="small"
                fullWidth
                value={formData.lead_time_days}
                onChange={(e) => handleFieldChange('lead_time_days', e.target.value)}
                inputProps={{ min: 0, step: 1 }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Expiration date"
                type="date"
                size="small"
                fullWidth
                value={formData.expiration_date}
                onChange={(e) => handleFieldChange('expiration_date', e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Attachments */}
      <QuoteAttachmentUpload
        quoteId={mode === 'edit' ? quoteId ?? null : null}
        companyId={companyId}
        sessionId={sessionId}
        existingAttachments={attachments}
        tempAttachments={tempAttachments}
        onAttachmentChange={() => {
          if (mode === 'edit' && quoteId) {
            getQuoteAttachments(quoteId).then(setAttachments).catch(() => {});
          }
        }}
        onTempAttachmentsChange={setTempAttachments}
        disabled={loading}
      />


      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2, mt: 3 }}>
        <Button onClick={handleCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={loading}
          startIcon={loading ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {mode === 'create' ? 'Create quote' : 'Save changes'}
        </Button>
      </Box>

      <CustomerFormModal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        onCreated={handleCustomerCreated}
        companyId={companyId}
      />
      <PartFormModal
        open={partModalOpen}
        onClose={() => {
          setPartModalOpen(false);
          setPartModalTargetIdx(null);
        }}
        onCreated={handlePartCreated}
        companyId={companyId}
      />
    </Box>
  );
}
