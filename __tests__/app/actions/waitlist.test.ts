/**
 * The waitlist server action (app/actions/waitlist.ts): it saves the sign-up and asks for its two
 * emails — but only for a sign-up that is new, or new in kind. The action is public, so answering
 * every identical repeat would let a script fill someone's inbox with confirmations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Result = { data: unknown; error: unknown };

let earlier: Result;
let saved: Result;
const upserts: unknown[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(earlier) }) }),
      upsert: (row: unknown) => {
        upserts.push(row);
        return { select: () => ({ single: () => Promise.resolve(saved) }) };
      },
    }),
  }),
}));

const notifyWaitlist = vi.fn();
vi.mock('@/lib/waitlistServer', () => ({ notifyWaitlist: (...args: unknown[]) => notifyWaitlist(...args) }));

import { submitWaitlist } from '@/app/actions/waitlist';

const INPUT = {
  email: 'owner@shop.example',
  name: 'Pat',
  company_name: 'Acme Machining',
  shop_size: null,
  source: 'showcase_pilot',
};

const SAVED_ROW = {
  email: INPUT.email,
  name: INPUT.name,
  company_name: INPUT.company_name,
  shop_size: null,
  source: 'showcase_pilot',
  created_at: '2026-11-09T19:12:23Z',
};

beforeEach(() => {
  upserts.length = 0;
  notifyWaitlist.mockReset();
  earlier = { data: null, error: null };
  saved = { data: SAVED_ROW, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('submitWaitlist', () => {
  it('saves a new sign-up and asks for its emails with the saved row', async () => {
    await expect(submitWaitlist(INPUT)).resolves.toEqual({ success: true });
    expect(upserts).toHaveLength(1);
    expect(notifyWaitlist).toHaveBeenCalledWith(SAVED_ROW);
  });

  it('emails again when the address signs up for something new', async () => {
    earlier = { data: { source: 'landing_hero' }, error: null };
    await submitWaitlist(INPUT);
    expect(notifyWaitlist).toHaveBeenCalledTimes(1);
  });

  it('does not email an identical repeat, but still saves it', async () => {
    earlier = { data: { source: 'showcase_pilot' }, error: null };
    await expect(submitWaitlist(INPUT)).resolves.toEqual({ success: true });
    expect(upserts).toHaveLength(1);
    expect(notifyWaitlist).not.toHaveBeenCalled();
  });

  it('reports a failed save and emails nothing', async () => {
    saved = { data: null, error: { message: 'boom' } };
    await expect(submitWaitlist(INPUT)).resolves.toEqual({ error: 'Failed to submit' });
    expect(notifyWaitlist).not.toHaveBeenCalled();
  });

  it('reports a failed read and saves nothing', async () => {
    earlier = { data: null, error: { message: 'boom' } };
    await expect(submitWaitlist(INPUT)).resolves.toEqual({ error: 'Failed to submit' });
    expect(upserts).toHaveLength(0);
    expect(notifyWaitlist).not.toHaveBeenCalled();
  });

  it('refuses a sign-up missing a required field', async () => {
    await expect(submitWaitlist({ ...INPUT, name: '' })).resolves.toEqual({
      error: 'Email, name, and company name are required',
    });
    expect(upserts).toHaveLength(0);
  });
});
