'use server';

import { createClient } from '@supabase/supabase-js';

import { notifyWaitlist } from '@/lib/waitlistServer';
import type { Database } from '@/types/database';

interface WaitlistData {
  email: string;
  name: string;
  company_name: string;
  shop_size: string | null;
  source: string;
}

export async function submitWaitlist(data: WaitlistData) {
  const { email, name, company_name, shop_size, source } = data;

  if (!email || !name || !company_name) {
    return { error: 'Email, name, and company name are required' };
  }

  // Secret key client — bypasses RLS. Safe because this is a server action.
  // `<Database>` because the `no-restricted-imports` ratchet only ever guarded
  // imports from `@/lib/supabase`; a client built inline here escaped it entirely,
  // and this one writes to a real table with nothing checking the payload.
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  );

  // What this address signed up for before, if anything: it decides below whether to email.
  const { data: earlier, error: readError } = await supabase
    .from('waitlist')
    .select('source')
    .eq('email', email)
    .maybeSingle();
  if (readError) {
    console.error('Waitlist read error:', readError);
    return { error: 'Failed to submit' };
  }

  const { data: saved, error } = await supabase
    .from('waitlist')
    .upsert(
      {
        email,
        name,
        company_name,
        shop_size: shop_size || null,
        source: source || 'landing_page',
      },
      { onConflict: 'email' },
    )
    .select('email, name, company_name, shop_size, source, created_at')
    .single();

  if (error) {
    console.error('Waitlist insert error:', error);
    return { error: 'Failed to submit' };
  }

  // Email on a new sign-up, or one for something new (a landing-page sign-up joining the pilot).
  // Not on a repeat of the same sign-up: it was already answered, and this action is public, so
  // answering every repeat would let a script fill someone's inbox with confirmations.
  if (!earlier || earlier.source !== saved.source) await notifyWaitlist(saved);

  return { success: true };
}
