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
import { getSupabase } from '@/lib/supabase';
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
/**
 * The active jobs, most recently touched first.
 *
 * `updated_at` rather than `created_at`: you are tagging material to whatever is moving through the
 * shop right now, and the job you touched an hour ago is far likelier than one opened in March.
 */
export async function loadTaggableJobs(companyId: string): Promise<JobWithRelations[]> {
  try {
    return (
      await getAllJobs(companyId, { productionStatus: ACTIVE_STATUSES }, 'updated_at', 'desc')
    ).jobs;
  } catch {
    return [];
  }
}

/**
 * The active jobs that this part could plausibly have gone to.
 *
 * ## What "could" means, and why it stops at one level
 *
 * A job is expected to consume a part when the part is either **what the job makes**
 * (`job_parts.part_id`) or a **direct child in the bill of materials** of something the job makes
 * (`parts_bom.child_part_id`).
 *
 * One level, matching the decision the material check already records: *"A pump job reads 'needs 1
 * pump core', not the aluminium inside it."* Going deeper here would disagree with what the rest of
 * the product calls a job's materials, and two definitions of "what this job needs" is worse than
 * one that is narrow and stated.
 *
 * Material genuinely consumed outside this set is a real thing — a substitution at the machine, a
 * BOM nobody built, a level further down. That is not this function's problem to solve: it returns
 * what the data expects, and the caller offers a way past it.
 */
export async function loadJobsForPart(
  companyId: string,
  partId: string,
): Promise<JobWithRelations[]> {
  try {
    const supabase = getSupabase();

    // The parts whose BOM names this one as a child — i.e. things that consume it directly.
    const { data: parents, error: bomError } = await supabase
      .from('parts_bom')
      .select('parent_part_id')
      .eq('child_part_id', partId);
    if (bomError) throw bomError;

    const consumingPartIds = Array.from(
      new Set([partId, ...(parents ?? []).map((r) => r.parent_part_id)]),
    );

    const { data: jobParts, error: jpError } = await supabase
      .from('job_parts')
      .select('job_id')
      .eq('company_id', companyId)
      .in('part_id', consumingPartIds);
    if (jpError) throw jpError;

    const jobIds = Array.from(new Set((jobParts ?? []).map((r) => r.job_id)));
    if (jobIds.length === 0) return [];

    // Filtered in memory rather than by another `in()`: the active-job set is small, this reuses
    // the one loader that knows how to build a `JobWithRelations`, and it keeps the ordering rule
    // in exactly one place.
    const all = await loadTaggableJobs(companyId);
    const wanted = new Set(jobIds);
    return all.filter((j) => wanted.has(j.id));
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
  /** Why this list is the length it is — said, so a short list does not read as a broken one. */
  helperText?: string;
}

export default function JobTagPicker({
  jobs,
  loading,
  value,
  onChange,
  helperText,
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
      renderInput={(params) => (
        <TextField {...params} label={label} helperText={helperText} />
      )}
      /* The list is filtered to the parts being removed, so "none" means "none that use this" —
         not "no jobs". Saying the wrong one would send someone looking for a job that is open. */
      noOptionsText="No active job uses this part"
      loadingText="Loading jobs…"
    />
  );
}
