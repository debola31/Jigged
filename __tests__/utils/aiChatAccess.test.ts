/**
 * The conversation access layer: what each read asks for and how a row is
 * narrowed. The browser creates threads and reads messages; it never writes a
 * message, and nothing here has an insert for one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function buildQueryStub(initial?: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'order', 'limit', 'single'].forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = initial?.data ?? null;
  builder.error = initial?.error ?? null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & { data: unknown; error: unknown };
}

const { mockSupabase, queueBuilders } = vi.hoisted(() => {
  let queue: ReturnType<typeof Object>[] = [];
  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) throw new Error('queueBuilders: ran out of stubbed builders');
      return next;
    }),
  };
  return {
    mockSupabase: supabase,
    queueBuilders: (b: ReturnType<typeof Object>[]) => {
      queue = b;
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

import {
  archiveThread,
  createThread,
  listThreadMessages,
  listThreads,
  THREAD_TITLE_MAX,
  threadTitleFrom,
} from '@/utils/aiChatAccess';

beforeEach(() => vi.clearAllMocks());

describe('threadTitleFrom', () => {
  it('keeps a short question as it is', () => {
    expect(threadTitleFrom('  How many jobs   are late? ')).toBe('How many jobs are late?');
  });

  it('cuts a long question to the title column with an ellipsis', () => {
    const title = threadTitleFrom('x'.repeat(200));
    expect(title.length).toBe(THREAD_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('createThread', () => {
  it('inserts under RLS and lets created_by default from auth.uid()', async () => {
    const q = buildQueryStub({
      data: { id: 't-1', title: 'How many jobs are late?', created_at: 'c', updated_at: 'u' },
    });
    queueBuilders([q]);

    const thread = await createThread('co-1', 'How many jobs are late?');

    expect(mockSupabase.from).toHaveBeenCalledWith('ai_chat_threads');
    const inserted = q.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toEqual({ company_id: 'co-1', title: 'How many jobs are late?' });
    expect('created_by' in inserted).toBe(false);
    expect(thread.id).toBe('t-1');
  });

  it('surfaces a refused insert as an error, never a silent null', async () => {
    queueBuilders([buildQueryStub({ error: { message: 'permission denied' } })]);
    await expect(createThread('co-1', 'q')).rejects.toThrow(/permission denied/);
  });
});

describe('listThreads', () => {
  it('lists live threads for the shop, most recently active first', async () => {
    const q = buildQueryStub({ data: [{ id: 't-1', title: 'a', created_at: 'c', updated_at: 'u' }] });
    queueBuilders([q]);

    const threads = await listThreads('co-1');

    expect(q.eq).toHaveBeenCalledWith('company_id', 'co-1');
    expect(q.is).toHaveBeenCalledWith('deleted_at', null);
    expect(q.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(q.limit).toHaveBeenCalledWith(10);
    expect(threads).toHaveLength(1);
  });
});

describe('archiveThread', () => {
  it('sets deleted_at rather than deleting', async () => {
    const q = buildQueryStub();
    queueBuilders([q]);

    await archiveThread('t-1');

    expect(q.delete).not.toHaveBeenCalled();
    const patch = q.update.mock.calls[0][0] as { deleted_at: string };
    expect(patch.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(q.eq).toHaveBeenCalledWith('id', 't-1');
  });
});

describe('listThreadMessages', () => {
  const chart = { chart_type: 'bar', data: [{ c: 'A', v: 1 }], x_key: 'c', y_key: 'v' };

  it('reads user and assistant rows in seq order and narrows the chart', async () => {
    const q = buildQueryStub({
      data: [
        { id: 'm1', seq: 1, role: 'user', content: 'q', chart_config: null, created_at: 'c1' },
        { id: 'm2', seq: 2, role: 'assistant', content: 'a', chart_config: chart, created_at: 'c2' },
      ],
    });
    queueBuilders([q]);

    const messages = await listThreadMessages('t-1');

    expect(q.eq).toHaveBeenCalledWith('thread_id', 't-1');
    expect(q.in).toHaveBeenCalledWith('role', ['user', 'assistant']);
    expect(q.order).toHaveBeenCalledWith('seq', { ascending: true });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].chart_config).toEqual(chart);
  });

  it('drops a chart that no longer has the shape the renderer needs', async () => {
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 'm2', seq: 2, role: 'assistant', content: 'a', chart_config: { chart_type: 'bar' }, created_at: 'c' },
        ],
      }),
    ]);
    const [m] = await listThreadMessages('t-1');
    expect(m.chart_config).toBeNull();
  });

  it('drops a role the CHECK does not know about rather than rendering it', async () => {
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 'm1', seq: 1, role: 'user', content: 'q', chart_config: null, created_at: 'c' },
          { id: 'm9', seq: 9, role: 'system', content: 'x', chart_config: null, created_at: 'c' },
        ],
      }),
    ]);
    const messages = await listThreadMessages('t-1');
    expect(messages).toHaveLength(1);
  });
});
