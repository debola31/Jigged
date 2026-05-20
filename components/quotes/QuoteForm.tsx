'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import NextLink from 'next/link';
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
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { QuoteFormData } from '@/types/quote';
import { createQuote, updateQuote } from '@/utils/quotesAccess';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import {
  getAllCustomers,
  pickBillingAddress,
  pickShippingAddress,
  pickDefaultBillingContact,
  pickDefaultShippingContact,
} from '@/utils/customerAccess';
import { getTiersForPart } from '@/utils/partPricingTiersAccess';
import { resolveTier } from '@/utils/quotePricingResolver';
import type { PartPricingTier } from '@/types/partPricing';
import CustomerFormModal from '@/components/customers/CustomerFormModal';
import PartFormModal from '@/components/parts/PartFormModal';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import type {
  Customer,
  CustomerAddress,
  CustomerListContact,
  CustomerWithRelations,
} from '@/types/customer';

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

interface PartBlockState {
  part: PartSelectOption | null;
  /** Working-copy string so the input can be empty mid-edit. */
  order_quantity: string;
  override_open: boolean;
  override_unit_price: string;
  tiers: PartPricingTier[];
  loading: boolean;
  error: string | null;
}

const CREATE_NEW_CUSTOMER: CustomerOption = {
  id: '__create_new__',
  name: 'Create New Customer',
  isCreateNew: true,
};

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function emptyBlock(): PartBlockState {
  return {
    part: null,
    order_quantity: '',
    override_open: false,
    override_unit_price: '',
    tiers: [],
    loading: false,
    error: null,
  };
}

function blockFromInitial(
  p: QuoteFormData['parts'][number],
  hydrated: PartSelectOption | undefined,
): PartBlockState {
  return {
    part: hydrated ?? null,
    order_quantity: String(p.order_quantity),
    override_open: !!p.override,
    override_unit_price: p.override ? String(p.override.unit_price) : '',
    tiers: [],
    loading: false,
    error: null,
  };
}

