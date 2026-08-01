import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as jobNoteMediaAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'eq', 'is', 'order', 'single', 'maybeSingle'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  return {
    mockQueryBuilder: builder,
    mockSupabase: { from: vi.fn().mockImplementation(() => builder) },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

vi.mock('@/lib/supabaseErrors', () => ({
  friendlyErrorMessage: (_err: unknown, opts?: { fallback?: string }) => opts?.fallback ?? 'error',
}));

const { mockAddNoteMedia } = vi.hoisted(() => ({ mockAddNoteMedia: vi.fn() }));
vi.mock('@/utils/jobNoteMediaAccess', () => ({
  addNoteMedia: (...a: unknown[]) => mockAddNoteMedia(...a),
}));

import {
  addMachineNote,
  addMachineNoteMedia,
  deriveOpenItems,
  getMachineLog,
} from '@/utils/machineMaintenanceAccess';
import type { MachineNote } from '@/types/machineMaintenance';

function note(over: Partial<MachineNote> & { id: string }): MachineNote {
  return {
    work_center_id: 'wc1',
    body: 'something',
    maintenance_kind: null,
    resolves_note_id: null,
    created_at: '2026-07-01T00:00:00Z',
    author_name: 'Kurtis',
    author_id: 'acc-1',
    viewer_count: 0,
    media: [],
    reactions: [],
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    work_center_id: 'wc1',
    body: 'Way cover drags.',
    maintenance_kind: 'noticed',
    resolves_note_id: null,
    created_at: '2026-07-01T00:00:00Z',
    edited_at: null,
    viewer_count: 3,
    author_id: 'acc-1',
    author: { name: 'Kurtis' },
    reactions: [],
    media: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
});

// The module stores no "open" flag. This is the whole of the logic that replaces
// one, so it carries the weight the schema deliberately does not.
describe('deriveOpenItems', () => {
  it('treats a noticed entry with nothing resolving it as open', () => {
    const entries = [note({ id: 'a', maintenance_kind: 'noticed' })];
    expect(deriveOpenItems(entries).map((e) => e.id)).toEqual(['a']);
  });

  it('closes it as soon as an entry in the same array resolves it', () => {
    const entries = [
      note({ id: 'fix', maintenance_kind: 'repaired', resolves_note_id: 'a' }),
      note({ id: 'a', maintenance_kind: 'noticed' }),
    ];
    expect(deriveOpenItems(entries)).toEqual([]);
  });

  it('re-opens it when the fix is removed — nothing was stored to go stale', () => {
    const withFix = [
      note({ id: 'fix', resolves_note_id: 'a' }),
      note({ id: 'a', maintenance_kind: 'noticed' }),
    ];
    expect(deriveOpenItems(withFix)).toEqual([]);
    expect(deriveOpenItems(withFix.filter((e) => e.id !== 'fix')).map((e) => e.id)).toEqual(['a']);
  });

  it('never opens an entry that was not a noticed one', () => {
    // Only an observation can be outstanding. "Cleaned the chip conveyor"
    // describes something already done and has nothing to close.
    const entries = [
      note({ id: 'a', maintenance_kind: 'cleaned' }),
      note({ id: 'b', maintenance_kind: null }),
      note({ id: 'c', maintenance_kind: 'repaired' }),
    ];
    expect(deriveOpenItems(entries)).toEqual([]);
  });

  it('resolves each observation independently', () => {
    const entries = [
      note({ id: 'fix-b', resolves_note_id: 'b' }),
      note({ id: 'a', maintenance_kind: 'noticed' }),
      note({ id: 'b', maintenance_kind: 'noticed' }),
    ];
    expect(deriveOpenItems(entries).map((e) => e.id)).toEqual(['a']);
  });
});

describe('getMachineLog', () => {
  it('scopes to the company and the machine, newest first', async () => {
    mockQueryBuilder.data = [row()];
    await getMachineLog('wc1', 'c1');

    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('work_center_id', 'wc1');
    expect(mockQueryBuilder.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('never asks for usage_count', async () => {
    // It counts distinct JOBS a note was consulted on, and a machine read has no
    // job, so it is permanently zero here and must never be displayed (§8). Not
    // fetching it is stronger than remembering not to render it.
    mockQueryBuilder.data = [row()];
    await getMachineLog('wc1', 'c1');

    const selectArg = (mockQueryBuilder.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(selectArg).not.toContain('usage_count');
    expect(selectArg).toContain('viewer_count');
  });

  it('returns the open items drawn from the very same array as the timeline', async () => {
    mockQueryBuilder.data = [
      row({ id: 'fix', maintenance_kind: 'repaired', resolves_note_id: 'obs' }),
      row({ id: 'obs', maintenance_kind: 'noticed' }),
      row({ id: 'other', maintenance_kind: 'noticed', resolves_note_id: null }),
    ];

    const log = await getMachineLog('wc1', 'c1');

    expect(log.entries.map((e) => e.id)).toEqual(['fix', 'obs', 'other']);
    expect(log.open.map((e) => e.id)).toEqual(['other']);
    // Identity, not a copy: they cannot drift because they are the same objects.
    expect(log.entries).toContain(log.open[0]);
  });

  it('drops a maintenance_kind it does not recognise rather than trusting it', async () => {
    mockQueryBuilder.data = [row({ maintenance_kind: 'lubricated' })];
    const log = await getMachineLog('wc1', 'c1');
    expect(log.entries[0].maintenance_kind).toBeNull();
  });

  it('surfaces a query failure instead of showing an empty machine', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    await expect(getMachineLog('wc1', 'c1')).rejects.toThrow('boom');
  });
});

describe('edited entries (#628)', () => {
  it('carries edited_at through to the mapped entry', async () => {
    mockQueryBuilder.data = [row({ edited_at: '2026-08-01T09:00:00Z' })];
    const log = await getMachineLog('wc1', 'c1');
    expect(log.entries[0].edited_at).toBe('2026-08-01T09:00:00Z');
  });

  it('leaves edited_at null on an entry nobody has corrected', async () => {
    mockQueryBuilder.data = [row()];
    const log = await getMachineLog('wc1', 'c1');
    expect(log.entries[0].edited_at).toBeNull();
  });

  // The delete-a-resolver case — an item returning to "Needs attention" — is
  // already covered by deriveOpenItems' "re-opens it when the fix is removed",
  // which is that behaviour as pure logic. Not duplicated here.
});

describe('addMachineNote', () => {
  it('writes a work-center-subject row and no other subject', async () => {
    mockQueryBuilder.data = row();
    await addMachineNote('wc1', 'c1', 'acc-1', 'Topped up the way lube.');

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        subject_kind: 'work_center',
        work_center_id: 'wc1',
        author_id: 'acc-1',
        body: 'Topped up the way lube.',
        note_type: 'user',
      }),
    );
    const written = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written).not.toHaveProperty('job_id');
    expect(written).not.toHaveProperty('part_id');
  });

  it('leaves the kind null when the operator did not choose one', async () => {
    mockQueryBuilder.data = row();
    await addMachineNote('wc1', 'c1', 'acc-1', 'x');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ maintenance_kind: null, resolves_note_id: null }),
    );
  });

  it('carries the kind and the resolution link when they are given', async () => {
    mockQueryBuilder.data = row();
    await addMachineNote('wc1', 'c1', 'acc-1', 'Replaced the wiper.', {
      maintenanceKind: 'repaired',
      resolvesNoteId: 'obs-1',
    });
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ maintenance_kind: 'repaired', resolves_note_id: 'obs-1' }),
    );
  });

  it('writes null rather than whitespace for a photo-only entry', async () => {
    mockQueryBuilder.data = row({ body: null });
    await addMachineNote('wc1', 'c1', 'acc-1', '   ');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ body: null }),
    );
  });

  it('surfaces a friendly message when the write is refused', async () => {
    mockQueryBuilder.error = { code: '42501', message: 'permission denied' };
    await expect(addMachineNote('wc1', 'c1', 'acc-1', 'x')).rejects.toThrow('Could not save that.');
  });
});

describe('addMachineNoteMedia', () => {
  it('files the photo under the machine, since a machine entry has no job', async () => {
    await addMachineNoteMedia('c1', 'wc1', 'n1', new File(['x'], 'p.jpg'), {
      dims: { width: 100, height: 80 },
    });

    expect(mockAddNoteMedia).toHaveBeenCalledWith('c1', 'n1', expect.any(File), {
      folder: { entityType: 'work-centers', entityId: 'wc1' },
      dims: { width: 100, height: 80 },
    });
  });
});
