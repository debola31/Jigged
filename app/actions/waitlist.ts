'use server';

import { createClient } from '@supabase/supabase-js';

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

  const { error } = await supabase.from('waitlist').upsert(
    {
      email,
      name,
      company_name,
      shop_size: shop_size || null,
      source: source || 'landing_page',
    },
    { onConflict: 'email' },
  );

  if (error) {
    console.error('Waitlist insert error:', error);
    return { error: 'Failed to submit' };
  }

  return { success: true };
}