export default function QuoteForm({ mode, initialData, quoteId, onCancel, onSave }: QuoteFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [formData, setFormData] = useState<QuoteFormData>(initialData);
  const [partBlocks, setPartBlocks] = useState<PartBlockState[]>(
    initialData.parts.map((p) => blockFromInitial(p, undefined)),
  );

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  // Full customer rows (with addresses + contacts) keyed by id so the
  // customer-change handler can resolve address/contact defaults without
  // refetching. Source: getAllCustomers — already loaded for the dropdown.
  const [customersById, setCustomersById] = useState<Map<string, CustomerWithRelations>>(
    () => new Map(),
  );
  // Default to "Ship to same as billing." On customer change we recompute
  // from the customer's defaults; in edit mode we infer it from whether
  // the initial billing/shipping FK pair matches.
  const [shipToSameAsBilling, setShipToSameAsBilling] = useState<boolean>(
    () =>
      initialData.shipping_address_id === initialData.billing_address_id &&
      initialData.shipping_contact_id === initialData.billing_contact_id,
  );
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [partModalOpen, setPartModalOpen] = useState(false);
  const [partModalTargetIdx, setPartModalTargetIdx] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoadingData(true);
      const initialPartIds = initialData.parts.map((p) => p.part_id).filter(Boolean);
      const [customersData, hydratedParts] = await Promise.all([
        getAllCustomers(companyId),
        initialPartIds.length > 0
          ? getPartsForSelectByIds(initialPartIds)
          : Promise.resolve([]),
      ]);
      setCustomers([
        CREATE_NEW_CUSTOMER,
        ...customersData.map((c) => ({ id: c.id, name: c.name })),
      ]);
      setCustomersById(new Map(customersData.map((c) => [c.id, c])));
      if (hydratedParts.length > 0) {
        const byId = new Map(hydratedParts.map((p) => [p.id, p]));
        setPartBlocks((prev) =>
          prev.map((block, idx) => {
            if (block.part) return block;
            const initialId = initialData.parts[idx]?.part_id;
            const hydrated = initialId ? byId.get(initialId) : undefined;
            return hydrated ? { ...block, part: hydrated } : block;
          }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoadingData(false);
    }
  }, [companyId, initialData.parts]);

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
            next[idx] = { ...next[idx], tiers, loading: false };
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
      const partId = block.part?.id;
      if (partId && block.tiers.length === 0 && !block.loading && !block.error) {
        loadTiers(idx, partId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partBlocks.length, partBlocks.map((b) => b.part?.id ?? '').join(',')]);

  const handleFieldChange = (field: keyof QuoteFormData, value: string | QuoteFormData['parts']) => {
    setFormData((prev) => ({ ...prev, [field]: value } as QuoteFormData));
  };

  /**
   * Customer change clears the previous customer's address/contact FKs
   * (they belong to a different customer and would be rejected by the
   * integrity trigger) and pre-populates the four defaults from the
   * newly-selected customer.
   *
   * The "ship-to same as billing" toggle is recomputed: it goes ON when
   * the customer's resolved shipping equals their resolved billing for
   * BOTH address and contact, and OFF when they diverge. That matches
   * what the customer-defaults card on the customer page actually says.
   */
  const handleCustomerChange = (customerId: string) => {
    if (!customerId) {
      setFormData((prev) => ({
        ...prev,
        customer_id: '',
        billing_address_id: '',
        shipping_address_id: '',
        billing_contact_id: '',
        shipping_contact_id: '',
      }));
      setShipToSameAsBilling(true);
      return;
    }
    if (customerId === formData.customer_id) return;

    const customer = customersById.get(customerId);
    const billing = customer ? pickBillingAddress(customer) : null;
    const shipping = customer ? pickShippingAddress(customer) : null;
    const billingContact = customer
      ? pickDefaultBillingContact(customer.customer_contacts)
      : null;
    const shippingContact = customer
      ? pickDefaultShippingContact(customer.customer_contacts)
      : null;

    const billingId = billing?.id ?? '';
    const shippingId = shipping?.id ?? '';
    const billingContactId = billingContact?.id ?? '';
    const shippingContactId = shippingContact?.id ?? '';

    const sameAsBilling =
      shippingId === billingId && shippingContactId === billingContactId;

    setShipToSameAsBilling(sameAsBilling);
    setFormData((prev) => ({
      ...prev,
      customer_id: customerId,
      billing_address_id: billingId,
      shipping_address_id: sameAsBilling ? billingId : shippingId,
      billing_contact_id: billingContactId,
      shipping_contact_id: sameAsBilling ? billingContactId : shippingContactId,
    }));
  };

  /**
   * When the user changes the billing address/contact while the "same as
   * billing" toggle is on, mirror the change to the shipping side so the
   * two stay in sync without the user having to touch the hidden fields.
   */
  const handleBillingAddressChange = (newId: string) => {
    setFormData((prev) => ({
      ...prev,
      billing_address_id: newId,
      ...(shipToSameAsBilling ? { shipping_address_id: newId } : {}),
    }));
  };

  const handleBillingContactChange = (newId: string) => {
    setFormData((prev) => ({
      ...prev,
      billing_contact_id: newId,
      ...(shipToSameAsBilling ? { shipping_contact_id: newId } : {}),
    }));
  };

  /**
   * Toggling the "same as billing" checkbox.
   * ON  → sync shipping → billing immediately.
   * OFF → leave shipping where it is; user will pick.
   */
  const handleShipToSameToggle = (next: boolean) => {
    setShipToSameAsBilling(next);
    if (next) {
      setFormData((prev) => ({
        ...prev,
        shipping_address_id: prev.billing_address_id,
        shipping_contact_id: prev.billing_contact_id,
      }));
    }
  };

  /** Addresses + contacts for the currently-selected customer (or empty). */
  const selectedCustomer = formData.customer_id
    ? customersById.get(formData.customer_id) ?? null
    : null;
  const customerAddresses: CustomerAddress[] = selectedCustomer?.addresses ?? [];
  const customerContacts: CustomerListContact[] = selectedCustomer?.customer_contacts ?? [];

  /**
   * Compact line for the dropdown options — first line of the address +
   * city/state. Mirrors what shows on the customer detail page so the
   * salesperson recognizes the row at a glance.
   */
  const formatAddressOption = (a: CustomerAddress): string => {
    const cityState = [a.city, a.state].filter(Boolean).join(', ');
    const first = [a.address_line1, cityState].filter(Boolean).join(' · ');
    return first || '(empty address)';
  };

  const formatContactOption = (c: CustomerListContact): string => {
    const tag =
      c.role === 'accounts_payable'
        ? 'AP'
        : c.role === 'shipping_receiving'
          ? 'Shipping'
          : c.role === 'buyer'
            ? 'Buyer'
            : c.role === 'engineering'
              ? 'Engineering'
              : c.role === 'quality'
                ? 'Quality'
                : 'Other';
    return `${c.name} · ${tag}`;
  };

  const addPartBlock = () => {
    setPartBlocks((prev) => [...prev, emptyBlock()]);
  };

  const removePartBlock = (idx: number) => {
    setPartBlocks((prev) => prev.filter((_, i) => i !== idx));
  };

  const updatePartInBlock = (idx: number, option: PartSelectOption | null) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      next[idx] = { ...emptyBlock(), part: option };
      return next;
    });
  };

  const openCreatePartModalForBlock = (idx: number) => {
    setPartModalTargetIdx(idx);
    setPartModalOpen(true);
  };

  const updateBlockField = (
    idx: number,
    patch: Partial<PartBlockState> | ((prev: PartBlockState) => Partial<PartBlockState>),
  ) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      const current = next[idx];
      const delta = typeof patch === 'function' ? patch(current) : patch;
      next[idx] = { ...current, ...delta };
      return next;
    });
  };

  const handleCustomerCreated = (customer: Customer) => {
    setCustomers((prev) => [
      CREATE_NEW_CUSTOMER,
      ...prev.filter((c) => !c.isCreateNew),
      { id: customer.id, name: customer.name },
    ]);
    // The new customer has no addresses or contacts yet; insert a blank
    // CustomerWithRelations shell so handleCustomerChange's lookup hits
    // and clears the previous customer's FKs. The salesperson will add
    // address + contacts on the customer page before the quote prints.
    setCustomersById((prev) => {
      const next = new Map(prev);
      next.set(customer.id, {
        ...customer,
        addresses: [],
        customer_contacts: [],
        primary_contact: null,
        quotes_count: 0,
        jobs_count: 0,
      });
      return next;
    });
    handleCustomerChange(customer.id);
    setCustomerModalOpen(false);
  };

  const handlePartCreated = async (part: { id: string }) => {
    const idx = partModalTargetIdx;
    setPartModalOpen(false);
    setPartModalTargetIdx(null);
    if (idx === null) return;
    try {
      const [hydrated] = await getPartsForSelectByIds([part.id]);
      if (!hydrated) return;
      setPartBlocks((prev) => {
        const next = [...prev];
        next[idx] = { ...emptyBlock(), part: hydrated };
        return next;
      });
    } catch (err) {
      console.error('Failed to hydrate created part:', err);
    }
  };

  /** Per-block live preview of the resolved tier + total. */
  const blockPreviews = useMemo(() => {
    return partBlocks.map((block) => {
      const orderQty = Number(block.order_quantity);
      if (!Number.isFinite(orderQty) || orderQty <= 0) {
        return { resolved: null as ReturnType<typeof resolveTier>, total: null as number | null };
      }
      if (block.override_open && block.override_unit_price.trim() !== '') {
        const overridePrice = Number(block.override_unit_price);
        if (Number.isFinite(overridePrice) && overridePrice >= 0) {
          return {
            resolved: null,
            total: Math.round(overridePrice * orderQty * 100) / 100,
            overridePrice,
          };
        }
      }
      const resolved = resolveTier(block.tiers, orderQty);
      return {
        resolved,
        total: resolved ? Math.round(resolved.unit_price * orderQty * 100) / 100 : null,
      };
    });
  }, [partBlocks]);

  /** Quote total = sum of every part block that has a computable total. */
  const quoteTotal = useMemo(() => {
    let sum = 0;
    let allComputable = true;
    for (let i = 0; i < partBlocks.length; i++) {
      const block = partBlocks[i];
      if (!block.part) {
        allComputable = false;
        continue;
      }
      const total = blockPreviews[i]?.total;
      if (total === null || total === undefined) {
        allComputable = false;
      } else {
        sum += total;
      }
    }
    return { sum: Math.round(sum * 100) / 100, allComputable };
  }, [partBlocks, blockPreviews]);

  /**
   * First reason the form is not submittable, or null when valid.
   * Drives the disabled state of the Create/Save button instead of inline error alerts.
   */
  const validationError = useMemo<string | null>(() => {
    if (!formData.customer_id) return 'Pick a customer.';
    if (partBlocks.length === 0) return 'Add at least one part to the quote.';
    const leadRaw = formData.lead_time_days;
    const leadNum = Number(leadRaw);
    if (
      leadRaw === '' ||
      !Number.isFinite(leadNum) ||
      leadNum < 0 ||
      !Number.isInteger(leadNum)
    ) {
      return 'Enter a lead time (whole number of days).';
    }
    const seen = new Set<string>();
    for (const block of partBlocks) {
      if (!block.part) return 'Every part block must have a part selected.';
      if (seen.has(block.part.id)) return 'A part can only appear once on a quote.';
      seen.add(block.part.id);
      const orderQty = Number(block.order_quantity);
      if (!Number.isFinite(orderQty) || orderQty <= 0) {
        return 'Every part needs an order quantity greater than zero.';
      }
      if (!Number.isInteger(orderQty)) return 'Order quantity must be a whole number.';
      if (block.override_open) {
        const overridePrice = Number(block.override_unit_price);
        if (!Number.isFinite(overridePrice) || overridePrice < 0) {
          return 'Override unit price must be a non-negative number.';
        }
      } else {
        if (block.loading) return 'Loading pricing tiers…';
        const resolved = resolveTier(block.tiers, orderQty);
        if (!resolved) {
          return 'At least one part has no priced tiers — add tiers on the part page or use a custom price.';
        }
      }
    }
    return null;
  }, [formData, partBlocks]);

  const handleSubmit = async () => {
    if (validationError) return;
    setError(null);

    const payload: QuoteFormData = {
      ...formData,
      parts: partBlocks.map((b) => {
        const orderQty = Number(b.order_quantity);
        const block: QuoteFormData['parts'][number] = {
          part_id: b.part?.id ?? '',
          order_quantity: orderQty,
        };
        if (b.override_open && b.override_unit_price.trim() !== '') {
          const unitPrice = Number(b.override_unit_price);
          block.override = {
            unit_price: unitPrice,
            // Markup % is no longer a quote-form input — leave it null on overrides.
            markup_percent: null,
          };
        }
        return block;
      }),
    };

    setLoading(true);
    try {
      if (mode === 'create') {
        const { quote } = await createQuote(companyId, payload);
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

  const handleCancel = () => {
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
    <Box sx={{ pb: 12 }}>
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
              handleCustomerChange(v?.id ?? '');
            }}
            renderInput={(params) => <TextField {...params} label="Customer" required />}
          />

          {/* Bill-to + Ship-to selectors. Hidden until a customer is picked
              because the address/contact dropdowns have nothing to show
              otherwise. */}
          {formData.customer_id && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Bill to
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 6 }}>
                  <Autocomplete
                    size="small"
                    options={customerAddresses}
                    getOptionLabel={formatAddressOption}
                    value={
                      customerAddresses.find((a) => a.id === formData.billing_address_id) ?? null
                    }
                    onChange={(_, v) => handleBillingAddressChange(v?.id ?? '')}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Bill to address"
                        helperText={
                          customerAddresses.length === 0
                            ? 'This customer has no saved addresses — add one on the customer page.'
                            : ' '
                        }
                      />
                    )}
                  />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <Autocomplete
                    size="small"
                    options={customerContacts}
                    getOptionLabel={formatContactOption}
                    value={
                      customerContacts.find((c) => c.id === formData.billing_contact_id) ?? null
                    }
                    onChange={(_, v) => handleBillingContactChange(v?.id ?? '')}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Bill to contact"
                        helperText={
                          customerContacts.length === 0
                            ? 'This customer has no saved contacts — add one on the customer page.'
                            : ' '
                        }
                      />
                    )}
                  />
                </Grid>
              </Grid>

              <FormControlLabel
                sx={{ mt: 2, mb: shipToSameAsBilling ? 0 : 1 }}
                control={
                  <Checkbox
                    checked={shipToSameAsBilling}
                    onChange={(e) => handleShipToSameToggle(e.target.checked)}
                  />
                }
                label="Ship to same as bill to"
              />

              {!shipToSameAsBilling && (
                <>
                  <Typography
                    variant="overline"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 1 }}
                  >
                    Ship to
                  </Typography>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, md: 6 }}>
                      <Autocomplete
                        size="small"
                        options={customerAddresses}
                        getOptionLabel={formatAddressOption}
                        value={
                          customerAddresses.find(
                            (a) => a.id === formData.shipping_address_id,
                          ) ?? null
                        }
                        onChange={(_, v) => handleFieldChange('shipping_address_id', v?.id ?? '')}
                        isOptionEqualToValue={(o, v) => o.id === v.id}
                        renderInput={(params) => (
                          <TextField {...params} label="Ship to address" helperText=" " />
                        )}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, md: 6 }}>
                      <Autocomplete
                        size="small"
                        options={customerContacts}
                        getOptionLabel={formatContactOption}
                        value={
                          customerContacts.find(
                            (c) => c.id === formData.shipping_contact_id,
                          ) ?? null
                        }
                        onChange={(_, v) => handleFieldChange('shipping_contact_id', v?.id ?? '')}
                        isOptionEqualToValue={(o, v) => o.id === v.id}
                        renderInput={(params) => (
                          <TextField {...params} label="Ship to contact" helperText=" " />
                        )}
                      />
                    </Grid>
                  </Grid>
                </>
              )}
            </Box>
          )}
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
            const preview = blockPreviews[idx];
            const orderQtyNum = Number(block.order_quantity);
            const hasOrderQty =
              block.order_quantity !== '' && Number.isFinite(orderQtyNum) && orderQtyNum > 0;
            const matched = preview?.resolved ?? null;
            const isOverride = block.override_open && block.override_unit_price.trim() !== '';

            return (
              <Box key={idx} sx={{ mb: idx === partBlocks.length - 1 ? 0 : 3 }}>
                {idx > 0 && <Divider sx={{ mb: 3 }} />}
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <PartAutocomplete
                      companyId={companyId}
                      value={block.part}
                      onChange={(option) => updatePartInBlock(idx, option)}
                      onCreateNew={() => openCreatePartModalForBlock(idx)}
                      label={`Part ${idx + 1}`}
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

                {!block.loading && block.part && block.tiers.length === 0 && !block.error && (
                  <Alert severity="warning">
                    This part has no pricing tiers yet.{' '}
                    <Link
                      component={NextLink}
                      href={`/dashboard/${companyId}/parts/${block.part.id}`}
                      target="_blank"
                      rel="noopener"
                      underline="always"
                    >
                      Add pricing tiers on the part page
                    </Link>
                    , or enter a custom unit price below.
                  </Alert>
                )}

                {!block.loading && block.part && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <TextField
                        size="small"
                        label="Order quantity"
                        value={block.order_quantity}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v !== '' && !/^\d+$/.test(v)) return;
                          updateBlockField(idx, { order_quantity: v });
                        }}
                        inputMode="numeric"
                        sx={{ width: 160 }}
                        helperText={
                          hasOrderQty && matched && matched.below_min
                            ? `Below minimum break (${matched.matched_tier_quantity} ea) — using lowest tier price`
                            : ' '
                        }
                        error={hasOrderQty && matched?.below_min === true}
                      />
                      {hasOrderQty && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 200 }}>
                          {isOverride ? (
                            <>
                              <Typography variant="body2">
                                Custom price{' '}
                                <Box component="span" sx={{ fontWeight: 600 }}>
                                  {formatCurrency(Number(block.override_unit_price))}
                                </Box>{' '}
                                / unit
                              </Typography>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                Total {formatCurrency(preview?.total ?? null)}
                              </Typography>
                            </>
                          ) : matched ? (
                            <>
                              <Typography variant="body2">
                                Tier {matched.matched_tier_quantity} ea ·{' '}
                                <Box component="span" sx={{ fontWeight: 600 }}>
                                  {formatCurrency(matched.unit_price)}
                                </Box>{' '}
                                / unit
                              </Typography>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                Total {formatCurrency(preview?.total ?? null)}
                              </Typography>
                            </>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              No priced tier matches — add a tier or use a custom price.
                            </Typography>
                          )}
                          {isOverride && (
                            <Chip
                              size="small"
                              label="adjusted for this quote"
                              color="success"
                              variant="outlined"
                              sx={{ height: 20, alignSelf: 'flex-start', mt: 0.5 }}
                            />
                          )}
                        </Box>
                      )}
                    </Box>

                    {/* Pricing tiers reference (always visible) */}
                    {block.tiers.length > 0 && (
                      <Box>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mb: 0.5 }}
                        >
                          Pricing tiers
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {[...block.tiers]
                            .sort((a, b) => a.quantity - b.quantity)
                            .map((tier) => {
                              const isMatched =
                                matched?.source_tier_id === tier.id && !isOverride;
                              return (
                                <Chip
                                  key={tier.id}
                                  size="small"
                                  label={`${tier.quantity} · ${formatCurrency(tier.unit_price)} each`}
                                  color={isMatched ? 'primary' : 'default'}
                                  variant={isMatched ? 'filled' : 'outlined'}
                                />
                              );
                            })}
                        </Box>
                      </Box>
                    )}

                    {/* Override toggle */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Button
                        size="small"
                        onClick={() =>
                          updateBlockField(idx, (prev) => ({
                            override_open: !prev.override_open,
                            override_unit_price:
                              !prev.override_open && prev.override_unit_price === '' && matched
                                ? String(matched.unit_price)
                                : prev.override_unit_price,
                          }))
                        }
                      >
                        {block.override_open ? 'Cancel custom price' : '✏ Use custom price'}
                      </Button>
                    </Box>
                    {block.override_open && (
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                        <TextField
                          size="small"
                          label="Unit price"
                          value={block.override_unit_price}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v !== '' && !/^\d*\.?\d*$/.test(v)) return;
                            updateBlockField(idx, { override_unit_price: v });
                          }}
                          sx={{ width: 160 }}
                          inputMode="decimal"
                        />
                      </Box>
                    )}
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
                required
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

      {/* Sticky footer with running total + actions */}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mt: 3,
          py: 2,
          px: 2,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          zIndex: 1,
        }}
      >
        <Box>
          <Typography variant="caption" color="text.secondary">
            Quote total
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {partBlocks.length === 0
              ? '—'
              : quoteTotal.allComputable
                ? formatCurrency(quoteTotal.sum)
                : `${formatCurrency(quoteTotal.sum)} (incomplete)`}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button onClick={handleCancel} disabled={loading}>
            Cancel
          </Button>
          <Tooltip title={validationError ?? ''} disableHoverListener={!validationError}>
            <span>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={loading || !!validationError}
                startIcon={loading ? <CircularProgress size={14} color="inherit" /> : null}
              >
                {mode === 'create' ? 'Create quote' : 'Save changes'}
              </Button>
            </span>
          </Tooltip>
        </Box>
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
