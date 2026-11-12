'use client';

import { useEffect, useState } from 'react';

import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import { getWorkCentersFlat } from '@/utils/workCentersAccess';

export interface MachinePickerProps {
  companyId: string;
  value: string | null;
  onChange: (workCenterId: string | null) => void;
  disabled?: boolean;
}

/**
 * The machine an Other line is for — a spindle rebuild, a service call, tooling for one station
 * (plan §3.2 "Purchase order lines", `work_center_id`). Optional, and only live work centres: an
 * archived machine is not something new money is spent on.
 */
export default function MachinePicker({ companyId, value, onChange, disabled = false }: MachinePickerProps) {
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getWorkCentersFlat(companyId)
      .then((rows) => {
        if (!cancelled) setOptions(rows.map((w) => ({ id: w.id, label: w.name })));
      })
      // Optional field: a failed read costs the suggestions, never the line.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  return (
    <SearchableSelect
      options={options}
      value={value ?? ''}
      onChange={(id) => onChange(id || null)}
      label="For machine (optional)"
      allowNone
      noneLabel="No machine"
      size="small"
      loading={loading}
      disabled={disabled}
    />
  );
}
