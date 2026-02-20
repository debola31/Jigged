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
import InputAdornment from '@mui/material/InputAdornment';
import type { QuoteFormData, QuoteAttachment, TempAttachment } from '@/types/quote';
import { calculateUnitPrice, calculateTotalPrice } from '@/types/quote';
import type { PricingTier } from '@/types/part';
import { createQuote, updateQuote, getCustomerParts, getQuoteAttachments } from '@/utils/quotesAccess';
import { getAllCustomers } from '@/utils/customerAccess';
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
  pricing: PricingTier[];
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
  pricing: [],
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

  // Load parts when customer changes
  const loadParts = useCallback(async (customerId: string) => {
    if (!customerId) {
      setParts([]);
      return;
    }
    setLoadingParts(true);
    try {
      const data = await getCustomerParts(companyId, customerId);
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
  }, [companyId, initialData.part_id]);

  useEffect(() => {
    if (formData.customer_id) {
      loadParts(formData.customer_id);
    }
  }, [formData.customer_id, loadParts]);

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

  // Auto-fill price when part or quantity changes
  useEffect(() => {
    if (formData.part_type === 'existing' && selectedPart?.pricing?.length) {
      const qty = parseInt(formData.quantity, 10) || 1;
      const suggestedPrice = calculateUnitPrice(selectedPart.pricing, qty);
      if (suggestedPrice !== null) {
        setFormData((prev) => ({
          ...prev,
          unit_price: String(suggestedPrice),
        }));
      }
    }
  }, [selectedPart, formData.quantity, formData.part_type]);

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
    setSelectedPart(null);
    setParts([]); // Clear parts list when customer changes
    setFormData((prev) => ({
      ...prev,
      customer_id: value?.id || '',
      part_id: '',
    }));
    if (fieldErrors.customer_id) {
      setFieldErrors((prev) => ({ ...prev, customer_id: '' }));
    }
  };

  const handlePartChange = (_: unknown, value: PartOption | null) => {
    // Check if "Create New" was selected
    if (value?.isCreateNew) {
      setPartModalOpen(true);
      return;
    }
    setSelectedPart(value);
    setFormData((prev) => ({
      ...prev,
      part_id: value?.id || '',
    }));
    if (fieldErrors.part_id) {
      setFieldErrors((prev) => ({ ...prev, part_id: '' }));
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
    setSelectedPart(null);
    setFormData((prev) => ({
      ...prev,
      customer_id: customer.id,
      part_id: '',
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
      pricing: part.pricing || [],
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
                options={formData.customer_id ? [CREATE_NEW_PART, ...parts] : parts}
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
                disabled={loading || !formData.customer_id}
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
                    helperText={
                      fieldErrors.part_id ||
                      (!formData.customer_id ? 'Select a customer first' : '')
                    }
                  />
                )}
                slotProps={{}}
                fullWidth
              />

              {/* Pricing Tiers Display */}
              {selectedPart?.pricing && selectedPart.pricing.length > 0 && (
                <Box
                  sx={{
                    mt: 2,
                    p: 2,
                    bgcolor: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: 1,
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                  }}
                >
                  <Typography variant="subtitle2" gutterBottom>
                    Pricing Tiers:
                  </Typography>
                  {[...selectedPart.pricing]
                    .sort((a, b) => a.qty - b.qty)
                    .map((tier, i) => (
                      <Typography key={i} variant="body2" color="text.secondary">
                        {tier.qty}+ units: {formatCurrency(tier.price)}/ea
                      </Typography>
                    ))}
                </Box>
              )}
        </CardContent>
      </Card>

      {/* Pricing */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Pricing
          </Typography>
          <Grid container spacing={3} alignItems="flex-end">
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
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Unit Price"
                type="number"
                value={formData.unit_price}
                onChange={handleChange('unit_price')}
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
            <Grid size={{ xs: 12, sm: 4 }}>
              <Box sx={{ textAlign: 'center' }}>
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
        preselectedCustomerId={formData.customer_id}
      />
    </Box>
  );
}
