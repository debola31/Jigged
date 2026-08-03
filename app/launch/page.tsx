import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { homePathForRole } from '@/utils/companyAccess';

/**
 * The manifest's `start_url` — where a home-screen icon lands.
 *
 * ## Why this route exists
 *
 * `start_url` used to be `/`, which is the marketing landing page. iOS honours the
 * manifest's `start_url` over whichever page the user was on when they tapped Add to
 * Home Screen, so *every* installed icon opened marketing — including the ones added
 * from the shop-floor view on purpose. For a signed-in visitor that page renders
 * `null` while a `useEffect` resolves the destination, so the sequence was: blank
 * screen, then four sequential Supabase round trips (`getPostLoginRoute` →
 * `getUserCompanies` → `verifyCompanyAccess` → `getUserRole`) before anything painted.
 * On a phone on shop wifi that is the slowest path in the product, handed to the one
 * user who most needs the fastest.
 *
 * Resolving it here instead means the redirect is decided from the session cookie
 * *before the first byte of HTML*, so there is no blank frame and no client round
 * trip. That is the whole point, and it is why this is a Server Component rather than
 * a page with an effect.
 *
 * ## Why it does not look at the device
 *
 * A pre-paint server decision cannot see viewport width, and that is a feature rather
 * than a limitation. The tempting rule — "phone means shop floor" — is wrong for the
 * salesperson on a 390px phone at a trade show who needs quotes, and unknowable for
 * iPadOS (desktop UA) or a folding phone. Role is the only signal that is actually
 * about the person, so role is what this uses; the visible **Shop floor** control in
 * the sidebar and header covers the rest.
 *
 * Deliberately no `setLastCompany` write: this is a router and every extra query is
 * paid before first paint. `AuthGuard` already records it on arrival.
 */
export default async function Launch() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data, error } = await supabase
    .from('user_company_access')
    .select('company_id, role, companies(is_demo)')
    .eq('user_id', user.id);

  // Couldn't read the membership — that is not the same as "no access", so don't
  // send anyone to /no-access over it. Fall through to `/`, which resolves the same
  // decision on the client with its own retry path. Slower, but it was the behaviour
  // before this route existed, so a blip degrades to the old path rather than to a
  // wrong answer.
  if (error) {
    redirect('/');
  }

  // Demo companies never appear in company lists (mirrors `getUserCompanies`).
  const companies = (data ?? []).filter((c) => !c.companies?.is_demo);

  if (companies.length === 0) {
    redirect('/no-access');
  }

  if (companies.length === 1) {
    redirect(homePathForRole(companies[0].role, companies[0].company_id));
  }

  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('last_company_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const last = companies.find((c) => c.company_id === prefs?.last_company_id);
  if (last) {
    redirect(homePathForRole(last.role, last.company_id));
  }

  redirect('/select-company');
}
