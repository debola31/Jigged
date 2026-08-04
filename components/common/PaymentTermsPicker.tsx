'use client';

import { useEffect, useMemo, useState } from 'react';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import { PAYMENT_TERM_PRESETS } from '@/types/quote';
import {
  getCustomPaymentTerms,
  addCustomPaymentTerm,
  removeCustomPaymentTerm,
} from '@/utils/companyAccess';
import { listQuickBooksTerms } from '@/utils/quickbooksAccess';

/**
 * The one payment-terms control.
 *
 * WHY IT IS SHARED. A customer's standing terms and a quote's terms are the
 * same vocabulary — the former seeds the latter — so offering a picker in one
 * place and a bare text box in the other guarantees drift. Type "net 45" on the
 * customer, and the quote picker (which leads with QuickBooks' own spelling)
 * shows it as a separate "This quote" entry beside QuickBooks' "Net 45". The
 * whole point of leading with QuickBooks' list is that a term chosen here
 * already exists on their side and resolves to a real SalesTermRef.
 *
 * The customer CRM plan deliberately deferred this extraction — "none of that
 * ships until a second consumer exists" — because a shared component built for
 * one caller is a guess. There are two now.
 *
 * Options, most-authoritative first, deduped CASE-INSENSITIVELY with the first
 * spelling winning:
 *
 *   1. In QuickBooks   — terms the shop already has there
 *   2. Your saved terms — companies.settings.custom_payment_terms, removable
 *   3. Standard terms   — PAYMENT_TERM_PRESETS
 *
 * QuickBooks wins a collision because its spelling is the one that has to match
 * on their side: it ships "Due on receipt" against our "Due on Receipt", and two
 * rows for one term is the drift this removes.
 *
 * PICK-ONLY. New wording is entered through the "Add New" row, which reveals an
 * inline field below the picker and saves the term to the company's list for
 * reuse. Free-typing into the combobox would let one shop accumulate "Net 30",
 * "net 30" and "Net30" without ever seeing them side by side.
 */

type PaymentTermOption = { value: string; group: string };
const paymentTermFilter = createFilterOptions<PaymentTermOption>();
const ADD_NEW_TERM = '__add_new_payment_term__';

export interface PaymentTermsPickerProps {
  companyId: string;
  value: string;
  /** Called with the chosen term, or '' when cleared. */
  onChange: (next: string) => void;
  label?: string;
  helperText?: string;
  required?: boolean;
  size?: 'small' | 'medium';
  disabled?: boolean;
}

