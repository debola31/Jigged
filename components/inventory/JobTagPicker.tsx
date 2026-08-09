'use client';

/**
 * "Tag this removal to a job" — the picker behind issue #59.
 *
 * Extracted because it now appears in three places: the operator's bin modal, the owner's
 * part-level transaction modal, and the owner's location modal. It was written once for the
 * operator path; #59 regressed precisely because the owner-side copy was rewritten without it
 * during the May parts unification, and there was nothing shared to notice the omission.
 *
 * The parent owns loading and calls `loadTaggableJobs` from its dialog's `onEnter` — the house
 * convention for modal setup, which avoids the set-state-in-effect lint rule. This component
 * is the markup only.
 *
 * A job tag is always OPTIONAL and must never block the write: `loadTaggableJobs` returns an
 * empty list on failure rather than throwing, so a jobs query that fails still lets the
 * operator record the stock movement that physically happened.
 */
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { getAllJobs } from '@/utils/jobsAccess';
import type { JobWithRelations, ProductionStatus } from '@/types/job';

/** Jobs that could still be consuming material. */
const ACTIVE_STATUSES: ProductionStatus[] = ['not_started', 'in_progress'];

/** "Part A, Part B" — disambiguates look-alike job numbers. */
export const jobPartsLabel = (j: JobWithRelations): string =>
  (j.job_parts ?? [])
    .map((jp) => jp.parts?.part_name)
    .filter((n): n is string => Boolean(n))
    .join(', ');

/**
 * Active jobs for the picker. Never throws — the tag is optional.
 *
 * Takes just the rows off the page envelope: this never searches, so nothing
 * is capped and there is no truncation for the caller to report.
 */
export async function loadTaggableJobs(companyId: string): Promise<JobWithRelations[]> {
  try {
    return (await getAllJobs(companyId, { productionStatus: ACTIVE_STATUSES })).jobs;
  } catch {
    return [];
  }
}

interface JobTagPickerProps {
  jobs: JobWithRelations[];
  loading: boolean;
  value: JobWithRelations | null;
  onChange: (job: JobWithRelations | null) => void;
  label?: string;
}

export default function JobTagPicker({
  jobs,
  loading,
  value,
  onChange,
  label = 'Tag to a job (optional)',
}: JobTagPickerProps) {
  return (
    <Autocomplete
      options={jobs}
      loading={loading}
      value={value}
      onChange={(_, v) => onChange(v)}
      getOptionLabel={(j) => j.job_number}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      renderOption={(props, j) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={key} {...rest}>
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography variant="body2">{j.job_number}</Typography>
              {jobPartsLabel(j) && (
                <Typography variant="caption" color="text.secondary">
                  {jobPartsLabel(j)}
                </Typography>
              )}
            </Box>
          </Box>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} />}
      noOptionsText="No active jobs"
      loadingText="Loading jobs…"
    />
  );
}
