'use server';

import { createClient } from '@supabase/supabase-js';

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
  const supabase = createClient(
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
