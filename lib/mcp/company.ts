import type { McpCaller } from '@/lib/mcp/auth';
import { isOfficeRole, type OfficeRole } from '@/lib/mcp/roles';
import { getSupabase } from '@/lib/supabase';
import { syncDemoAccess } from '@/utils/demoAccess';

/**
 * Which company an assistant's call acts in, and whether this person may act there from an
 * assistant at all. Runs inside `runAsCaller`, so every read here is the caller's own, under RLS.
 *
 * A DEMO RESOLVES THROUGH ITS REAL COMPANY. A demo is listed under its company
 * (`list_my_companies`) and offered to the same people, so the real company's membership and role
 * govern it. Reading them from the demo instead would let a stale mirror decide: a person demoted
 * to operator would keep working in the demo until somebody next opened it in the app.
 */

export interface CompanyInScope {
  /** The id the call acts on: the real company's, or its demo's. */
  id: string;
  /** The name to show the person. A demo reads "<company> (demo)". */
  name: string;
  role: OfficeRole;
  isDemo: boolean;
  /** The real company: the call's own, or the company the demo stands in for. */
  governingCompanyId: string;
}

export type CompanyResolution = { ok: true; company: CompanyInScope } | { ok: false; message: string };

export const COMPANY_NOT_FOUND =
  "You don't have access to a Jigged company with that id. list_my_companies lists the ones you can use.";

export async function resolveCompany(caller: McpCaller, companyId: string): Promise<CompanyResolution> {
  const supabase = getSupabase();

  // Is this a demo? `companies.demo_company_id` points from the real company to its demo, and RLS
  // shows a company only to its members, so this finds the source only for someone in it.
  const { data: source, error: sourceError } = await supabase
    .from('companies')
    .select('id')
    .eq('demo_company_id', companyId)
    .maybeSingle();
  if (sourceError) throw sourceError;
  const governingId = source?.id ?? companyId;

  const { data: access, error } = await supabase
    .from('user_company_access')
    .select('role, companies ( id, name, is_demo )')
    .eq('user_id', caller.userId)
    .eq('company_id', governingId)
    .maybeSingle();
  if (error) throw error;

  const company = access?.companies;
  // A demo id with no visible source lands here as a demo row: membership left behind in a demo
  // after leaving its company is not access.
  if (!access || !company || company.is_demo) return { ok: false, message: COMPANY_NOT_FOUND };

  if (!isOfficeRole(access.role)) {
    return {
      ok: false,
      message:
        `You're an operator in ${company.name}, and operator logins can't use Jigged from an ` +
        'assistant. An admin can give you an office role under Team in Jigged.',
    };
  }

  if (source) await ensureDemoMembership(caller, source.id, companyId);

  return {
    ok: true,
    company: {
      id: companyId,
      name: source ? `${company.name} (demo)` : company.name,
      role: access.role,
      isDemo: Boolean(source),
      governingCompanyId: governingId,
    },
  };
}

/**
 * RLS on a demo's rows needs the caller's own membership row in the demo. The app mirrors it on
 * entry (`sync_demo_access`); someone who joined the company after its demo was made, and never
 * opened it in the app, has none yet. Same call, same convergence.
 */
async function ensureDemoMembership(caller: McpCaller, sourceId: string, demoId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from('user_company_access')
    .select('id')
    .eq('user_id', caller.userId)
    .eq('company_id', demoId)
    .maybeSingle();
  if (error) throw error;
  if (!data) await syncDemoAccess(sourceId, demoId);
}