export default function PaymentTermsPicker({
  companyId,
  value,
  onChange,
  label = 'Payment terms',
  helperText,
  required = false,
  size = 'small',
  disabled = false,
}: PaymentTermsPickerProps) {
  const [savedTerms, setSavedTerms] = useState<string[]>([]);
  const [quickBooksTerms, setQuickBooksTerms] = useState<string[]>([]);
  const [addingTerm, setAddingTerm] = useState(false);
  const [newTermDraft, setNewTermDraft] = useState('');

  // Both loads are best-effort: a failure costs suggestions, never the ability
  // to state a term. The QuickBooks call is deliberately its own effect rather
  // than part of a caller's main load, so no form waits on a third party to
  // render — the picker opens on the local list and QuickBooks' terms fold in.
  useEffect(() => {
    let cancelled = false;
    getCustomPaymentTerms(companyId)
      .then((t) => {
        if (!cancelled) setSavedTerms(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    // Resolves to an empty list rather than rejecting, so a shop with no
    // QuickBooks and one whose connection is momentarily down take the same path.
    listQuickBooksTerms(companyId).then((res) => {
      if (!cancelled) setQuickBooksTerms(res.terms.map((t) => t.name));
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const options = useMemo<PaymentTermOption[]>(() => {
    const out: PaymentTermOption[] = [];
    const seen = new Set<string>();
    const add = (list: ReadonlyArray<string>, group: string) => {
      for (const v of list) {
        const key = v.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ value: v, group });
      }
    };
    add(quickBooksTerms, 'In QuickBooks');
    add(savedTerms, 'Your saved terms');
    add(PAYMENT_TERM_PRESETS, 'Standard terms');
    // A value none of the three lists carries (an older record, or a term since
    // removed) is pinned to the front so the field can still display it.
    const cur = value.trim();
    if (cur && !out.some((o) => o.value === cur)) {
      out.unshift({ value: cur, group: 'This record' });
    }
    return out;
  }, [quickBooksTerms, savedTerms, value]);

  /**
   * Commit a term. A brand-new one is added to the company's saved list —
   * optimistically on screen, then persisted best-effort, because a failed save
   * still leaves the term usable on the record in front of you.
   */
  const commit = (term: string, isNewCustom: boolean) => {
    const trimmed = term.trim();
    onChange(trimmed);
    if (
      isNewCustom &&
      trimmed !== '' &&
      !PAYMENT_TERM_PRESETS.includes(trimmed) &&
      !savedTerms.includes(trimmed)
    ) {
      setSavedTerms((prev) => [trimmed, ...prev.filter((t) => t !== trimmed)]);
      addCustomPaymentTerm(companyId, trimmed)
        .then(setSavedTerms)
        .catch((e) => console.warn('Could not save custom payment term for reuse:', e));
    }
  };

  const removeSaved = (term: string) => {
    setSavedTerms((prev) => prev.filter((t) => t !== term));
    removeCustomPaymentTerm(companyId, term)
      .then(setSavedTerms)
      .catch((e) => console.warn('Could not remove custom payment term:', e));
  };

  const cancelAdd = () => {
    setAddingTerm(false);
    setNewTermDraft('');
  };

  const submitNew = () => {
    const t = newTermDraft.trim();
    if (t) commit(t, true);
    setAddingTerm(false);
    setNewTermDraft('');
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Autocomplete<PaymentTermOption, false, false, false>
        size={size}
        fullWidth
        disabled={disabled}
        options={options}
        getOptionLabel={(o) => o.value}
        isOptionEqualToValue={(option, val) => option.value === val.value}
        filterOptions={(opts, params) => {
          const filtered = paymentTermFilter(opts, params);
          // The "Add New" action is always the last row, and is pushed AFTER
          // filtering so it survives typing.
          filtered.push({ value: ADD_NEW_TERM, group: 'Add new' });
          return filtered;
        }}
        value={options.find((o) => o.value === value) ?? null}
        onChange={(_e, newValue) => {
          if (newValue?.value === ADD_NEW_TERM) {
            setNewTermDraft('');
            setAddingTerm(true);
            return;
          }
          onChange(newValue ? newValue.value : '');
        }}
        renderOption={(props, option) => {
          const { key, ...liProps } = props as typeof props & { key?: string };
          if (option.value === ADD_NEW_TERM) {
            return (
              <li
                key={key}
                {...liProps}
                style={{ borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}
              >
                <AddIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                <Box component="span" sx={{ color: 'primary.main', fontWeight: 600 }}>
                  Add New
                </Box>
              </li>
            );
          }
          if (option.group === 'Your saved terms') {
            return (
              <li key={key} {...liProps}>
                <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 1 }}>
                  <Box sx={{ flex: 1 }}>{option.value}</Box>
                  <IconButton
                    size="small"
                    aria-label={`Remove ${option.value}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSaved(option.value);
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Box>
              </li>
            );
          }
          return (
            <li key={key} {...liProps}>
              {option.value}
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            required={required}
            helperText={helperText}
            InputLabelProps={{ ...params.InputLabelProps, shrink: true }}
          />
        )}
      />

      {addingTerm && (
        // Revealed below the picker rather than inside it: a dropdown closes on
        // selection, so a field living in the menu can't reliably be typed into.
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <TextField
            size="small"
            fullWidth
            autoFocus
            label="New payment term"
            placeholder="e.g. Net 30, 1% late charge"
            value={newTermDraft}
            onChange={(e) => setNewTermDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitNew();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelAdd();
              }
            }}
            InputLabelProps={{ shrink: true }}
          />
          <Button variant="contained" disabled={newTermDraft.trim() === ''} onClick={submitNew}>
            Add
          </Button>
          <Button onClick={cancelAdd}>Cancel</Button>
        </Box>
      )}
    </Box>
  );
}
