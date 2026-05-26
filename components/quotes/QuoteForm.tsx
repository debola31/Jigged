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
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { QuoteFormData } from '@/types/quote';
import { createQuote, updateQuote } from '@/utils/quotesAccess';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import {
  getAllCustomers,
  pickBillingAddress,
  pickShippingAddress,
  pickPrimaryContact,
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

/** Sentinel option IDs for "add new" actions inside the dropdowns. */
const ADD_NEW_CONTACT_ID = '__add_new_contact__';
const ADD_NEW_ADDRESS_ID = '__add_new_address__';

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
  // Shipping address is the primary section because it's what the quote
  // PDF actually renders. Billing address is captured for the future
  // invoicing flow but de-emphasized into a disclosure that opens when
  // billing differs from shipping. Initial state: ON when billing address
  // equals shipping address (Customer Contact is independent of either).
  const [billingSameAsShipping, setBillingSameAsShipping] = useState<boolean>(
    () => initialData.billing_address_id === initialData.shipping_address_id,
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

  // Load tiers for one block. Shared by the effect (newly-added block) and
  // updatePartInBlock (re-select of the same part wipes the previous tiers,
  // and the effect's id-string dep doesn't change so it won't refire).
  const loadTiersForBlock = useCallback(async (idx: number, partId: string) => {
    setPartBlocks((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      next[idx] = { ...next[idx], loading: true, error: null };
      return next;
    });
    try {
      const tiers = await getTiersForPart(partId);
      setPartBlocks((prev) => {
        const next = [...prev];
        if (next[idx] && next[idx].part?.id === partId) {
          next[idx] = { ...next[idx], tiers, loading: false };
        }
        return next;
      });
    } catch (err) {
      setPartBlocks((prev) => {
        const next = [...prev];
        if (next[idx] && next[idx].part?.id === partId) {
          next[idx] = {
            ...next[idx],
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load tiers',
          };
        }
        return next;
      });
    }
  }, []);

  // Load tiers for each part block when its part_id changes.
  useEffect(() => {
    partBlocks.forEach((block, idx) => {
      const partId = block.part?.id;
      if (partId && block.tiers.length === 0 && !block.loading && !block.error) {
        loadTiersForBlock(idx, partId);
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
   * integrity trigger) and pre-populates defaults from the new customer:
   *   - contact_id          → primary contact
   *   - shipping_address_id → default_shipping (falls back to default_billing)
   *   - billing_address_id  → default_billing
   *
   * "Billing same as shipping" goes ON when the resolved billing equals
   * the resolved shipping address. Common case (single default address)
   * → ON, disclosure hidden. Customers with separate billing/shipping
   * defaults → OFF, billing disclosure visible.
   */
  const handleCustomerChange = (customerId: string) => {
    if (!customerId) {
      setFormData((prev) => ({
        ...prev,
        customer_id: '',
        contact_id: '',
        billing_address_id: '',
        shipping_address_id: '',
      }));
      setBillingSameAsShipping(true);
      return;
    }
    if (customerId === formData.customer_id) return;

    const customer = customersById.get(customerId);
    const billing = customer ? pickBillingAddress(customer) : null;
    const shipping = customer ? pickShippingAddress(customer) : null;
    const primary = customer ? pickPrimaryContact(customer.customer_contacts) : null;

    const billingId = billing?.id ?? '';
    const shippingId = shipping?.id ?? '';
    const contactId = primary?.id ?? '';

    const sameAsShipping = billingId === shippingId;

    setBillingSameAsShipping(sameAsShipping);
    setFormData((prev) => ({
      ...prev,
      customer_id: customerId,
      contact_id: contactId,
      shipping_address_id: shippingId,
      billing_address_id: sameAsShipping ? shippingId : billingId,
    }));
  };

  /**
   * When the user changes the shipping address while "billing same as
   * shipping" is on, mirror the change into the hidden billing FK so
   * the two stay in sync without the user touching the disclosure.
   */
  const handleShippingAddressChange = (newId: string) => {
    setFormData((prev) => ({
      ...prev,
      shipping_address_id: newId,
      ...(billingSameAsShipping ? { billing_address_id: newId } : {}),
    }));
  };

  /**
   * Toggling "billing same as shipping".
   * ON  → sync billing_address_id → shipping_address_id immediately.
   * OFF → leave billing where it is; user opens the disclosure to pick.
   */
  const handleBillingSameToggle = (next: boolean) => {
    setBillingSameAsShipping(next);
    if (next) {
      setFormData((prev) => ({
        ...prev,
        billing_address_id: prev.shipping_address_id,
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
   * Multi-line address display used in both the Select's renderValue
   * (closed state) and each MenuItem (open state). Surfaces ATTN: when
   * the address carries an attention_to, then address_line1, optional
   * address_line2, then city/state/zip on one line.
   *
   * Uses body1 (primary white) so the addresses match the brightness of
   * the Customer / Contact field values. body2 in the project theme is
   * a muted grey, which makes the address look secondary even though it
   * carries primary information.
   */
  const AddressLines = ({ address }: { address: CustomerAddress }) => {
    const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
    const cityStateZipFull = [cityStateZip, address.postal_code]
      .filter(Boolean)
      .join(' ')
      .trim();
    return (
      <Box>
        {address.attention_to && (
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            ATTN: {address.attention_to}
          </Typography>
        )}
        {address.address_line1 && (
          <Typography variant="body1">{address.address_line1}</Typography>
        )}
        {address.address_line2 && (
          <Typography variant="body1">{address.address_line2}</Typography>
        )}
        {cityStateZipFull && (
          <Typography variant="body1">{cityStateZipFull}</Typography>
        )}
      </Box>
    );
  };

  const renderAddressValue = (value: unknown) => {
    const a = customerAddresses.find((x) => x.id === value);
    return a ? <AddressLines address={a} /> : '';
  };

  const customerDetailHref = `/dashboard/${companyId}/customers/${formData.customer_id}`;

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
    // Re-selecting the same part wipes tiers above, but the load-tiers effect
    // keys off the part-ids string — which doesn't change when the id is the
    // same. Trigger the fetch directly so the block reloads either way.
    if (option) {
      loadTiersForBlock(idx, option.id);
    }
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

          {/* Customer contact + Shipping address + Billing address.
              Hidden until a customer is picked. */}
          {formData.customer_id && (
            <Box sx={{ mt: 3 }}>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 6 }}>
                  <Autocomplete
                    size="small"
                    options={[
                      ...customerContacts,
                      // Sentinel "+ Add new contact" appears at the bottom
                      // of the dropdown. Selecting it navigates to the
                      // customer detail page instead of setting the FK.
                      {
                        id: ADD_NEW_CONTACT_ID,
                        name: '+ Add new contact',
                        role: 'other',
                        email: null,
                        phone: null,
                        is_primary: false,
                      } as CustomerListContact,
                    ]}
                    getOptionLabel={(c) => c.name}
                    value={
                      customerContacts.find((c) => c.id === formData.contact_id) ?? null
                    }
                    onChange={(_, v) => {
                      if (v?.id === ADD_NEW_CONTACT_ID) {
                        router.push(customerDetailHref);
                        return;
                      }
                      handleFieldChange('contact_id', v?.id ?? '');
                    }}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    renderOption={(props, option) => (
                      <li
                        {...props}
                        style={
                          option.id === ADD_NEW_CONTACT_ID
                            ? { fontStyle: 'italic' }
                            : undefined
                        }
                      >
                        {option.name}
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField {...params} label="Contact" />
                    )}
                  />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="shipping-address-label">Shipping address</InputLabel>
                    <Select
                      labelId="shipping-address-label"
                      label="Shipping address"
                      value={formData.shipping_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          router.push(customerDetailHref);
                          return;
                        }
                        handleShippingAddressChange(e.target.value);
                      }}
                      renderValue={renderAddressValue}
                      sx={{
                        '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 },
                      }}
                    >
                      {customerAddresses.map((a) => (
                        <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                          <AddressLines address={a} />
                        </MenuItem>
                      ))}
                      <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                        + Add new address
                      </MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
              </Grid>

              <FormControlLabel
                sx={{ mt: 2, mb: 0 }}
                control={
                  <Checkbox
                    checked={billingSameAsShipping}
                    onChange={(e) => handleBillingSameToggle(e.target.checked)}
                  />
                }
                label={
                  <Typography variant="body2" color="text.secondary">
                    Billing address same as shipping
                  </Typography>
                }
              />

              {!billingSameAsShipping && (
                <Box sx={{ mt: 1, pl: 4 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="billing-address-label">Billing address</InputLabel>
                    <Select
                      labelId="billing-address-label"
                      label="Billing address"
                      value={formData.billing_address_id}
                      onChange={(e) => {
                        if (e.target.value === ADD_NEW_ADDRESS_ID) {
                          router.push(customerDetailHref);
                          return;
                        }
                        handleFieldChange('billing_address_id', e.target.value);
                      }}
                      renderValue={renderAddressValue}
                      sx={{
                        '& .MuiSelect-select': { whiteSpace: 'normal', py: 1 },
                      }}
                    >
                      {customerAddresses.map((a) => (
                        <MenuItem key={a.id} value={a.id} sx={{ whiteSpace: 'normal' }}>
                          <AddressLines address={a} />
                        </MenuItem>
                      ))}
                      <MenuItem value={ADD_NEW_ADDRESS_ID} sx={{ fontStyle: 'italic' }}>
                        + Add new address
                      </MenuItem>
                    </Select>
                  </FormControl>
                </Box>
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
            // A tier with unit_price=null exists in the DB when
            // `replaceTiersForPart` couldn't compute a cost — e.g. a BOM
            // material has no priced procurement tier. Treat that as the
            // same "no pricing" state as zero tier rows, so the warning
            // fires and the user isn't trapped typing a quantity that
            // can't resolve to a line price.
            const hasUsableTier = block.tiers.some((t) => t.unit_price !== null);

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

                {!block.loading && block.part && !hasUsableTier && !block.error && (
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

                    {/* Pricing tiers reference (only when at least one tier
                        has a usable unit price — a tier with unit_price=null
                        rendered as "1 · — each" before, which contradicted
                        the warning above). */}
                    {hasUsableTier && (
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
