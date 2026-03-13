'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import InputAdornment from '@mui/material/InputAdornment';
import Chip from '@mui/material/Chip';
import type { QuoteFormData, QuoteAttachment, TempAttachment } from '@/types/quote';
import { calculateTotalPrice, calculateUnitPriceFromMarkup, calculateMarkupFromUnitPrice } from '@/types/quote';
import { createQuote, updateQuote, getQuoteAttachments } from '@/utils/quotesAccess';
import { getPartsForSelect } from '@/utils/partsAccess';
import { getAllCustomers } from '@/utils/customerAccess';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import type { RoutingCostBreakdown } from '@/utils/routingCostCalculation';
import CustomerFormModal from '@/components/customers/CustomerFormModal';
import PartFormModal from '@/components/parts/PartFormModal';
import QuoteAttachmentUpload from '@/components/quotes/QuoteAttachmentUpload';
import type { Customer } from '@/types/customer';
import type { Part } from '@/types/part';
import AddIcon from '@mui/icons-material/Add';
import { deleteTempQuoteAttachment } from '@/utils/quotesAccess';

// Generate unique session ID for temp uploads
const generateSessionId = () => crypto.randomUUID();

interface QuoteFormProps {
  mode: 'create' | 'edit';
  initialData: QuoteFormData;
  quoteId?: string;
  onCancel?: () => void; // Optional callback for edit mode cancel
  onSave?: () => void; // Optional callback for edit mode save success
}

interface CustomerOption {
  id: string;
  name: string;
  isCreateNew?: boolean;
}

interface PartOption {
  id: string;
  part_number: string;
  description: string | null;
  category_id: string | null;
  manual_cost: number | null;
  cost_source: string | null;
  has_routing: boolean;
  part_category: { id: string; name: string; default_markup_percent: number | null } | null;
  isCreateNew?: boolean;
}

// Special option for "Create New" in dropdowns
const CREATE_NEW_CUSTOMER: CustomerOption = {
  id: '__create_new__',
  name: 'Create New Customer',
  isCreateNew: true,
};

const CREATE_NEW_PART: PartOption = {
  id: '__create_new__',
  part_number: 'Create New Part',
  description: null,
  category_id: null,
  manual_cost: null,
  cost_source: null,
  has_routing: false,
  part_category: null,
  isCreateNew: true,
};

