import { readFileSync } from 'fs';
import { join } from 'path';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Seed the clickwrap acceptances a user needs in order not to be gated.
 *
 * CALL THIS FOR EVERY USER A SPEC CREATES. `TermsGate` raises a focus-trapping
 * modal on the first non-exempt page a user without acceptances opens, and on
 * `/accept-invite` it also disables the Join button — so a spec that provisions
 * its own user and never calls this will hang on a click with no obvious cause.
 * That is exactly how `existing-user-second-company.spec.ts` broke when the gate
 * shipped.
 *
 * Lives here rather than inside `global-setup.ts` so a spec with its own
 * `beforeAll` can reuse it. Versions are read from the manifest rather than
 * hard-coded, so a version bump does not quietly gate every E2E run.
 */
export async function ensureTermsAccepted(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'public/legal/manifest.json'), 'utf-8'),
  ) as {
    documents: Record<string, { current: number; versions: { version: number; sha256: string }[] }>;
  };

  for (const [documentType, doc] of Object.entries(manifest.documents)) {
    const entry = doc.versions.find((v) => v.version === doc.current);
    if (!entry) continue;

    const { data: existing } = await supabase
      .from('terms_acceptances')
      .select('id')
      .eq('user_id', userId)
      .eq('document_type', documentType)
      .eq('version', entry.version)
      .limit(1);
    if (existing?.length) continue;

    const { error } = await supabase.from('terms_acceptances').insert({
      user_id: userId,
      document_type: documentType,
      version: entry.version,
      document_sha256: entry.sha256,
      accepted_via: 'invite_accept',
      ip_source: 'unavailable',
    });
    if (error) throw new Error(`terms_acceptances insert failed: ${error.message}`);
  }
}
