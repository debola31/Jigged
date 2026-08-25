/**
 * The client-side deadline table.
 *
 * Every row here answers "the job has not finished — is that fine, or is it
 * broken?", and the client has to answer it WITHOUT trusting the stored status,
 * because two of the cases are ones no server-side sweep will reach in time.
 *
 * The one that matters most is a serverless-killed inline job. Its row sits
 * `running` forever: sweep_ai_jobs() is SECURITY INVOKER, so the desktop worker's
 * copy is scoped by RLS to executor='worker' and cannot see it, and the person
 * staring at the spinner is by definition not enqueueing anything to trigger the
 * service-role sweep. Rule 2 is the only thing that ends that wait.
 */
import { describe, expect, it } from 'vitest';

import { INTERACTIVE_WALL_MS, verdictFor } from '../../hooks/useAiJob';
import type { AiJob } from '../../utils/insightsAccess';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function job(over: Partial<AiJob> = {}): AiJob {
  return {
    id: 'job-1',
    status: 'queued',
    executor: 'worker',
    model: 'qwen3:8b',
    result: null,
    error: null,
    error_kind: null,
    created_at: iso(-2_000),
    expires_at: null,
    lease_expires_at: null,
    batch_key: null,
    ...over,
  };
}

const opts = (over: Partial<Parameters<typeof verdictFor>[1]> = {}) => ({
  startedAtMs: NOW - 5_000,
  nowMs: NOW,
  wallMs: INTERACTIVE_WALL_MS,
  workerLive: null,
  ...over,
});

describe('verdictFor', () => {
  it('a job that has not been read yet is pending, not failed', () => {
    expect(verdictFor(null, opts()).phase).toBe('pending');
  });

  it('a succeeded job is done', () => {
    expect(verdictFor(job({ status: 'succeeded' }), opts()).phase).toBe('done');
  });

  it('reads the server’s own offline verdict rather than second-guessing it', () => {
    const v = verdictFor(
      job({ status: 'failed', error_kind: 'ai_offline', error: 'no worker' }),
      opts(),
    );
    expect(v.phase).toBe('offline');
    expect(v.message).toMatch(/still works/);
  });

  it('a provider failure is failed, not offline', () => {
    expect(
      verdictFor(job({ status: 'failed', error_kind: 'provider', error: '500' }), opts()).phase,
    ).toBe('failed');
  });

  describe('a queued job that is simply waiting', () => {
    it('stays pending however long the queue is, while a worker is alive', () => {
      // Twenty minutes behind a busy batch. This is the client-side half of the
      // regression a fixed server-side TTL caused: "queued too long" is not a
      // failure, and showing "offline" while the box is visibly working is the
      // worst possible answer.
      const v = verdictFor(job({ created_at: iso(-20 * 60_000) }), opts({ workerLive: true }));
      expect(v.phase).toBe('pending');
    });

    it('goes offline once no live worker serves its model', () => {
      const v = verdictFor(job({ created_at: iso(-5 * 60_000) }), opts({ workerLive: false }));
      expect(v.phase).toBe('offline');
    });

    it('is left alone inside one heartbeat window even with no worker', () => {
      // A worker restarting between beats must not kill the question somebody
      // just asked.
      const v = verdictFor(job({ created_at: iso(-5_000) }), opts({ workerLive: false }));
      expect(v.phase).toBe('pending');
    });
  });

  describe('backend rows use their own clock, never the heartbeat', () => {
    it('a queued inline job is NOT offline just because no worker exists', () => {
      // THE BUG THIS ROW PREVENTS: a backend job's model is a hosted one that no
      // worker will ever advertise, so an unscoped heartbeat rule would render
      // every unmigrated surface offline the moment it passed 60 seconds -- and
      // unmigrated is the default state of every surface today.
      const v = verdictFor(
        job({
          executor: 'backend',
          model: 'claude-sonnet-4-6',
          created_at: iso(-5 * 60_000),
          expires_at: iso(60_000),
        }),
        opts({ workerLive: false }),
      );
      expect(v.phase).toBe('pending');
    });

    it('fails once its own deadline passes', () => {
      const v = verdictFor(
        job({ executor: 'backend', model: 'claude-sonnet-4-6', expires_at: iso(-1_000) }),
        opts(),
      );
      expect(v.phase).toBe('failed');
    });
  });

  describe('an in-flight job whose lease has gone stale', () => {
    it.each(['claimed', 'running'])('%s past its lease reads as offline', (status) => {
      const v = verdictFor(job({ status, lease_expires_at: iso(-1_000) }), opts());
      expect(v.phase).toBe('offline');
    });

    it('a serverless-killed inline job is caught by the same rule', () => {
      // Nothing server-side will collect this while the tab is the only watcher.
      const v = verdictFor(
        job({
          executor: 'backend',
          model: 'claude-sonnet-4-6',
          status: 'running',
          expires_at: iso(-60_000),
          lease_expires_at: iso(-1_000),
        }),
        opts(),
      );
      expect(v.phase).toBe('offline');
    });

    it('a live lease keeps it pending', () => {
      expect(
        verdictFor(job({ status: 'running', lease_expires_at: iso(120_000) }), opts()).phase,
      ).toBe('pending');
    });
  });

  describe('the wall', () => {
    it('renders a failure rather than stopping silently', () => {
      // A poller that reaches its limit and just stops is a spinner that never
      // resolves, which is worse than an error message.
      const v = verdictFor(
        job({ status: 'running', lease_expires_at: iso(60_000) }),
        opts({ startedAtMs: NOW - INTERACTIVE_WALL_MS - 1 }),
      );
      expect(v.phase).toBe('failed');
      expect(v.message).toBeTruthy();
    });

    it('does not fire early', () => {
      const v = verdictFor(
        job({ status: 'running', lease_expires_at: iso(60_000) }),
        opts({ startedAtMs: NOW - INTERACTIVE_WALL_MS + 1_000 }),
      );
      expect(v.phase).toBe('pending');
    });

    it('a batch wall derived from page_count outlives the interactive one', () => {
      // 60 pages at ~90s each. A fixed 15 minutes would report failure for the
      // back half of a maximum-legal package while it sat healthy and queued.
      const batchWall = 60 * 90_000 + 5 * 60_000;
      expect(batchWall).toBeGreaterThan(INTERACTIVE_WALL_MS);
      const v = verdictFor(
        job({ status: 'running', lease_expires_at: iso(60_000) }),
        opts({ startedAtMs: NOW - 20 * 60_000, wallMs: batchWall }),
      );
      expect(v.phase).toBe('pending');
    });
  });

  it('never puts a provider name in front of a user', () => {
    // A machinist should not read "DeepInfra 429". Vendor detail goes to the log
    // and to Sentry; the browser gets a sentence about their shop.
    const cases: AiJob[] = [
      job({ status: 'failed', error_kind: 'provider', error: 'anthropic returned 500' }),
      job({ status: 'timed_out', error_kind: 'ai_offline', error: 'ollama did not answer' }),
      job({ status: 'running', lease_expires_at: iso(-1) }),
    ];
    for (const j of cases) {
      const message = verdictFor(j, opts()).message ?? '';
      for (const vendor of ['anthropic', 'ollama', 'deepinfra', 'qwen', 'claude']) {
        expect(message.toLowerCase()).not.toContain(vendor);
      }
    }
  });
});