export default function QuoteForm({ mode, initialData, quoteId, onCancel, onSave }: QuoteFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [formData, setFormData] = useState<QuoteFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Modal states for quick create
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [partModalOpen, setPartModalOpen] = useState(false);

  // Dropdown options
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingParts, setLoadingParts] = useState(false);

  // Selected objects for display
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [selectedPart, setSelectedPart] = useState<PartOption | null>(null);

  // Attachments
  const [attachments, setAttachments] = useState<QuoteAttachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [tempAttachments, setTempAttachments] = useState<TempAttachment[]>([]);
  const [sessionId] = useState(() => generateSessionId()); // Generate once on mount

  // Load customers on mount
  useEffect(() => {
    const loadCustomers = async () => {
      try {
        const data = await getAllCustomers(companyId);
        const customerOptions = data.map((c) => ({
          id: c.id,
          name: c.name,
        }));
        setCustomers(customerOptions);

        // If editing, find and set the selected customer
        if (initialData.customer_id) {
          const found = customerOptions.find((c) => c.id === initialData.customer_id);
          if (found) setSelectedCustomer(found);
        }
      } catch (err) {
        console.error('Error loading customers:', err);
      } finally {
        setLoadingCustomers(false);
      }
    };
    loadCustomers();
  }, [companyId, initialData.customer_id]);

  // Load all parts on mount (parts are independent of customer)
  useEffect(() => {
    const loadParts = async () => {
      setLoadingParts(true);
      try {
        const data = await getPartsForSelect(companyId);
        setParts(data);

        // If editing with existing part, find and set it
        if (initialData.part_id) {
          const found = data.find((p) => p.id === initialData.part_id);
          if (found) setSelectedPart(found);
        }
      } catch (err) {
        console.error('Error loading parts:', err);
      } finally {
        setLoadingParts(false);
      }
    };
    loadParts();
  }, [companyId, initialData.part_id]);

  // Load attachments in edit mode
  const loadAttachments = useCallback(async () => {
    if (mode === 'edit' && quoteId) {
      setLoadingAttachments(true);
      try {
        const data = await getQuoteAttachments(quoteId);
        setAttachments(data);
      } catch (err) {
        console.error('Error loading attachments:', err);
      } finally {
        setLoadingAttachments(false);
      }
    }
  }, [mode, quoteId]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  // Cleanup temp attachments on unmount (if in create mode and quote wasn't saved)
  useEffect(() => {
    return () => {
      if (mode === 'create' && tempAttachments.length > 0) {
        // Best effort cleanup - don't block unmount
        tempAttachments.forEach(attachment => {
          deleteTempQuoteAttachment(attachment.file_path).catch(console.error);
        });
      }
    };
  }, [mode, tempAttachments]);

  // Cost breakdown from routing (if available)
  const [costBreakdown, setCostBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loadingCost, setLoadingCost] = useState(false);

  // Track which field was last edited for bidirectional sync
  const lastEditedField = useRef<'markup' | 'unit_price' | null>(null);

  // NOTE: Description is NOT auto-filled from part. Quote description is separate.

  const handleChange =
    (field: keyof QuoteFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const handleCustomerChange = (_: unknown, value: CustomerOption | null) => {
    // Check if "Create New" was selected
    if (value?.isCreateNew) {
      setCustomerModalOpen(true);
      return;
    }
    setSelectedCustomer(value);
    setFormData((prev) => ({
      ...prev,
      customer_id: value?.id || '',
    }));
    if (fieldErrors.customer_id) {
      setFieldErrors((prev) => ({ ...prev, customer_id: '' }));
    }
  };

  const handlePartChange = async (_: unknown, value: PartOption | null) => {
    // Check if "Create New" was selected
    if (value?.isCreateNew) {
      setPartModalOpen(true);
      return;
    }
    setSelectedPart(value);
    setCostBreakdown(null);

    if (!value) {
      setFormData((prev) => ({
        ...prev,
        part_id: '',
        base_cost: '',
        cost_source: '',
        markup_percent: '',
        unit_price: '',
      }));
      return;
    }

    // Default markup from category
    const defaultMarkup = value.part_category?.default_markup_percent;
    const markupStr = defaultMarkup !== null && defaultMarkup !== undefined ? String(defaultMarkup) : '';

    setFormData((prev) => ({
      ...prev,
      part_id: value.id,
      markup_percent: markupStr,
    }));

    if (fieldErrors.part_id) {
      setFieldErrors((prev) => ({ ...prev, part_id: '' }));
    }

    // Try to get routing cost (only in create mode or if user explicitly refreshes)
    if (value.has_routing && mode === 'create') {
      setLoadingCost(true);
      try {
        const breakdown = await calculateRoutingCost(value.id);
        if (breakdown) {
          setCostBreakdown(breakdown);
          const baseCostStr = String(breakdown.total_cost);
          const unitPrice = defaultMarkup !== null && defaultMarkup !== undefined
            ? calculateUnitPriceFromMarkup(breakdown.total_cost, defaultMarkup)
            : null;
          setFormData((prev) => ({
            ...prev,
            base_cost: baseCostStr,
            cost_source: 'routing',
            unit_price: unitPrice !== null ? String(unitPrice) : prev.unit_price,
          }));
        }
      } catch (err) {
        console.error('Error calculating routing cost:', err);
      } finally {
        setLoadingCost(false);
      }
    } else if (value.manual_cost !== null) {
      // Fallback to manual cost
      const baseCostStr = String(value.manual_cost);
      const unitPrice = defaultMarkup !== null && defaultMarkup !== undefined
        ? calculateUnitPriceFromMarkup(value.manual_cost, defaultMarkup)
        : null;
      setFormData((prev) => ({
        ...prev,
        base_cost: baseCostStr,
        cost_source: value.cost_source || 'manual',
        unit_price: unitPrice !== null ? String(unitPrice) : prev.unit_price,
      }));
    }
  };

  // Handler for when a new customer is created via modal
  const handleCustomerCreated = async (customer: Customer) => {
    const newOption: CustomerOption = {
      id: customer.id,
      name: customer.name,
    };
    setCustomers((prev) => [...prev, newOption]);
    setSelectedCustomer(newOption);
    setFormData((prev) => ({
      ...prev,
      customer_id: customer.id,
    }));
    // Always clear the error when a customer is selected
    setFieldErrors((prev) => ({ ...prev, customer_id: '' }));
  };

  // Handler for when a new part is created via modal
  const handlePartCreated = async (part: Part) => {
    const newOption: PartOption = {
      id: part.id,
      part_number: part.part_number,
      description: part.description,
      category_id: part.category_id || null,
      manual_cost: part.manual_cost || null,
      cost_source: part.cost_source || null,
      has_routing: !!part.routing,
      part_category: part.part_category || null,
    };
    setParts((prev) => [...prev, newOption]);
    setSelectedPart(newOption);
    setFormData((prev) => ({
      ...prev,
      part_id: part.id,
    }));
    // Always clear the error when a part is selected
    setFieldErrors((prev) => ({ ...prev, part_id: '' }));
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.customer_id) {
      errors.customer_id = 'Customer is required';
    }

    const qty = parseInt(formData.quantity, 10);
    if (isNaN(qty) || qty < 1) {
      errors.quantity = 'Quantity must be at least 1';
    }

    const price = formData.unit_price ? parseFloat(formData.unit_price) : null;
    if (price !== null && price < 0) {
      errors.unit_price = 'Price cannot be negative';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event bubbling to parent forms
    setError(null);

    if (!validateForm()) return;

    setLoading(true);

    try {
      if (mode === 'create') {
        const result = await createQuote(companyId, formData, tempAttachments);
        // Show warning if some attachments failed
        if (result.attachmentErrors && result.attachmentErrors.length > 0) {
          console.warn('Some attachments failed to save:', result.attachmentErrors);
          // Could show a snackbar warning here, but continue to the quote page
        }
        router.push(`/dashboard/${companyId}/quotes/${result.quote.id}`);
      } else if (quoteId) {
        await updateQuote(quoteId, formData);
        if (onSave) {
          onSave();
        } else {
          router.push(`/dashboard/${companyId}/quotes/${quoteId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else if (mode === 'edit' && quoteId) {
      router.push(`/dashboard/${companyId}/quotes/${quoteId}`);
    } else {
      router.push(`/dashboard/${companyId}/quotes`);
    }
  };

  // Calculate total for display
  const quantity = parseInt(formData.quantity, 10) || 0;
  const unitPrice = formData.unit_price ? parseFloat(formData.unit_price) : null;
  const totalPrice = calculateTotalPrice(quantity, unitPrice);

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Customer Selection */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Customer
          </Typography>
          <Autocomplete
            options={[CREATE_NEW_CUSTOMER, ...customers]}
            getOptionLabel={(option) => option.name}
            value={selectedCustomer}
            onChange={handleCustomerChange}
            loading={loadingCustomers}
            disabled={loading}
            filterOptions={(options, state) => {
              // Always keep "Create New" at the top, then filter the rest
              const createNew = options.find((o) => o.isCreateNew);
              const filtered = options
                .filter((o) => !o.isCreateNew)
                .filter((o) => {
                  const label = o.name;
                  return label.toLowerCase().includes(state.inputValue.toLowerCase());
                });
              return createNew ? [createNew, ...filtered] : filtered;
            }}
            renderOption={(props, option) => {
              const { key, ...otherProps } = props;
              if (option.isCreateNew) {
                return (
                  <li
                    key={key}
                    {...otherProps}
                    style={{
                      fontWeight: 600,
                      color: '#4682B4',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
                    }}
                  >
                    <AddIcon sx={{ mr: 1, fontSize: 20 }} />
                    {option.name}
                  </li>
                );
              }
              return (
                <li key={key} {...otherProps}>
                  {option.name}
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Select Customer"
                required
                error={!!fieldErrors.customer_id}
                helperText={fieldErrors.customer_id}
              />
            )}
            slotProps={{}}
            fullWidth
          />
        </CardContent>
      </Card>

      {/* Part Selection */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Part
          </Typography>

          <Autocomplete
                options={[CREATE_NEW_PART, ...parts]}
                getOptionLabel={(option) =>
                  option.isCreateNew
                    ? option.part_number
                    : option.description
                      ? `${option.part_number} - ${option.description}`
                      : option.part_number
                }
                value={selectedPart}
                onChange={handlePartChange}
                loading={loadingParts}
                disabled={loading}
                filterOptions={(options, state) => {
                  // Always keep "Create New" at the top, then filter the rest
                  const createNew = options.find((o) => o.isCreateNew);
                  const filtered = options
                    .filter((o) => !o.isCreateNew)
                    .filter((o) => {
                      const label = o.description
                        ? `${o.part_number} - ${o.description}`
                        : o.part_number;
                      return label.toLowerCase().includes(state.inputValue.toLowerCase());
                    });
                  return createNew ? [createNew, ...filtered] : filtered;
                }}
                renderOption={(props, option) => {
                  const { key, ...otherProps } = props;
                  if (option.isCreateNew) {
                    return (
                      <li
                        key={key}
                        {...otherProps}
                        style={{
                          fontWeight: 600,
                          color: '#4682B4',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
                        }}
                      >
                        <AddIcon sx={{ mr: 1, fontSize: 20 }} />
                        {option.part_number}
                      </li>
                    );
                  }
                  return (
                    <li key={key} {...otherProps}>
                      {option.description
                        ? `${option.part_number} - ${option.description}`
                        : option.part_number}
                    </li>
                  );
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Select Part"
                    error={!!fieldErrors.part_id}
                    helperText={fieldErrors.part_id}
                  />
                )}
                slotProps={{}}
                fullWidth
              />

        </CardContent>
      </Card>

      {/* Cost & Pricing */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Cost & Pricing
            </Typography>
            {formData.cost_source && (
              <Chip
                label={formData.cost_source === 'routing' ? 'From Routing' : formData.cost_source === 'manual' ? 'Manual Cost' : 'Estimate'}
                size="small"
                color={formData.cost_source === 'routing' ? 'primary' : 'default'}
                variant="outlined"
              />
            )}
            {loadingCost && <CircularProgress size={16} />}
          </Box>

          {/* Cost breakdown warnings */}
          {costBreakdown && costBreakdown.warnings.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Cost may be incomplete — {costBreakdown.warnings.length} item{costBreakdown.warnings.length !== 1 ? 's' : ''} missing data
            </Alert>
          )}

          <Grid container spacing={3}>
            {/* Base Cost */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Base Cost"
                type="number"
                value={formData.base_cost}
                onChange={(e) => {
                  const newCost = e.target.value;
                  const costNum = parseFloat(newCost);
                  const markupNum = parseFloat(formData.markup_percent);
                  const newUnitPrice = !isNaN(costNum) && !isNaN(markupNum)
                    ? calculateUnitPriceFromMarkup(costNum, markupNum)
                    : null;
                  setFormData((prev) => ({
                    ...prev,
                    base_cost: newCost,
                    unit_price: newUnitPrice !== null ? String(newUnitPrice) : prev.unit_price,
                  }));
                }}
                disabled={loading || formData.cost_source === 'routing'}
                helperText={formData.cost_source === 'routing' ? 'Calculated from routing' : 'Cost per unit'}
                slotProps={{
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  },
                  htmlInput: { min: 0, step: 0.01 },
                }}
              />
            </Grid>

            {/* Markup % */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Markup %"
                type="number"
                value={formData.markup_percent}
                onChange={(e) => {
                  lastEditedField.current = 'markup';
                  const newMarkup = e.target.value;
                  const costNum = parseFloat(formData.base_cost);
                  const markupNum = parseFloat(newMarkup);
                  const newUnitPrice = !isNaN(costNum) && !isNaN(markupNum)
                    ? calculateUnitPriceFromMarkup(costNum, markupNum)
                    : null;
                  setFormData((prev) => ({
                    ...prev,
                    markup_percent: newMarkup,
                    unit_price: newUnitPrice !== null ? String(newUnitPrice) : prev.unit_price,
                  }));
                }}
                disabled={loading}
                helperText={
                  selectedPart?.part_category?.default_markup_percent !== null &&
                  selectedPart?.part_category?.default_markup_percent !== undefined
                    ? `Default: ${selectedPart.part_category.default_markup_percent}% (${selectedPart.part_category.name})`
                    : undefined
                }
                slotProps={{
                  input: {
                    endAdornment: <InputAdornment position="end">%</InputAdornment>,
                  },
                  htmlInput: { step: 0.1 },
                }}
              />
            </Grid>

            {/* Unit Price */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Unit Price"
                type="number"
                value={formData.unit_price}
                onChange={(e) => {
                  lastEditedField.current = 'unit_price';
                  const newPrice = e.target.value;
                  const costNum = parseFloat(formData.base_cost);
                  const priceNum = parseFloat(newPrice);
                  const newMarkup = !isNaN(costNum) && costNum > 0 && !isNaN(priceNum)
                    ? calculateMarkupFromUnitPrice(costNum, priceNum)
                    : null;
                  setFormData((prev) => ({
                    ...prev,
                    unit_price: newPrice,
                    markup_percent: newMarkup !== null ? String(newMarkup) : prev.markup_percent,
                  }));
                }}
                error={!!fieldErrors.unit_price}
                helperText={fieldErrors.unit_price}
                disabled={loading}
                slotProps={{
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  },
                  htmlInput: { min: 0, step: 0.01 },
                }}
              />
            </Grid>

            {/* Quantity */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                required
                label="Quantity"
                type="number"
                value={formData.quantity}
                onChange={handleChange('quantity')}
                error={!!fieldErrors.quantity}
                helperText={fieldErrors.quantity}
                disabled={loading}
                slotProps={{
                  htmlInput: { min: 1 },
                }}
              />
            </Grid>

            {/* Total */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <Box sx={{ textAlign: 'center', pt: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Total
                </Typography>
                <Typography variant="h5" color="primary" fontWeight={600}>
                  {formatCurrency(totalPrice)}
                </Typography>
              </Box>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Description */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Description
          </Typography>
          <TextField
            fullWidth
            label="Quote Description"
            value={formData.description}
            onChange={handleChange('description')}
            disabled={loading}
            multiline
            rows={3}
            placeholder="Describe the work to be quoted"
          />
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            Attachments
          </Typography>
          <QuoteAttachmentUpload
            quoteId={mode === 'edit' ? quoteId! : null}
            companyId={companyId}
            sessionId={sessionId}
            existingAttachments={attachments}
            tempAttachments={tempAttachments}
            onAttachmentChange={loadAttachments}
            onTempAttachmentsChange={setTempAttachments}
            disabled={mode === 'edit' && formData.status !== 'draft' && formData.status !== 'rejected'}
          />
        </CardContent>
      </Card>

      {/* Actions at bottom */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 3 }}>
        <Button variant="outlined" onClick={handleCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Saving...' : mode === 'create' ? 'Save as Draft' : 'Save'}
        </Button>
      </Box>

      {/* Quick Create Customer Modal */}
      <CustomerFormModal
        open={customerModalOpen}
        onClose={() => setCustomerModalOpen(false)}
        onCreated={handleCustomerCreated}
        companyId={companyId}
      />

      {/* Quick Create Part Modal */}
      <PartFormModal
        open={partModalOpen}
        onClose={() => setPartModalOpen(false)}
        onCreated={handlePartCreated}
        companyId={companyId}
      />
    </Box>
  );
}
