/**
 * Which jobs a removal may be tagged to.
 *
 * The rule has a precise definition and it is worth pinning, because "expected" is exactly the kind
 * of word that drifts: a job is expected to consume a part when the part is **what the job makes**,
 * or a **direct child in the BOM** of something the job makes. One level, matching the decision the
 * material check already records — *"a pump job reads 'needs 1 pump core', not the aluminium inside
 * it"* — because two definitions of "what this job needs" is worse than one narrow one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const from = vi.fn();
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ from }) }));
vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: vi.fn() }));

import { loadJobsForPart, loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import { getAllJobs } from '@/utils/jobsAccess';

/** `parts_bom` → parents that consume the part; `job_parts` → jobs making those parts. */
const stubTables = (bomParents: string[], jobRows: Array<{ job_id: string }>) => {
  from.mockImplementation((table: string) => {
    if (table === 'parts_bom') {
      return {
        select: () => ({
          eq: async () => ({
            data: bomParents.map((parent_part_id) => ({ parent_part_id })),
            error: null,
          }),
        }),
      };
    }
    if (table === 'job_parts') {
      return {
        select: () => ({
          eq: () => ({ in: async () => ({ data: jobRows, error: null }) }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
};

const job = (id: string) => ({ id, job_number: `J-${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllJobs).mockResolvedValue({
    jobs: [job('a'), job('b'), job('c')],
  } as never);
});

describe('loadTaggableJobs', () => {
  /** You are tagging to whatever is moving through the shop now, not what opened in March. */
  it('asks for active jobs, most recently updated first', async () => {
    await loadTaggableJobs('co1');

    expect(getAllJobs).toHaveBeenCalledWith(
      'co1',
      expect.objectContaining({ productionStatus: expect.anything() }),
      'updated_at',
      'desc',
    );
  });

  it('returns nothing rather than throwing when the read fails', async () => {
    vi.mocked(getAllJobs).mockRejectedValue(new Error('network'));
    await expect(loadTaggableJobs('co1')).resolves.toEqual([]);
  });
});

describe('loadJobsForPart', () => {
  it('includes a job that MAKES the part', async () => {
    stubTables([], [{ job_id: 'a' }]);
    const jobs = await loadJobsForPart('co1', 'p-steel');
    expect(jobs.map((j) => j.id)).toEqual(['a']);
  });

  /** The material case: the job makes a pump core, and this part is in the pump core's BOM. */
  it('includes a job whose part consumes this one in its BOM', async () => {
    stubTables(['p-pumpcore'], [{ job_id: 'b' }]);
    const jobs = await loadJobsForPart('co1', 'p-steel');
    expect(jobs.map((j) => j.id)).toEqual(['b']);
  });

  it('leaves out jobs with no relationship to the part', async () => {
    stubTables([], [{ job_id: 'a' }]);
    const jobs = await loadJobsForPart('co1', 'p-steel');
    expect(jobs.map((j) => j.id)).not.toContain('c');
  });

  /** Order comes from the one loader that knows it; filtering must not reshuffle. */
  it('keeps most-recently-updated order', async () => {
    stubTables([], [{ job_id: 'c' }, { job_id: 'a' }]);
    const jobs = await loadJobsForPart('co1', 'p-steel');
    expect(jobs.map((j) => j.id)).toEqual(['a', 'c']);
  });

  /** No relationship at all is an empty EXPECTED set — the caller still offers every job. */
  it('returns nothing when no job could use the part', async () => {
    stubTables([], []);
    await expect(loadJobsForPart('co1', 'p-orphan')).resolves.toEqual([]);
  });

  /**
   * "COULDN'T CHECK" IS NEVER "DENIED" (CLAUDE.md).
   *
   * An empty array is a claim — "no job lists this part". A dropped query is not that claim, and
   * swallowing one into `[]` made the picker assert it about a network failure. It throws, and the
   * caller falls back to the unranked list.
   */
  it('throws on a failed read rather than reporting "none"', async () => {
    from.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(loadJobsForPart('co1', 'p-steel')).rejects.toThrow();
  });
});
